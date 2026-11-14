import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { getNickPrefixes, applyNickname } from '../services/nicknameService.js';

export default {
  name: Events.GuildMemberUpdate,
  once: false,

  async execute(oldMember, newMember) {
    try {
      if (!newMember.guild) return;

      // Auto nicknamer: re-apply the nickname when the member's roles change.
      if (!oldMember.partial && oldMember.roles.cache.size !== newMember.roles.cache.size
        || (!oldMember.partial && oldMember.roles.cache.some((r) => !newMember.roles.cache.has(r.id)))) {
        const prefixes = await getNickPrefixes(newMember.client, newMember.guild.id);
        if (Object.keys(prefixes).length) {
          await applyNickname(newMember.client, newMember, prefixes);
        }
      }

      if (oldMember.nickname !== newMember.nickname) {
        await logEvent({
          client: newMember.client,
          guildId: newMember.guild.id,
          eventType: EVENT_TYPES.MEMBER_NAME_CHANGE,
          data: {
            title: 'Nickname changed',
            lines: [
              `**User:** ${newMember.user.toString()} (${newMember.user.tag})`,
              `**ID:** \`${newMember.user.id}\``,
              `**Before:** ${oldMember.nickname || '*(no nickname)*'}`,
              `**After:** ${newMember.nickname || '*(no nickname)*'}`,
            ],
            thumbnail: newMember.user.displayAvatarURL({ dynamic: true }),
            userId: newMember.user.id,
          }
        });

        return;
      }

    } catch (error) {
      logger.error('Error in guildMemberUpdate event:', error);
    }
  }
};