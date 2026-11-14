// Server-rendered HTML for the dashboard. No build step, no client JS required.
export function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const CSS = `
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#1e1f22;color:#dbdee1}
a{color:#00a8fc}main{max-width:820px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:24px;margin:0 0 16px}h2{font-size:18px;margin:0 0 4px}
section{background:#2b2d31;border-radius:8px;padding:20px;margin:20px 0}
p.hint{color:#949ba4;margin:0 0 14px;font-size:13px}
label{display:block;font-weight:600;font-size:13px;margin:12px 0 4px;color:#b5bac1}
input[type=text],input[type=number],select,textarea{width:100%;padding:9px 10px;border-radius:6px;border:1px solid #1e1f22;background:#1e1f22;color:#dbdee1;font:inherit}
select[multiple]{height:160px}textarea{min-height:90px}
.btn,button{display:inline-block;margin-top:16px;padding:9px 16px;border:0;border-radius:6px;background:#5865f2;color:#fff;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button.danger{background:#da373c;margin:0}.check{display:flex;gap:8px;align-items:center;margin-top:12px}.check input{width:auto}
.ok,.err{padding:10px 14px;border-radius:6px;margin:12px 0}.ok{background:#1a4d2e}.err{background:#5c1f22}
ul.list{padding-left:20px}.row{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px solid #1e1f22}
.row form{margin:0}nav{margin-bottom:8px}`;

