// Web dashboard: create ticket panels, reaction role panels and application panels
// from a browser. Discord OAuth login; only members with Manage Server can edit a guild.
import crypto from 'node:crypto';
import express from 'express';
import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
    PermissionFlagsBits, StringSelectMenuBuilder,
} from 'discord.js';
import { logger } from '../utils/logger.js';
import { getColor } from '../config/bot.js';
import { getGuildConfig, setGuildConfig } from '../services/config/guildConfig.js';
import {
    createReactionRoleMessage, hasDangerousPermissions,
    getAllReactionRoleMessages, deleteReactionRoleMessage,
} from '../services/reactionRoleService.js';
import {
    getApplicationRoles, saveApplicationRoles, getApplicationSettings,
    saveApplicationRoleSettings, getApplicationRoleSettings, deleteApplicationRoleSettings,
} from '../utils/database.js';
import {
    nickableRoles, getNickPrefixes, saveNickPrefixes, syncAllMembers,
} from '../services/nicknameService.js';
import { mountVerify, VERIFY_COOKIE, VERIFY_GUILD_COOKIE } from './verify.js';
import ApplicationService from '../services/applicationService.js';
import { layout, esc, guildPage, applicationEditPage, simplePage } from './views.js';

const MAX_QUESTIONS = 25;
const MAX_PANEL_APPS = 25; // 5 buttons per row, 5 rows

const DISCORD_API = 'https://discord.com/api/v10';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'dash_session';
const STATE_COOKIE = 'dash_state';

function b64(buf) { return Buffer.from(buf).toString('base64url'); }

function createSigner(secret) {
    const mac = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');
    return {
        sign(obj) {
            const body = b64(JSON.stringify(obj));
            return `${body}.${mac(body)}`;
        },
        verify(token) {
            if (typeof token !== 'string') return null;
            const [body, sig] = token.split('.');
            if (!body || !sig) return null;
            const expected = mac(body);
            const a = Buffer.from(sig);
            const b = Buffer.from(expected);
            if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
            try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
        },
    };
}

function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function parseQuestions(raw) {
    return String(raw || '').split('\n').map((q) => q.trim().slice(0, 100)).filter(Boolean).slice(0, MAX_QUESTIONS);
}

function toArray(v) { return v === undefined ? [] : Array.isArray(v) ? v : [v]; }

