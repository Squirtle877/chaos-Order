import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { getRobloxName } from '../../services/nicknameService.js';

// Button on the Roblox name panel posted from the dashboard. customId: nick_roblox
export default {
    name: 'nick_roblox',
    async execute(interaction, client) {
        const current = await getRobloxName(client, interaction.guild.id, interaction.user.id).catch(() => null);
        const input = new TextInputBuilder()
            .setCustomId('roblox_name')
            .setLabel('Your Roblox username')
            .setStyle(TextInputStyle.Short)
            .setMinLength(3)
            .setMaxLength(20)
            .setRequired(true);
        if (current) input.setValue(current);
        await interaction.showModal(
            new ModalBuilder().setCustomId('nick_roblox_modal').setTitle('Set your Roblox name')
                .addComponents(new ActionRowBuilder().addComponents(input)),
        );
    },
};
