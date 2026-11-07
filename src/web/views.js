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

const opts = (items, { empty } = {}) =>
    (empty ? `<option value="">${esc(empty)}</option>` : '') + items.map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('');

export function guildPage({ guild, csrf, notice, channels, categories, roles, config, apps, panels }) {
    const base = `/dashboard/g/${esc(guild.id)}`;
    const hid = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
    const msg = notice?.ok ? `<div class="ok">${esc(notice.ok)}</div>` : notice?.error ? `<div class="err">${esc(notice.error)}</div>` : '';
    const chan = (name) => `<label>Channel</label><select name="${name}" required>${opts(channels)}</select>`;

    const tickets = `<section id="tickets"><h2>Ticket panel</h2>
<p class="hint">${config.ticketPanelChannelId ? 'A panel already exists. Posting again replaces it.' : 'Posts a button members click to open a private ticket.'}</p>
<form method="post" action="${base}/tickets">${hid}${chan('channel')}
<label>Panel message</label><textarea name="message" maxlength="2000">${esc(config.ticketPanelMessage || 'Click the button below to create a support ticket.')}</textarea>
<label>Button label</label><input type="text" name="label" maxlength="80" value="${esc(config.ticketButtonLabel || 'Create Ticket')}">
<label>Staff role (can see tickets)</label><select name="staffRole">${opts(roles, { empty: 'None' })}</select>
<label>Open tickets category</label><select name="category">${opts(categories, { empty: 'Create a Tickets category' })}</select>
<label>Closed tickets category</label><select name="closedCategory">${opts(categories, { empty: 'None' })}</select>
<label>Max open tickets per user</label><input type="number" name="max" min="1" max="10" value="${esc(config.maxTicketsPerUser || 3)}">
<div class="check"><input type="checkbox" id="dm" name="dmOnClose" ${config.dmOnClose === false ? '' : 'checked'}><label for="dm" style="margin:0">DM the user when their ticket closes</label></div>
<button>Post ticket panel</button></form></section>`;

    const rr = `<section id="reactroles"><h2>Reaction roles</h2>
<p class="hint">A dropdown where members pick their own roles. Hold Ctrl or Cmd to select several. Roles above the bot's role or with admin permissions are rejected.</p>
${panels.map((p) => `<div class="row"><span>#${esc(p.channelName)}: ${esc(p.roleNames.join(', '))}</span><form method="post" action="${base}/reactroles/delete">${hid}<input type="hidden" name="messageId" value="${esc(p.messageId)}"><button class="danger">Delete</button></form></div>`).join('')}
<form method="post" action="${base}/reactroles">${hid}${chan('channel')}
<label>Title</label><input type="text" name="title" maxlength="256" required>
<label>Description</label><textarea name="description" maxlength="2000"></textarea>
<label>Roles</label><select name="roles" multiple required>${opts(roles)}</select>
<button>Post reaction role panel</button></form></section>`;

    const appList = apps.length ? `<ul class="list">${apps.map((a) => `<li>${esc(a.name)}</li>`).join('')}</ul>` : '';
    const applications = `<section id="applications"><h2>Applications</h2>
<p class="hint">Step 1: create an application. Step 2: post a panel with Apply buttons.</p>${appList}
<form method="post" action="${base}/applications">${hid}
<label>Application name</label><input type="text" name="name" maxlength="50" placeholder="Moderator" required>
<label>Role applicants are applying for</label><select name="role" required>${opts(roles)}</select>
<label>Questions (one per line, up to 5)</label><textarea name="questions" required placeholder="Why do you want this role?&#10;What experience do you have?"></textarea>
<button>Create application</button></form>
${apps.length ? `<hr style="border:0;border-top:1px solid #1e1f22;margin:24px 0">
<form method="post" action="${base}/applications/panel">${hid}${chan('channel')}
<label>Title</label><input type="text" name="title" maxlength="256" value="Applications">
<label>Description</label><textarea name="description" maxlength="2000">Click a button below to apply.</textarea>
<label>Applications on this panel (up to 5)</label><select name="apps" multiple required>${apps.map((a) => `<option value="${esc(a.roleId)}">${esc(a.name)}</option>`).join('')}</select>
<button>Post application panel</button></form>` : ''}</section>`;

    return layout(guild.name, `<nav><a href="/dashboard">All servers</a> · <a href="/dashboard/logout">Sign out</a></nav>${msg}${tickets}${rr}${applications}`);
}
