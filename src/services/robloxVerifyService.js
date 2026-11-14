// Roblox verification by profile code: the member enters a Roblox username, gets a code,
// pastes it into their Roblox "About" description, and we read it back from Roblox's public API.
import crypto from 'node:crypto';
import { getGuildConfig } from './config/guildConfig.js';
import { setRobloxName, getNickPrefixes, applyNickname } from './nicknameService.js';
import { logger } from '../utils/logger.js';

const PENDING_TTL_MS = 15 * 60 * 1000;
const pendingKey = (g, u) => `guild:${g}:robloxPending:${u}`;
const idKey = (g, u) => `guild:${g}:robloxId:${u}`;
const ownerKey = (g, robloxId) => `guild:${g}:robloxOwner:${robloxId}`;

export class VerifyError extends Error {}

async function robloxJson(url, options) {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
    if (res.status === 429) throw new VerifyError('Roblox is rate limiting requests. Wait a minute and try again.');
    if (!res.ok) throw new VerifyError('Could not reach Roblox right now. Try again in a moment.');
    return res.json();
}

export async function lookupRobloxUser(username) {
    const name = String(username || '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) {
        throw new VerifyError('Enter your Roblox username (3-20 letters, numbers or underscores), not a display name.');
    }
    const data = await robloxJson('https://users.roblox.com/v1/usernames/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [name], excludeBannedUsers: true }),
    });
    const user = data?.data?.[0];
    if (!user) throw new VerifyError(`No Roblox user named "${name}" was found.`);
    return { id: String(user.id), name: user.name };
}

export async function getVerified(client, guildId, userId) {
    const robloxId = await client.db.get(idKey(guildId, userId), null);
    return robloxId ? String(robloxId) : null;
}

export async function getPending(client, guildId, userId) {
    const p = await client.db.get(pendingKey(guildId, userId), null);
    if (!p || p.exp < Date.now()) return null;
    return p;
}

export async function startVerification(client, guildId, userId, username) {
    const user = await lookupRobloxUser(username);
    const owner = await client.db.get(ownerKey(guildId, user.id), null);
    if (owner && owner !== userId) throw new VerifyError('That Roblox account is already verified by another member of this server.');
    const code = `chaos-${crypto.randomBytes(4).toString('hex')}`;
    const pending = { robloxId: user.id, robloxName: user.name, code, exp: Date.now() + PENDING_TTL_MS };
    await client.db.set(pendingKey(guildId, userId), pending);
    return pending;
}

export async function completeVerification(client, guild, member) {
    const pending = await getPending(client, guild.id, member.id);
    if (!pending) throw new VerifyError('Your code expired. Start again.');
    const profile = await robloxJson(`https://users.roblox.com/v1/users/${encodeURIComponent(pending.robloxId)}`);
    if (!String(profile.description || '').includes(pending.code)) {
        throw new VerifyError(`The code was not found in the description of ${pending.robloxName}. Save your profile and try again.`);
    }
    const owner = await client.db.get(ownerKey(guild.id, pending.robloxId), null);
    if (owner && owner !== member.id) throw new VerifyError('That Roblox account is already verified by another member of this server.');

    // Release a previously verified account, then record the new one.
    const old = await getVerified(client, guild.id, member.id);
    if (old && old !== pending.robloxId) await client.db.delete(ownerKey(guild.id, old));
    await client.db.set(idKey(guild.id, member.id), pending.robloxId);
    await client.db.set(ownerKey(guild.id, pending.robloxId), member.id);
    await setRobloxName(client, guild.id, member.id, profile.name || pending.robloxName);
    await client.db.delete(pendingKey(guild.id, member.id));

    let roleGranted = false;
    const roleId = (await getGuildConfig(client, guild.id).catch(() => null))?.robloxVerifiedRole;
    const role = roleId && guild.roles.cache.get(roleId);
    if (role && !role.managed && role.position < (guild.members.me?.roles.highest.position ?? 0)) {
        try { await member.roles.add(role, 'Roblox verification'); roleGranted = true; }
        catch (error) { logger.warn(`Verified role grant failed for ${member.id}: ${error.message}`); }
    }
    const fresh = await guild.members.fetch(member.id).catch(() => member);
    const nick = await applyNickname(client, fresh, await getNickPrefixes(client, guild.id));
    return { robloxName: profile.name || pending.robloxName, roleGranted, nick };
}
