// Auto nicknamer: members with a configured role get "<prefix> <Roblox name>" as their nickname.
import { PermissionFlagsBits } from 'discord.js';
import { getGuildConfig, setGuildConfig } from './config/guildConfig.js';
import { logger } from '../utils/logger.js';

const MAX_NICK = 32;
// Roblox usernames have no spaces, but display names can (3-20 characters), so spaces are allowed inside.
const ROBLOX_NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_ ]{1,18})[A-Za-z0-9_]$/;
const robloxKey = (guildId, userId) => `guild:${guildId}:robloxName:${userId}`;

export function isValidRobloxName(name) {
    return ROBLOX_NAME.test(String(name ?? ''));
}

export async function getRobloxName(client, guildId, userId) {
    const v = await client.db.get(robloxKey(guildId, userId), null);
    return typeof v === 'string' ? v : v?.name || null;
}

export async function setRobloxName(client, guildId, userId, name) {
    await client.db.set(robloxKey(guildId, userId), name);
}

export async function getNickPrefixes(client, guildId) {
    const config = (await getGuildConfig(client, guildId).catch(() => null)) || {};
    return config.nickPrefixes && typeof config.nickPrefixes === 'object' ? config.nickPrefixes : {};
}

export async function saveNickPrefixes(client, guildId, prefixes) {
    const config = (await getGuildConfig(client, guildId)) || {};
    config.nickPrefixes = prefixes;
    await setGuildConfig(client, guildId, config);
}

/** Roles the bot is able to give a nickname for: below the bot's top role, not managed, not @everyone. */
export function nickableRoles(guild) {
    const top = guild.members.me?.roles.highest.position ?? 0;
    return guild.roles.cache
        .filter((r) => r.id !== guild.id && !r.managed && r.position < top)
        .sort((a, b) => b.position - a.position);
}

export function buildNickname(prefix, base) {
    const p = String(prefix || '').trim();
    if (!p) return String(base).slice(0, MAX_NICK);
    const room = MAX_NICK - p.length - 1;
    if (room < 1) return p.slice(0, MAX_NICK);
    return `${p} ${String(base).slice(0, room)}`;
}

/**
 * Work out and apply the nickname for one member.
 * Returns 'set', 'reset', 'unchanged' or 'skipped'.
 */
export async function applyNickname(client, member, prefixes) {
    const guild = member.guild;
    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageNicknames)) return 'skipped';
    if (member.user.bot || member.id === guild.ownerId) return 'skipped';
    if ((member.roles.highest?.position ?? 0) >= me.roles.highest.position) return 'skipped';

    // Highest-ranked role with a prefix wins.
    const prefixRole = member.roles.cache
        .filter((r) => prefixes[r.id])
        .sort((a, b) => b.position - a.position)
        .first();
    const prefix = prefixRole ? prefixes[prefixRole.id] : '';
    const roblox = await getRobloxName(client, guild.id, member.id);

    let target = null;
    if (prefix || roblox) {
        target = buildNickname(prefix, roblox || member.user.globalName || member.user.username);
    } else {
        // Nothing to apply any more: clear a nickname we set earlier, leave hand-set ones alone.
        const current = member.nickname || '';
        const mine = Object.values(prefixes).some((p) => p && current.startsWith(`${p} `));
        if (!mine) return 'unchanged';
    }

    if ((member.nickname || null) === target) return 'unchanged';
    try {
        await member.setNickname(target, 'Auto nicknamer');
        return target ? 'set' : 'reset';
    } catch (error) {
        logger.warn(`Auto nickname failed for ${member.id} in ${guild.id}: ${error.message}`);
        return 'skipped';
    }
}

export async function syncAllMembers(client, guild) {
    const prefixes = await getNickPrefixes(client, guild.id);
    const members = await guild.members.fetch();
    const result = { set: 0, reset: 0, unchanged: 0, skipped: 0 };
    for (const member of members.values()) {
        const r = await applyNickname(client, member, prefixes);
        result[r] += 1;
        if (r === 'set' || r === 'reset') await new Promise((res) => setTimeout(res, 400)); // stay under rate limits
    }
    return result;
}