export function layout(title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Chaos Order</title><style>${CSS}</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

export function simplePage(title, htmlBody) {
    return layout(title, `<p>${htmlBody}</p>`);
}

const opts = (items, { empty, selected } = {}) =>
    (empty ? `<option value="">${esc(empty)}</option>` : '') +
    items.map((i) => `<option value="${esc(i.id)}"${i.id === selected ? ' selected' : ''}>${esc(i.name)}</option>`).join('');

export function guildPage({ nickRoles = [], verifyUrl = '', verifiedRole = '', guild, csrf, notice, channels, categories, roles, config, apps, panels }) {
    const base = `/dashboard/g/${esc(guild.id)}`;
    const hid = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
    const msg = notice?.ok ? `<div class="ok">${esc(notice.ok)}</div>` : notice?.error ? `<div class="err">${esc(notice.error)}</div>` : '';
    const chan = (name, selected) => `<label>Channel</label><select name="${name}" required>${opts(channels, { selected })}</select>`;

    const tickets = `<section id="tickets"><h2>Ticket panel</h2>
<p class="hint">${config.ticketPanelChannelId ? 'Your current settings are loaded below. Saving updates the existing panel message in place (or moves it if you pick another channel).' : 'Posts a button members click to open a private ticket.'}</p>
<form method="post" action="${base}/tickets">${hid}${chan('channel', config.ticketPanelChannelId)}
<label>Panel message</label><textarea name="message" maxlength="2000">${esc(config.ticketPanelMessage || 'Click the button below to create a support ticket.')}</textarea>
<label>Button label</label><input type="text" name="label" maxlength="80" value="${esc(config.ticketButtonLabel || 'Create Ticket')}">
<label>Staff role (can see tickets)</label><select name="staffRole">${opts(roles, { empty: 'None', selected: config.ticketStaffRoleId })}</select>
<label>Open tickets category</label><select name="category">${opts(categories, { empty: 'Create a Tickets category', selected: config.ticketCategoryId })}</select>
<label>Closed tickets category</label><select name="closedCategory">${opts(categories, { empty: 'None', selected: config.ticketClosedCategoryId })}</select>
<label>Max open tickets per user</label><input type="number" name="max" min="1" max="10" value="${esc(config.maxTicketsPerUser || 3)}">
<div class="check"><input type="checkbox" id="dm" name="dmOnClose" ${config.dmOnClose === false ? '' : 'checked'}><label for="dm" style="margin:0">DM the user when their ticket closes</label></div>
<button>${config.ticketPanelChannelId ? 'Save ticket panel' : 'Post ticket panel'}</button></form></section>`;

    const rr = `<section id="reactroles"><h2>Reaction roles</h2>
<p class="hint">A dropdown where members pick their own roles. Hold Ctrl or Cmd to select several. Roles above the bot's role or with admin permissions are rejected.</p>
${panels.map((p) => `<div class="row"><span>#${esc(p.channelName)}: ${esc(p.roleNames.join(', '))}</span><form method="post" action="${base}/reactroles/delete">${hid}<input type="hidden" name="messageId" value="${esc(p.messageId)}"><button class="danger">Delete</button></form></div>`).join('')}
<form method="post" action="${base}/reactroles">${hid}${chan('channel')}
<label>Title</label><input type="text" name="title" maxlength="256" required>
<label>Description</label><textarea name="description" maxlength="2000"></textarea>
<label>Roles</label><select name="roles" multiple required>${opts(roles)}</select>
<button>Post reaction role panel</button></form></section>`;

    const appList = apps.length ? apps.map((a) => `<div class="row"><span>${esc(a.name)}${a.enabled === false ? ' (disabled)' : ''}</span><a href="${base}/applications/${esc(a.roleId)}">Edit</a></div>`).join('') : '';
    const applications = `<section id="applications"><h2>Applications</h2>
<p class="hint">Step 1: create an application. Step 2: post a panel with Apply buttons.</p>${appList}
<form method="post" action="${base}/applications">${hid}
<label>Application name</label><input type="text" name="name" maxlength="50" placeholder="Moderator" required>
<label>Role applicants are applying for</label><select name="role" required>${opts(roles)}</select>
<label>Questions (one per line, up to 25)</label><textarea name="questions" required placeholder="Why do you want this role?&#10;What experience do you have?"></textarea>
<button>Create application</button></form>
${apps.length ? `<hr style="border:0;border-top:1px solid #1e1f22;margin:24px 0">
<form method="post" action="${base}/applications/panel">${hid}${chan('channel')}
<label>Title</label><input type="text" name="title" maxlength="256" value="Applications">
<label>Description</label><textarea name="description" maxlength="2000">Click a button below to apply.</textarea>
<label>Applications on this panel (up to 25, hold Ctrl or Cmd to pick several)</label><select name="apps" multiple required>${apps.map((a) => `<option value="${esc(a.roleId)}">${esc(a.name)}</option>`).join('')}</select>
<button>Post application panel</button></form>` : ''}</section>`;

    const nicknames = `<section id="nicknames"><h2>Auto nicknamer</h2>
<p class="hint">Members with a role below get that prefix before their name, for example <b>[Mod] RobloxName</b>. If someone has several prefixed roles, the highest one wins. Leave a prefix blank for no change. Only roles below the bot's role are listed.</p>
${nickRoles.length ? `<form method="post" action="${base}/nicknames">${hid}
${nickRoles.map((r) => `<label>${esc(r.name)}</label><input type="text" name="prefix_${esc(r.id)}" maxlength="16" value="${esc(r.prefix)}" placeholder="No prefix">`).join('')}
<button>Save prefixes</button></form>
<form method="post" action="${base}/nicknames/sync" onsubmit="return confirm('Rename every member that has a prefixed role or a saved Roblox name?')">${hid}<button style="background:#4e5058">Apply to all members</button></form>`
 : '<p>No roles found below the bot\'s role. Move the bot\'s role higher in Server Settings, Roles.</p>'}
<hr style="border:0;border-top:1px solid #1e1f22;margin:24px 0">
<h2>Roblox name form</h2>
<p class="hint">Posts a button. Members click it, enter their Roblox username, and their nickname becomes the prefix plus that name.</p>
<form method="post" action="${base}/nicknames/panel">${hid}${chan('channel')}
<label>Title</label><input type="text" name="title" maxlength="256" value="Set your Roblox name">
<label>Description</label><textarea name="description" maxlength="2000">Click the button and enter your Roblox username. Your server nickname will be updated to match.</textarea>
<button>Post Roblox name panel</button></form></section>`;

    const robloxVerify = `<section id="roblox"><h2>Roblox verification</h2>
<p class="hint">Members prove they own a Roblox account by putting a one-time code in their Roblox profile description. Their verified name is then used by the auto nicknamer. Public page: <a href="${esc(verifyUrl)}">${esc(verifyUrl)}</a></p>
<form method="post" action="${base}/roblox">${hid}
<label>Role given when verified (optional)</label>
<select name="role"><option value="">None</option>${nickRoles.map((r) => `<option value="${esc(r.id)}"${r.id === verifiedRole ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
<button>Save</button></form>
<form method="post" action="${base}/roblox/panel">${hid}${chan('channel')}
<label>Title</label><input type="text" name="title" maxlength="256" value="Verify your Roblox account">
<label>Description</label><textarea name="description" maxlength="2000">Click the button, sign in with Discord, and prove you own your Roblox account.</textarea>
<button>Post verification panel</button></form></section>`;

    return layout(guild.name, `<nav><a href="/dashboard">All servers</a> · <a href="/dashboard/logout">Sign out</a></nav>${msg}${tickets}${rr}${applications}${nicknames}${robloxVerify}`);
}

export function applicationEditPage({ guild, csrf, application, roleName, questions, notice, max }) {
    const base = `/dashboard/g/${esc(guild.id)}/applications/${esc(application.roleId)}`;
    const hid = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
    const msg = notice?.ok ? `<div class="ok">${esc(notice.ok)}</div>` : '';
    return layout(`Edit ${application.name}`, `<nav><a href="/dashboard/g/${esc(guild.id)}">Back to ${esc(guild.name)}</a></nav>${msg}
<section><form method="post" action="${base}">${hid}
<label>Application name</label><input type="text" name="name" maxlength="50" value="${esc(application.name)}" required>
<label>Role granted on approval</label><input type="text" value="${esc(roleName)}" disabled>
<label>Questions (one per line, up to ${esc(max)}). Applicants answer 5 per page.</label>
<textarea name="questions" style="min-height:220px" required>${esc(questions.join('\n'))}</textarea>
<div class="check"><input type="checkbox" id="en" name="enabled" ${application.enabled === false ? '' : 'checked'}><label for="en" style="margin:0">Enabled</label></div>
<button>Save changes</button></form></section>
<section><h2>Delete application</h2><p class="hint">Removes the application and its questions. Existing submissions are kept.</p>
<form method="post" action="${base}/delete" onsubmit="return confirm('Delete this application?')">${hid}<button class="danger">Delete application</button></form></section>`);
}
