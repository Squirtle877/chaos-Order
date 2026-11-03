import { getApplicationSettings } from '../../utils/database.js';
import { showApplicationModalForRole } from '../../commands/Community/apply.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

// Button posted by the web dashboard's application panel. customId: apply_panel:<roleId>
export default {
    name: 'apply_panel',
    async execute(interaction, client, args) {
        const [roleId] = args;
        const settings = await getApplicationSettings(client, interaction.guild.id);
        if (!settings.enabled) {
            return replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: 'Applications are currently disabled in this server.' });
        }
        await showApplicationModalForRole(interaction, roleId, settings);
    },
};