export function mountDashboard(app, client) {
    const clientId = process.env.CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    const secret = process.env.DASHBOARD_SESSION_SECRET || clientSecret;
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
    const baseUrl = (process.env.DASHBOARD_URL || (domain ? `https://${domain}` : '')).replace(/\/$/, '');
    const secure = baseUrl.startsWith('https://');
    const router = express.Router();

    if (!clientId || !clientSecret || !secret || !baseUrl) {
        router.get('/', (req, res) => res.status(503).send(simplePage('Dashboard not configured',
            'Set DISCORD_CLIENT_SECRET and DASHBOARD_URL (or a Railway public domain) to enable the dashboard.')));
        app.use('/dashboard', router);
        logger.warn('Web dashboard disabled: missing DISCORD_CLIENT_SECRET or public URL.');
        return;
    }

    const signer = createSigner(secret);
    const redirectUri = `${baseUrl}/dashboard/callback`;
    const cookieOpts = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

    const setSession = (res, s, cookie = COOKIE) => res.append('Set-Cookie',
        `${cookie}=${encodeURIComponent(signer.sign(s))}; ${cookieOpts}; Max-Age=${SESSION_TTL_MS / 1000}`);

    const getSession = (req, cookie = COOKIE) => {
        const s = signer.verify(parseCookies(req)[cookie]);
        return s && s.exp > Date.now() ? s : null;
    };

    // Public Roblox verification site shares this Discord login and redirect URI.
    mountVerify(app, client, { getSession, parseCookies, cookieOpts });

    router.use(express.urlencoded({ extended: false, limit: '50kb' }));
    router.use((req, res, next) => {
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    router.get('/login', (req, res) => {
        if (!req.query.verify) res.append('Set-Cookie', `${VERIFY_GUILD_COOKIE}=; ${cookieOpts}; Max-Age=0`);
        const state = crypto.randomBytes(16).toString('hex');
        res.append('Set-Cookie', `${STATE_COOKIE}=${state}; ${cookieOpts}; Max-Age=600`);
        const url = new URL('https://discord.com/oauth2/authorize');
        url.search = new URLSearchParams({
            client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
            scope: req.query.verify ? 'identify' : 'identify guilds', state, prompt: 'none',
        }).toString();
        res.redirect(url.toString());
    });

    router.get('/callback', async (req, res) => {
        try {
            const { code, state } = req.query;
            if (!code || !state || state !== parseCookies(req)[STATE_COOKIE]) {
                return res.status(400).send(simplePage('Login failed', 'Invalid login state. <a href="/dashboard/login">Try again</a>.'));
            }
            const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code',
                    code: String(code), redirect_uri: redirectUri,
                }),
            });
            if (!tokenRes.ok) throw new Error(`token exchange ${tokenRes.status}`);
            const { access_token: token } = await tokenRes.json();
            const headers = { Authorization: `Bearer ${token}` };
            const verifyGuild = parseCookies(req)[VERIFY_GUILD_COOKIE];
            if (verifyGuild && /^\d{5,25}$/.test(verifyGuild)) {
                const me = await fetch(`${DISCORD_API}/users/@me`, { headers }).then((r) => r.json());
                setSession(res, {
                    uid: me.id, name: me.global_name || me.username,
                    csrf: crypto.randomBytes(16).toString('hex'), exp: Date.now() + SESSION_TTL_MS,
                }, VERIFY_COOKIE);
                res.append('Set-Cookie', `${VERIFY_GUILD_COOKIE}=; ${cookieOpts}; Max-Age=0`);
                return res.redirect(`/verify/${verifyGuild}`);
            }
            const [me, guilds] = await Promise.all([
                fetch(`${DISCORD_API}/users/@me`, { headers }).then((r) => r.json()),
                fetch(`${DISCORD_API}/users/@me/guilds`, { headers }).then((r) => r.json()),
            ]);
            const manageable = (Array.isArray(guilds) ? guilds : [])
                .filter((g) => (g.owner || (BigInt(g.permissions) & PermissionFlagsBits.ManageGuild) !== 0n)
                    && client.guilds.cache.has(g.id))
                .map((g) => ({ id: g.id, name: g.name }));
            setSession(res, {
                uid: me.id, name: me.global_name || me.username, guilds: manageable,
                csrf: crypto.randomBytes(16).toString('hex'), exp: Date.now() + SESSION_TTL_MS,
            });
            res.redirect('/dashboard');
        } catch (error) {
            logger.error('Dashboard login failed:', error);
            res.status(500).send(simplePage('Login failed', 'Could not sign in with Discord. <a href="/dashboard/login">Try again</a>.'));
        }
    });

    router.get('/logout', (req, res) => {
        res.append('Set-Cookie', `${COOKIE}=; ${cookieOpts}; Max-Age=0`);
        res.redirect('/dashboard');
    });

    // Everything below needs a session.
    router.use((req, res, next) => {
        const session = getSession(req);
        if (!session) {
            if (req.path === '/' && req.method === 'GET') {
                return res.send(layout('Sign in', '<p>Manage tickets, applications and reaction roles for your server.</p><a class="btn" href="/dashboard/login">Sign in with Discord</a>'));
            }
            return res.redirect('/dashboard/login');
        }
        req.session = session;
        next();
    });

    router.get('/', (req, res) => {
        const list = req.session.guilds.map((g) => `<li><a href="/dashboard/g/${esc(g.id)}">${esc(g.name)}</a></li>`).join('');
        res.send(layout('Your servers', `<p>Signed in as <b>${esc(req.session.name)}</b> · <a href="/dashboard/logout">Sign out</a></p>
            ${list ? `<ul class="list">${list}</ul>` : '<p>No servers found where you have Manage Server and the bot is present.</p>'}`));
    });

    // Per-guild authorization, re-checked live on every request.
    router.use('/g/:guildId', async (req, res, next) => {
        const guild = client.guilds.cache.get(req.params.guildId);
        if (!guild || !req.session.guilds.some((g) => g.id === guild.id)) {
            return res.status(403).send(simplePage('No access', 'You cannot manage this server.'));
        }
        const member = await guild.members.fetch(req.session.uid).catch(() => null);
        if (!member || !(guild.ownerId === member.id || member.permissions.has(PermissionFlagsBits.ManageGuild))) {
            return res.status(403).send(simplePage('No access', 'You need Manage Server in this server.'));
        }
        if (req.method === 'POST' && req.body?.csrf !== req.session.csrf) {
            return res.status(403).send(simplePage('Blocked', 'Invalid form token. Reload the page and try again.'));
        }
        req.guild = guild;
        next();
    });

    const render = async (req, res, notice) => {
        const guild = req.guild;
        const channels = guild.channels.cache
            .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
            .sort((a, b) => a.rawPosition - b.rawPosition).map((c) => ({ id: c.id, name: c.name }));
        const categories = guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory)
            .sort((a, b) => a.rawPosition - b.rawPosition).map((c) => ({ id: c.id, name: c.name }));
        const roles = guild.roles.cache.filter((r) => r.id !== guild.id && !r.managed)
            .sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name }));
        const config = await getGuildConfig(client, guild.id).catch(() => ({}));
        const panels = (await getAllReactionRoleMessages(client, guild.id).catch(() => [])) || [];
        const apps = await getApplicationRoles(client, guild.id);
        const prefixes = await getNickPrefixes(client, guild.id);
        const nickRoles = [...nickableRoles(guild).values()].map((r) => ({ id: r.id, name: r.name, prefix: prefixes[r.id] || '' }));
        res.send(guildPage({
            nickRoles,
            verifyUrl: `${baseUrl}/verify/${guild.id}`,
            verifiedRole: (await getGuildConfig(client, guild.id).catch(() => null))?.robloxVerifiedRole || '',
            guild: { id: guild.id, name: guild.name }, csrf: req.session.csrf, notice,
            channels, categories, roles, config: config || {}, apps,
            panels: panels.map((p) => ({
                messageId: p.messageId, channelName: guild.channels.cache.get(p.channelId)?.name || 'deleted-channel',
                roleNames: (p.roles || []).map((id) => guild.roles.cache.get(id)?.name || 'deleted-role'),
            })),
        }));
    };

    const guard = (fn) => async (req, res) => {
        try { await fn(req, res); } catch (error) {
            logger.error('Dashboard action failed:', error);
            await render(req, res, { error: error.userMessage || error.message || 'Something went wrong.' });
        }
    };
    const fail = (message) => { const e = new Error(message); e.userMessage = message; throw e; };

    const getTextChannel = (guild, id) => {
        const ch = guild.channels.cache.get(String(id));
        if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement)) fail('Pick a text channel.');
        if (!ch.permissionsFor(guild.members.me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
            fail(`I can't send messages or embeds in #${ch.name}.`);
        }
        return ch;
    };

    // --- Auto nicknamer ---
    router.post('/g/:guildId/nicknames', guard(async (req, res) => {
        const { guild, body } = req;
        const prefixes = {};
        for (const role of nickableRoles(guild).values()) {
            const prefix = String(body[`prefix_${role.id}`] || '').trim().slice(0, 16);
            if (prefix) prefixes[role.id] = prefix;
        }
        await saveNickPrefixes(client, guild.id, prefixes);
        const count = Object.keys(prefixes).length;
        res.redirect(`/dashboard/g/${guild.id}?ok=${encodeURIComponent(`Saved ${count} nickname prefix${count === 1 ? '' : 'es'}. New role changes apply automatically; use "Apply to all members" for existing members.`)}#nicknames`);
    }));

    router.post('/g/:guildId/nicknames/sync', guard(async (req, res) => {
        if (!req.guild.members.me.permissions.has(PermissionFlagsBits.ManageNicknames)) fail('I need the Manage Nicknames permission.');
        const r = await syncAllMembers(client, req.guild);
        res.redirect(`/dashboard/g/${req.guild.id}?ok=${encodeURIComponent(`Done: ${r.set} nicknames set, ${r.reset} cleared, ${r.unchanged} already correct, ${r.skipped} skipped (owner, bots, or above my role).`)}#nicknames`);
    }));

    router.post('/g/:guildId/nicknames/panel', guard(async (req, res) => {
        const { guild, body } = req;
        const channel = getTextChannel(guild, body.channel);
        const title = String(body.title || '').trim().slice(0, 256) || 'Set your Roblox name';
        const description = String(body.description || '').trim().slice(0, 2000)
            || 'Click the button and enter your Roblox username. Your server nickname will be updated to match.';
        const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(getColor('info'));
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('nick_roblox').setLabel('Set Roblox name').setStyle(ButtonStyle.Primary));
        await channel.send({ embeds: [embed], components: [row] });
        res.redirect(`/dashboard/g/${guild.id}?ok=${encodeURIComponent(`Roblox name panel posted in #${channel.name}.`)}#nicknames`);
    }));

    // --- Roblox verification ---
    router.post('/g/:guildId/roblox', guard(async (req, res) => {
        const { guild, body } = req;
        const roleId = String(body.role || '');
        const role = roleId ? nickableRoles(guild).get(roleId) : null;
        if (roleId && !role) fail('That role is above my role or cannot be given.');
        const config = (await getGuildConfig(client, guild.id)) || {};
        config.robloxVerifiedRole = role ? role.id : null;
        await setGuildConfig(client, guild.id, config);
        res.redirect(`/dashboard/g/${guild.id}?ok=${encodeURIComponent(role ? `Verified members will get ${role.name}.` : 'Verified members will not get a role.')}#roblox`);
    }));

    router.post('/g/:guildId/roblox/panel', guard(async (req, res) => {
        const { guild, body } = req;
        const channel = getTextChannel(guild, body.channel);
        const embed = new EmbedBuilder()
            .setTitle(String(body.title || '').trim().slice(0, 256) || 'Verify your Roblox account')
            .setDescription(String(body.description || '').trim().slice(0, 2000)
                || 'Click the button, sign in with Discord, and prove you own your Roblox account.')
            .setColor(getColor('info'));
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Verify Roblox').setStyle(ButtonStyle.Link).setURL(`${baseUrl}/verify/${guild.id}`));
        await channel.send({ embeds: [embed], components: [row] });
        res.redirect(`/dashboard/g/${guild.id}?ok=${encodeURIComponent(`Verification panel posted in #${channel.name}.`)}#roblox`);
    }));

    router.get('/g/:guildId', guard((req, res) => render(req, res, req.query.ok ? { ok: String(req.query.ok).slice(0, 200) } : null)));

    // --- Tickets ---
    router.post('/g/:guildId/tickets', guard(async (req, res) => {
        const { guild, body } = req;
        const channel = getTextChannel(guild, body.channel);
        const message = String(body.message || '').trim().slice(0, 2000) || 'Click the button below to create a support ticket.';
        const label = String(body.label || '').trim().slice(0, 80) || 'Create Ticket';
        const max = Math.min(Math.max(parseInt(body.max, 10) || 3, 1), 10);
        const category = body.category && guild.channels.cache.get(body.category)?.type === ChannelType.GuildCategory ? body.category : null;
        const closed = body.closedCategory && guild.channels.cache.get(body.closedCategory)?.type === ChannelType.GuildCategory ? body.closedCategory : null;
        const staff = body.staffRole && guild.roles.cache.has(body.staffRole) ? body.staffRole : null;

        const config = (await getGuildConfig(client, guild.id)) || {};

        const embed = new EmbedBuilder().setTitle('Support Tickets').setDescription(message).setColor(getColor('info'));
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('create_ticket').setLabel(label).setStyle(ButtonStyle.Primary).setEmoji('📩'),
        );

        // Editing: update the existing panel message in place when it is still in the chosen channel.
        let sent = null;
        let sentIsNew = false;
        const oldChannel = config.ticketPanelChannelId ? guild.channels.cache.get(config.ticketPanelChannelId) : null;
        const oldMessage = oldChannel && config.ticketPanelMessageId
            ? await oldChannel.messages.fetch(config.ticketPanelMessageId).catch(() => null) : null;
        if (oldMessage && oldChannel.id === channel.id) {
            sent = await oldMessage.edit({ embeds: [embed], components: [row] }).catch(() => null);
        }
        if (!sent) {
            sent = await channel.send({ embeds: [embed], components: [row] });
            sentIsNew = true;
            if (oldMessage) await oldMessage.delete().catch(() => {});
        }

        Object.assign(config, {
            ticketCategoryId: category, ticketClosedCategoryId: closed, ticketStaffRoleId: staff,
            ticketPanelChannelId: channel.id, ticketPanelMessageId: sent.id, ticketPanelMessage: message,
            ticketButtonLabel: label, maxTicketsPerUser: max, dmOnClose: body.dmOnClose === 'on',
        });
        try {
            await setGuildConfig(client, guild.id, config);
        } catch (error) {
            if (sentIsNew) await sent.delete().catch(() => {});
            throw error;
        }
        logger.info('Ticket panel posted from dashboard', { guildId: guild.id, userId: req.session.uid });
        res.redirect(`/dashboard/g/${guild.id}?ok=${encodeURIComponent(`Ticket panel saved in #${channel.name}.`)}`);
    }));

    // --- Reaction roles ---
    router.post('/g/:guildId/reactroles', guard(async (req, res) => {
        const { guild, body } = req;
        const channel = getTextChannel(guild, body.channel);
        const title = String(body.title || '').trim().slice(0, 256);
        const description = String(body.description || '').trim().slice(0, 2000);
        if (!title) fail('Give the panel a title.');
        if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) fail('I need the Manage Roles permission.');

        const existing = (await getAllReactionRoleMessages(client, guild.id)) || [];
        if (existing.length >= 5) fail('This server already has 5 reaction role panels. Delete one first.');

        const roles = [];
        for (const id of [...new Set(toArray(body.roles))].slice(0, 25)) {
            const role = guild.roles.cache.get(id);
            if (!role) continue;
            if (role.position >= guild.members.me.roles.highest.position) fail(`My role is below "${role.name}", so I can't assign it. Move my role higher.`);
            if (hasDangerousPermissions(role)) fail(`"${role.name}" has dangerous permissions and can't be a reaction role.`);
            if (role.managed || role.id === guild.id) fail(`"${role.name}" can't be used.`);
            roles.push(role);
        }
        if (!roles.length) fail('Pick at least one role.');

        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('reaction_roles').setPlaceholder('Select your roles')
                .setMinValues(0).setMaxValues(roles.length)
                .addOptions(roles.map((r) => ({
                    label: r.name.slice(0, 100), description: `Add/remove the ${r.name} role`.slice(0, 100), value: r.id, emoji: '🎭',
                }))),
        );
        const embed = new EmbedBuilder().setTitle(title).setColor(getColor('info'))
            .addFields({ name: 'Available Roles', value: roles.map((r) => `• ${r}`).join('\n').slice(0, 1024) })
            .setFooter({ text: 'Select roles from the dropdown menu below' });
        if (description) embed.setDescription(description);

        const msg = await channel.send({ embeds: [embed], components: [row] });
        try {
            await createReactionRoleMessage(client, guild.id, channel.id, msg.id, roles.map((r) => r.id));
        } catch (error) {
            await msg.delete().catch(() => {});
            throw error;
        }
        res.redirect(`/dashboard/g/${guild.id}?ok=${encodeURIComponent(`Reaction role panel posted in #${channel.name}.`)}`);
    }));

    router.post('/g/:guildId/reactroles/delete', guard(async (req, res) => {
        const { guild, body } = req;
        const panel = ((await getAllReactionRoleMessages(client, guild.id)) || []).find((p) => p.messageId === body.messageId);
        if (!panel) fail('Panel not found.');
        await guild.channels.cache.get(panel.channelId)?.messages?.delete?.(panel.messageId).catch(() => {});
        await deleteReactionRoleMessage(client, guild.id, panel.messageId);
        res.redirect(`/dashboard/g/${guild.id}?ok=${encodeURIComponent('Panel deleted.')}`);
    }));

    // --- Applications ---
    router.post('/g/:guildId/applications', guard(async (req, res) => {
        const { guild, body } = req;
        const name = String(body.name || '').trim().slice(0, 50);
        const role = guild.roles.cache.get(body.role);
        const questions = parseQuestions(body.questions);
        if (!name) fail('Give the application a name.');
        if (!role) fail('Pick the role people apply for.');
        if (!questions.length) fail(`Add at least one question (one per line, up to ${MAX_QUESTIONS}).`);

        const existing = await getApplicationRoles(client, guild.id);
        if (existing.some((r) => r.roleId === role.id)) fail(`${role.name} is already an application.`);
        if (existing.some((r) => r.name.toLowerCase() === name.toLowerCase())) fail('An application with that name already exists.');
        existing.push({ roleId: role.id, name, enabled: true });
        await saveApplicationRoles(client, guild.id, existing);
        const settings = await getApplicationSettings(client, guild.id);
        if (!settings.enabled) await ApplicationService.updateSettings(client, guild.id, { enabled: true });
        await saveApplicationRoleSettings(client, guild.id, role.id, { questions });
        res.redirect(`/dashboard/g/${guild.id}?ok=${encodeURIComponent(`Application "${name}" created. Post a panel for it below.`)}`);
    }));

    router.post('/g/:guildId/applications/panel', guard(async (req, res) => {
        const { guild, body } = req;
        const channel = getTextChannel(guild, body.channel);
        const apps = await getApplicationRoles(client, guild.id);
        const selected = toArray(body.apps).map((id) => apps.find((a) => a.roleId === id)).filter(Boolean).slice(0, MAX_PANEL_APPS);
        if (!selected.length) fail('Pick at least one application for the panel.');
        const title = String(body.title || '').trim().slice(0, 256) || 'Applications';
        const description = String(body.description || '').trim().slice(0, 2000) || 'Click a button below to apply.';

        const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(getColor('info'));
        const buttons = selected.map((a) =>
            new ButtonBuilder().setCustomId(`apply_panel:${a.roleId}`).setLabel(`Apply: ${a.name}`.slice(0, 80)).setStyle(ButtonStyle.Success));
        const rows = [];
        for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
        await channel.send({ embeds: [embed], components: rows });
        res.redirect(`/dashboard/g/${guild.id}?ok=${encodeURIComponent(`Application panel posted in #${channel.name}.`)}`);
    }));

    const findApp = async (guild, roleId) => (await getApplicationRoles(client, guild.id)).find((a) => a.roleId === roleId);

    router.get('/g/:guildId/applications/:roleId', guard(async (req, res) => {
        const application = await findApp(req.guild, req.params.roleId);
        if (!application) return res.redirect(`/dashboard/g/${req.guild.id}?ok=${encodeURIComponent('Application not found.')}`);
        const settings = await getApplicationRoleSettings(client, req.guild.id, application.roleId);
        const roles = req.guild.roles.cache.get(application.roleId);
        res.send(applicationEditPage({
            guild: { id: req.guild.id, name: req.guild.name }, csrf: req.session.csrf, application,
            roleName: roles?.name || 'deleted role', questions: settings?.questions || [],
            notice: req.query.ok ? { ok: String(req.query.ok).slice(0, 200) } : null, max: MAX_QUESTIONS,
        }));
    }));

    router.post('/g/:guildId/applications/:roleId', guard(async (req, res) => {
        const { guild, body } = req;
        const all = await getApplicationRoles(client, guild.id);
        const application = all.find((a) => a.roleId === req.params.roleId);
        if (!application) fail('Application not found.');
        const name = String(body.name || '').trim().slice(0, 50);
        const questions = parseQuestions(body.questions);
        if (!name) fail('Give the application a name.');
        if (!questions.length) fail(`Add at least one question (one per line, up to ${MAX_QUESTIONS}).`);
        if (all.some((a) => a !== application && a.name.toLowerCase() === name.toLowerCase())) fail('Another application already uses that name.');
        application.name = name;
        application.enabled = body.enabled === 'on';
        await saveApplicationRoles(client, guild.id, all);
        const settings = (await getApplicationRoleSettings(client, guild.id, application.roleId)) || {};
        await saveApplicationRoleSettings(client, guild.id, application.roleId, { ...settings, questions });
        res.redirect(`/dashboard/g/${guild.id}/applications/${application.roleId}?ok=${encodeURIComponent('Saved. Existing panels pick up the new questions automatically; repost a panel to change button names.')}`);
    }));

    router.post('/g/:guildId/applications/:roleId/delete', guard(async (req, res) => {
        const { guild } = req;
        const all = await getApplicationRoles(client, guild.id);
        const next = all.filter((a) => a.roleId !== req.params.roleId);
        if (next.length === all.length) fail('Application not found.');
        await saveApplicationRoles(client, guild.id, next);
        await deleteApplicationRoleSettings(client, guild.id, req.params.roleId);
        res.redirect(`/dashboard/g/${guild.id}?ok=${encodeURIComponent('Application deleted. Buttons for it on old panels will stop working.')}`);
    }));

    app.use('/dashboard', router);
    logger.info(`Web dashboard mounted at ${baseUrl}/dashboard`);
}
