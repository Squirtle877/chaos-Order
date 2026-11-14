import { getColor, getDefaultApplicationQuestions } from '../../config/bot.js';
import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, withErrorHandling, createError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import ApplicationService from '../../services/applicationService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logEvent, EVENT_TYPES, resolveApplicationLogChannel } from '../../services/loggingService.js';
import { formatLogLine, resolveUserAuthor } from '../../utils/logging/logEmbeds.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { 
    getApplicationSettings, 
    getUserApplications, 
    createApplication, 
    getApplication,
    getApplicationRoles,
    updateApplication,
    getApplicationRoleSettings
} from '../../utils/database.js';

const QUESTIONS_PER_MODAL = 5;
const DRAFT_TTL_MS = 15 * 60 * 1000;
const pendingDrafts = new Map(); // `${guildId}:${userId}:${roleId}` -> { answers, expires }

async function resolveQuestions(client, guildId, roleId, settings) {
    let questions = settings.questions?.length ? settings.questions : getDefaultApplicationQuestions();
    const roleSettings = await getApplicationRoleSettings(client, guildId, roleId);
    if (roleSettings.questions && roleSettings.questions.length > 0) {
        questions = roleSettings.questions;
    }
    return questions;
}

function getApplicationStatusPresentation(statusValue) {
    const normalized = typeof statusValue === 'string' ? statusValue.trim().toLowerCase() : 'unknown';
    const statusLabel =
        normalized === 'pending' ? 'In Progress' :
        normalized === 'approved' ? 'Accepted' :
        normalized === 'denied' ? 'Denied' :
        'Unknown';
    const statusEmoji =
        normalized === 'pending' ? '🟡' :
        normalized === 'approved' ? '🟢' :
        normalized === 'denied' ? '🔴' :
        '⚪';

    return { normalized, statusLabel, statusEmoji };
}

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName("apply")
        .setDescription("Manage role applications")
        .addSubcommand((subcommand) =>
            subcommand
                .setName("submit")
                .setDescription("Submit an application for a role")
                .addStringOption((option) =>
                    option
                        .setName("application")
                        .setDescription("The application you want to submit")
                        .setRequired(true)
                        .setAutocomplete(true),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("status")
                .setDescription("Check the status of your application")
                .addStringOption((option) =>
                    option
                        .setName("id")
                        .setDescription("Application ID (leave empty to see all)")
                        .setRequired(false),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("list")
                .setDescription("List available applications to apply for"),
        ),

    category: "Community",

    execute: withErrorHandling(async (interaction) => {
        if (!interaction.inGuild()) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This command can only be used in a server.' });
        }

        const { options, guild, member } = interaction;
        const subcommand = options.getSubcommand();

        if (subcommand !== "submit") {
            const isListCommand = subcommand === "list";
            await InteractionHelper.safeDefer(interaction, { flags: isListCommand ? [] : ["Ephemeral"] });
        }

        logger.info(`Apply command executed: ${subcommand}`, {
            userId: interaction.user.id,
            guildId: guild.id,
            subcommand
        });

        const settings = await getApplicationSettings(
            interaction.client,
            guild.id,
        );
        
        if (!settings.enabled) {
            throw createError(
                'Applications are disabled',
                ErrorTypes.CONFIGURATION,
                'Applications are currently disabled in this server.',
                { guildId: guild.id }
            );
        }

        if (subcommand === "submit") {
            await handleSubmit(interaction, settings);
        } else if (subcommand === "status") {
            await handleStatus(interaction);
        } else if (subcommand === "list") {
            await handleList(interaction);
        }
    }, { type: 'command', commandName: 'apply' })
};

