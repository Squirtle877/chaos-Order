// Public Roblox verification site: /verify/:guildId. Discord login (identify only), then code-in-profile check.
import express from 'express';
import { layout, esc, simplePage } from './views.js';
import { logger } from '../utils/logger.js';
import {
    VerifyError, startVerification, completeVerification, getPending, getVerified,
} from '../services/robloxVerifyService.js';
import { getRobloxName } from '../services/nicknameService.js';

export const VERIFY_COOKIE = 'verify_session';
export const VERIFY_GUILD_COOKIE = 'verify_guild';

export function mountVerify(app, client, { getSession, parseCookies, cookieOpts }) {
    const router = express.Router();
    router.use(express.urlencoded({ extended: false, limit: '10kb' }));
    router.use((req, res, next) => {
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    router.get('/:guildId/login', (req, res) => {
        if (!/^\d{5,25}$/.test(req.params.guildId)) return res.status(404).send(simplePage('Not found', 'Unknown server.'));
        res.append('Set-Cookie', `${VERIFY_GUILD_COOKIE}=${req.params.guildId}; ${cookieOpts}; Max-Age=600`);
        res.redirect('/dashboard/login?verify=1');
    });

    const cooldown = new Map();
    const guard = (handler) => async (req, res) => {
        try {
            const guild = client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).send(simplePage('Not found', 'This server is not available.'));
            const session = getSession(req, VERIFY_COOKIE);
            if (!session) return res.send(layout(`Verify in ${guild.name}`,
                `<p>Link your Roblox account to your Discord account in <b>${esc(guild.name)}</b>.</p><a class="btn" href="/verify/${esc(guild.id)}/login">Sign in with Discord</a>`));
            const member = await guild.members.fetch(session.uid).catch(() => null);
            if (!member) return res.status(403).send(simplePage('Not a member', `You are not a member of ${esc(guild.name)}.`));
            if (req.method === 'POST') {
                if (req.body?.csrf !== session.csrf) return res.status(403).send(simplePage('Blocked', 'Invalid form token. Reload the page.'));
                const last = cooldown.get(session.uid) || 0;
                if (Date.now() - last < 3000) return res.status(429).send(simplePage('Slow down', 'Wait a few seconds and try again.'));
                cooldown.set(session.uid, Date.now());
            }
            await handler(req, res, { guild, member, session });
        } catch (error) {
            if (error instanceof VerifyError) return res.status(400).send(await page(req, { error: error.message }));
            logger.error('Roblox verify error:', error);
            res.status(500).send(simplePage('Something went wrong', 'Try again in a moment.'));
        }
    };

    const page = async (req, { error, ok } = {}) => {
        const guild = client.guilds.cache.get(req.params.guildId);
        const session = getSession(req, VERIFY_COOKIE);
        const hid = `<input type="hidden" name="csrf" value="${esc(session.csrf)}">`;
        const base = `/verify/${esc(guild.id)}`;
        const banner = (error ? `<div class="err">${esc(error)}</div>` : '') + (ok ? `<div class="ok">${esc(ok)}</div>` : '');
        const verifiedId = await getVerified(client, guild.id, session.uid);
        const verifiedName = verifiedId ? await getRobloxName(client, guild.id, session.uid) : null;
        const pending = await getPending(client, guild.id, session.uid);
        let body = `${banner}<p class="hint">Signed in as <b>${esc(session.name)}</b> · ${esc(guild.name)}</p>`;
        if (verifiedName) body += `<section><h2>Verified</h2><p>Your Roblox account is <b>${esc(verifiedName)}</b>.</p><p class="hint">To link a different account, verify again below.</p></section>`;
        if (pending) {
            body += `<section><h2>Step 2: add the code to your profile</h2>
<p>Open your Roblox profile for <b>${esc(pending.robloxName)}</b>, paste this code anywhere in the <b>About</b> description, and save.</p>
<p style="font:600 20px monospace;background:#1e1f22;padding:12px;border-radius:6px;user-select:all">${esc(pending.code)}</p>
<form method="post" action="${base}/check">${hid}<button>I added it, verify me</button></form>
<p class="hint">The code expires 15 minutes after you requested it. You can remove it from your profile afterwards.</p></section>`;
        }
        body += `<section><h2>${pending ? 'Use a different account' : 'Step 1: your Roblox username'}</h2>
<form method="post" action="${base}/start">${hid}<label>Roblox username</label>
<input type="text" name="username" maxlength="20" placeholder="Your username, not display name" required>
<button>Get my code</button></form></section>`;
        return layout('Roblox verification', body);
    };

    router.get('/:guildId', guard(async (req, res) => res.send(await page(req))));

    router.post('/:guildId/start', guard(async (req, res, { guild, member }) => {
        await startVerification(client, guild.id, member.id, req.body.username);
        res.redirect(`/verify/${guild.id}`);
    }));

    router.post('/:guildId/check', guard(async (req, res, { guild, member }) => {
        const r = await completeVerification(client, guild, member);
        const extra = [r.roleGranted ? 'You were given the verified role.' : '', r.nick === 'set' ? 'Your nickname was updated.' : '']
            .filter(Boolean).join(' ');
        res.send(await page(req, { ok: `Verified as ${r.robloxName}. ${extra}`.trim() }));
    }));

    app.use('/verify', router);
}
