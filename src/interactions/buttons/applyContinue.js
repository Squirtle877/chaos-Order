import { showApplicationContinuation } from '../../commands/Community/apply.js';

// Opens the next part of a multi-part application. customId: app_continue:<roleId>:<page>
export default {
    name: 'app_continue',
    async execute(interaction, client, args) {
        const [roleId, pageRaw] = args;
        await showApplicationContinuation(interaction, roleId, Number.parseInt(pageRaw, 10) || 0);
    },
};