export async function handleApplicationModal(interaction) {
    if (!interaction.isModalSubmit()) return;
    
    const customId = interaction.customId;
    if (!customId.startsWith('app_modal_')) return;
    
    const [, , roleId, pageRaw] = customId.split('_');
    const page = Number.parseInt(pageRaw, 10) || 0;
    
    const applicationRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
    const applicationRole = applicationRoles.find(appRole => appRole.roleId === roleId);
    
    if (!applicationRole) {
        return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: 'Application configuration not found.' });
    }
    
    const role = interaction.guild.roles.cache.get(roleId);
    
    if (!role) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Role not found.' });
    }
    
    const settings = await getApplicationSettings(interaction.client, interaction.guild.id);
    const questions = await resolveQuestions(interaction.client, interaction.guild.id, roleId, settings);

    // A modal holds at most QUESTIONS_PER_MODAL questions, so longer applications span several modals.
    const draftKey = `${interaction.guild.id}:${interaction.user.id}:${roleId}`;
    if (page === 0) pendingDrafts.delete(draftKey);
    const draft = pendingDrafts.get(draftKey) ?? { answers: [], expires: 0 };
    if (page > 0 && (draft.expires < Date.now() || draft.answers.length !== page * QUESTIONS_PER_MODAL)) {
        pendingDrafts.delete(draftKey);
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Your application session expired. Press the Apply button again to start over.' });
    }

    const start = page * QUESTIONS_PER_MODAL;
    const pageQuestions = questions.slice(start, start + QUESTIONS_PER_MODAL);
    for (let i = 0; i < pageQuestions.length; i++) {
        draft.answers.push({
            question: pageQuestions[i],
            answer: interaction.fields.getTextInputValue(`q${start + i}`),
        });
    }

    const nextStart = start + QUESTIONS_PER_MODAL;
    if (nextStart < questions.length) {
        draft.expires = Date.now() + DRAFT_TTL_MS;
        pendingDrafts.set(draftKey, draft);
        const totalPages = Math.ceil(questions.length / QUESTIONS_PER_MODAL);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`app_continue:${roleId}:${page + 1}`)
                .setLabel(`Continue (part ${page + 2} of ${totalPages})`)
                .setStyle(ButtonStyle.Primary),
        );
        return await interaction.reply({
            content: `Part ${page + 1} of ${totalPages} saved. Press the button to continue your **${applicationRole.name}** application.`,
            components: [row],
            flags: MessageFlags.Ephemeral,
        });
    }

    pendingDrafts.delete(draftKey);
    const answers = draft.answers;
    
    try {
        const application = await ApplicationService.submitApplication(interaction.client, {
            guildId: interaction.guild.id,
            userId: interaction.user.id,
            roleId: roleId,
            roleName: applicationRole.name,
            username: interaction.user.tag,
            avatar: interaction.user.displayAvatarURL(),
            answers: answers
        });
        
        const embed = successEmbed(
            'Application Submitted',
            `Your application for **${applicationRole.name}** has been submitted successfully!\n\n` +
            `Application ID: \`${application.id}\`\n` +
            `You can check the status with \`/apply status id:${application.id}\``
        );
        
        await InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: ["Ephemeral"] });
        
        const settings = await getApplicationSettings(interaction.client, interaction.guild.id);
        const roleSettings = await getApplicationRoleSettings(interaction.client, interaction.guild.id, roleId);
        const guildConfig = await getGuildConfig(interaction.client, interaction.guild.id);

        const logChannelId = resolveApplicationLogChannel(guildConfig, roleSettings, settings);

        if (logChannelId) {
            const logMessage = await logEvent({
                client: interaction.client,
                guildId: interaction.guild.id,
                eventType: EVENT_TYPES.APPLICATION_SUBMIT,
                channelId: logChannelId,
                data: {
                    title: 'Application Submitted',
                    lines: [
                        formatLogLine('Applicant', `<@${interaction.user.id}> (${interaction.user.tag})`),
                        formatLogLine('Application', applicationRole.name),
                        formatLogLine('Role', role.name),
                        formatLogLine('Application ID', `\`${application.id}\``),
                    ],
                    inlineFields: [
                        { name: 'Status', value: '🟡 In Progress', inline: true },
                    ],
                    author: await resolveUserAuthor(interaction.client, interaction.user.id),
                },
            });

            if (logMessage) {
                await updateApplication(interaction.client, interaction.guild.id, application.id, {
                    logMessageId: logMessage.id,
                    logChannelId,
                });
            }
        }
        
    } catch (error) {
        logger.error('Error creating application:', {
            error: error.message,
            userId: interaction.user.id,
            guildId: interaction.guild.id,
            roleId,
            stack: error.stack
        });
        
        await handleInteractionError(interaction, error, {
            type: 'modal',
            handler: 'application_submission'
        });
    }
}

async function handleList(interaction) {
    try {
        const applicationRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
        
        if (applicationRoles.length === 0) {
            return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'No applications are currently available.' });
        }

        const embed = createEmbed({
            title: "Available Applications",
            description: "Here are the roles you can apply for:"
        });

        applicationRoles.forEach((appRole, index) => {
            const role = interaction.guild.roles.cache.get(appRole.roleId);
            embed.addFields({
                name: `${index + 1}. ${appRole.name}`,
                value: `**Role:** ${role ?`<@&${appRole.roleId}>`: 'Role not found'}\n` +
                       `**Apply with:** \`/apply submit application:"${appRole.name}"\``,
                inline: false
            });
        });

        embed.setFooter({
            text: "Use /apply submit application:<name> to apply for any of these roles."
        });

        return InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    } catch (error) {
        logger.error('Error listing applications:', {
            error: error.message,
            guildId: interaction.guild.id,
            stack: error.stack
        });
        
        throw createError(
            'Failed to load applications',
            ErrorTypes.DATABASE,
            'Failed to load applications. Please try again later.',
            { guildId: interaction.guild.id }
        );
    }
}

async function handleSubmit(interaction, settings) {
    const applicationName = interaction.options.getString("application");

    const applicationRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
    
    const applicationRole = applicationRoles.find(appRole => 
        appRole.name.toLowerCase() === applicationName.toLowerCase()
    );

    if (!applicationRole) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Use `/apply list` to see available applications.' });
    }

    await showApplicationModalForRole(interaction, applicationRole.roleId, settings);
}

