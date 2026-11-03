import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed, errorEmbed } from '../../utils/embeds.js';
import { botHasPermission } from '../../utils/permissionGuard.js';
import { startTts, stopTts, getTtsSession } from '../../services/ttsService.js';

export default {
    slashOnly: true,
    category: 'TTS',
    data: new SlashCommandBuilder()
        .setName('tts')
        .setDescription('Read messages from a text channel aloud in your voice channel')
        .setDMPermission(false)
        .addSubcommand((sub) =>
            sub.setName('start').setDescription('Join your voice channel and read messages from this channel'),
        )
        .addSubcommand((sub) =>
            sub.setName('stop').setDescription('Stop reading messages and leave the voice channel'),
        ),

    async execute(interaction, config, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const reply = (embed) => InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
        const sub = interaction.options.getSubcommand();

        if (sub === 'stop') {
            const stopped = stopTts(interaction.guild.id);
            return reply(stopped ? successEmbed('TTS', 'Stopped reading messages.') : errorEmbed('TTS', 'TTS is not running.'));
        }

        const voiceChannel = interaction.member.voice?.channel;
        if (!voiceChannel) {
            return reply(errorEmbed('TTS', 'Join a voice channel first.'));
        }
        if (client.riffy?.players?.get(interaction.guild.id)) {
            return reply(errorEmbed('TTS', 'Music is playing in this server. Stop it with `/music stop` first.'));
        }
        if (!botHasPermission(voiceChannel, [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
            return reply(errorEmbed('TTS', 'I need **Connect** and **Speak** permissions in your voice channel.'));
        }

        try {
            await startTts({
                guild: interaction.guild,
                voiceChannel,
                textChannelId: interaction.channel.id,
            });
        } catch {
            return reply(errorEmbed('TTS', 'Could not connect to the voice channel.'));
        }

        return reply(successEmbed(
            'TTS',
            `Reading messages from <#${interaction.channel.id}> in **${voiceChannel.name}**. Only people in that voice channel are read. Text before a \`|\` in a name is skipped. Use \`/tts stop\` to end.`,
        ));
    },
};
