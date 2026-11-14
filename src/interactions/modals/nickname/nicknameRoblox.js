import { MessageFlags } from 'discord.js';
import {
    isValidRobloxName, setRobloxName, getNickPrefixes, applyNickname,
} from '../../../services/nicknameService.js';

// Submitted from the nick_roblox button. customId: nick_roblox_modal
export default {
    name: 'nick_roblox_modal',
    async execute(interaction, client) {
        const name = interaction.fields.getTextInputValue('roblox_name').trim();
        if (!isValidRobloxName(name)) {
            return interaction.reply({
                content: 'Roblox names are 3-20 characters: letters, numbers, underscores, and spaces between words.',
                flags: MessageFlags.Ephemeral,
            });
        }
        await setRobloxName(client, interaction.guild.id, interaction.user.id, name);
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const result = await applyNickname(client, member, await getNickPrefixes(client, interaction.guild.id));
        const note = result === 'skipped'
            ? ' I could not change your nickname (my role may be below yours), but your Roblox name is saved.'
            : '';
        return interaction.reply({
            content: `Saved your Roblox name as **${name}**.${note}`,
            flags: MessageFlags.Ephemeral,
        });
    },
};