// Shared by `/apply submit` and the dashboard's application panel buttons.
export async function showApplicationModalForRole(interaction, roleId, settings) {
    const applicationRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
    const applicationRole = applicationRoles.find(appRole => appRole.roleId === roleId);

    if (!applicationRole) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'This application no longer exists.' });
    }

    const userApps = await getUserApplications(
        interaction.client,
        interaction.guild.id,
        interaction.user.id,
    );
    const pendingApp = userApps.find((app) => app.status === "pending");

    if (pendingApp) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'You already have a pending application. Please wait for it to be reviewed.' });
    }

    const role = interaction.guild.roles.cache.get(applicationRole.roleId);
    if (!role) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'The role for this application no longer exists.' });
    }

    const questions = await resolveQuestions(interaction.client, interaction.guild.id, applicationRole.roleId, settings);
    await interaction.showModal(buildApplicationModal(applicationRole, questions, 0));
}

export function buildApplicationModal(applicationRole, questions, page) {
    const totalPages = Math.ceil(questions.length / QUESTIONS_PER_MODAL);
    const modal = new ModalBuilder()
        .setCustomId(`app_modal_${applicationRole.roleId}_${page}`)
        .setTitle((totalPages > 1
            ? `${applicationRole.name} (${page + 1}/${totalPages})`
            : `Application for ${applicationRole.name}`).slice(0, 45));

    const start = page * QUESTIONS_PER_MODAL;
    questions.slice(start, start + QUESTIONS_PER_MODAL).forEach((question, i) => {
        const input = new TextInputBuilder()
            .setCustomId(`q${start + i}`)
            .setLabel(question.length > 45 ? `${question.substring(0, 42)}...` : question)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
    });
    return modal;
}

// Opens the next part of a multi-part application (button: app_continue:<roleId>:<page>).
export async function showApplicationContinuation(interaction, roleId, page) {
    const applicationRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
    const applicationRole = applicationRoles.find(appRole => appRole.roleId === roleId);
    if (!applicationRole) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'This application no longer exists.' });
    }
    const settings = await getApplicationSettings(interaction.client, interaction.guild.id);
    const questions = await resolveQuestions(interaction.client, interaction.guild.id, roleId, settings);
    if (page * QUESTIONS_PER_MODAL >= questions.length) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'This application changed. Press the Apply button again to start over.' });
    }
    await interaction.showModal(buildApplicationModal(applicationRole, questions, page));
}

async function handleStatus(interaction) {
    const appId = interaction.options.getString("id");

    if (appId) {
        const application = await getApplication(
            interaction.client,
            interaction.guild.id,
            appId,
        );

        if (!application || application.userId !== interaction.user.id) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Application not found or you do not have permission to view it.' });
        }

        const submittedAt = application?.createdAt ? new Date(application.createdAt) : null;
        const submittedAtDisplay = submittedAt && !Number.isNaN(submittedAt.getTime())
            ? submittedAt.toLocaleString()
            : 'Unknown date';
        const statusView = getApplicationStatusPresentation(application.status);
        const embed = createEmbed({
            title: `Application #${application.id} - ${application.roleName || 'Unknown Role'}`,
            description:
                `**Application ID:** \`${application.id}\`\n` +
                `**Status:** ${statusView.statusEmoji} ${statusView.statusLabel}\n` +
                `**Submitted:** ${submittedAtDisplay}`
        });

        return InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: ["Ephemeral"] });
    } else {
        const applications = await getUserApplications(
            interaction.client,
            interaction.guild.id,
            interaction.user.id,
        );

        if (applications.length === 0) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'You have not submitted any applications yet.' });
        }

        const recentApplications = applications
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
            .slice(0, 10);

        const embed = createEmbed({
            title: "Your Applications",
            description: `Showing ${recentApplications.length} recent application(s).`
        });

        recentApplications.forEach((application) => {
            const submittedAt = application?.createdAt ? new Date(application.createdAt) : null;
            const submittedAtDisplay = submittedAt && !Number.isNaN(submittedAt.getTime())
                ? submittedAt.toLocaleDateString()
                : 'Unknown date';
            const statusView = getApplicationStatusPresentation(application.status);

            embed.addFields({
                name: `${statusView.statusEmoji} ${application.roleName || 'Unknown Role'} (${statusView.statusLabel})`,
                value:
                    `**ID:** \`${application.id}\`\n` +
                    `**Status:** ${statusView.statusEmoji} ${statusView.statusLabel}\n` +
                    `**Submitted:** ${submittedAtDisplay}`,
                inline: true,
            });
        });

        if (applications.length > recentApplications.length) {
            embed.setFooter({ text: `Showing latest ${recentApplications.length} of ${applications.length} applications.` });
        }

        return InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: ["Ephemeral"] });
    }
}