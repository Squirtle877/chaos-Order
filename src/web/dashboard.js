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
    saveApplicationRoleSettings,
} from '../utils/database.js';
import ApplicationService from '../services/applicationService.js';
import { layout, esc, guildPage, simplePage } from './views.js';

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

    const setSession = (res, s) => res.append('Set-Cookie',
        `${COOKIE}=${encodeURIComponent(signer.sign(s))}; ${cookieOpts}; Max-Age=${SESSION_TTL_MS / 1000}`);

    const getSession = (req) => {
        const s = signer.verify(parseCookies(req)[COOKIE]);
        return s && s.exp > Date.now() ? s : null;
    };

    router.use(express.urlencoded({ extended: false, limit: '50kb' }));
    router.use((req, res, next) => {
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    router.get('/login', (req, res) => {
        const state = crypto.randomBytes(16).toString('hex');
        res.append('Set-Cookie', `${STATE_COOKIE}=${state}; ${cookieOpts}; Max-Age=600`);
        const url = new URL('https://discord.com/oauth2/authorize');
        url.search = new URLSearchParams({
            client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
            scope: 'identify guilds', state, prompt: 'none',
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
        res.send(guildPage({
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
        if (config.ticketPanelChannelId && config.ticketPanelMessageId) {
            const old = guild.channels.cache.get(config.ticketPanelChannelId);
            await old?.messages?.delete?.(config.ticketPanelMessageId).catch(() => {});
        }

        const embed = new EmbedBuilder().setTitle('Support Tickets').setDescription(message).setColor(getColor('info'));
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('create_ticket').setLabel(label).setStyle(ButtonStyle.Primary).setEmoji('📩'),
        );
        const sent = await channel.send({ embeds: [embed], components: [row] });

        Object.assign(config, {
            ticketCategoryId: category, ticketClosedCategoryId: closed, ticketStaffRoleId: staff,
            ticketPanelChannelId: channel.id, ticketPanelMessageId: sent.id, ticketPanelMessage: message,
            ticketButtonLabel: label, maxTicketsPerUser: max, dmOnClose: body.dmOnClose === 'on',
        });
        try {
            await setGuildConfig(client, guild.id, config);
        } catch (error) {
            await sent.delete().catch(() => {});
            throw error;
        }
        logger.info('Ticket panel posted from dashboard', { guildId: guild.id, userId: req.session.uid });
        res.redirect(`/dashboard/g/${guild.id}?ok=${encodeURIComponent(`Ticket panel posted in #${channel.name}.`)}`);
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
        const questions = String(body.questions || '').split('\n').map((q) => q.trim().slice(0, 100)).filter(Boolean).slice(0, 5);
        if (!name) fail('Give the application a name.');
        if (!role) fail('Pick the role people apply for.');
        if (!questions.length) fail('Add at least one question (one per line, up to 5).');

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
        const selected = toArray(body.apps).map((id) => apps.find((a) => a.roleId === id)).filter(Boolean).slice(0, 5);
        if (!selected.length) fail('Pick at least one application for the panel.');
        const title = String(body.title || '').trim().slice(0, 256) || 'Applications';
        const description = String(body.description || '').trim().slice(0, 2000) || 'Click a button below to apply.';

        const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(getColor('info'));
        const row = new ActionRowBuilder().addComponents(selected.map((a) =>
            new ButtonBuilder().setCustomId(`apply_panel:${a.roleId}`).setLabel(`Apply: ${a.name}`.slice(0, 80)).setStyle(ButtonStyle.Success)));
        await channel.send({ embeds: [embed], components: [row] });
        res.redirect(`/dashboard/g/${guild.id}?ok=${encodeURIComponent(`Application panel posted in #${channel.name}.`)}`);
    }));

    app.use('/dashboard', router);
    logger.info(`Web dashboard mounted at ${baseUrl}/dashboard`);
}
