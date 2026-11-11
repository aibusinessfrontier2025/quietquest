import { escapeHtml as esc, renderMarkdown } from './markdown.js';

// ── Icons ────────────────────────────────────────────────────────────────────
const ICONS = {
  send: '<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.5"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  alert: '<path d="M8 2.5 14 13H2L8 2.5ZM8 6.5v3M8 11.2v.1"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
  sliders: '<path d="M3 5h6M12 5h1M3 11h1M7 11h6"/><circle cx="10.5" cy="5" r="1.5"/><circle cx="5.5" cy="11" r="1.5"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
  moon: '<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5Z"/>',
  spinner: '<path d="M8 2.5a5.5 5.5 0 1 0 5.5 5.5"/>',
  terminal: '<path d="m4 5 3 3-3 3M9 11h3"/>',
  bolt: '<path d="M9 2 4 9h4l-1 5 5-7H8l1-5Z"/>',
  loop: '<path d="M3 8a5 5 0 0 1 9-3M13 8a5 5 0 0 1-9 3M12 2.5V5H9.5M4 13.5V11h2.5"/>',
  shield: '<path d="M8 2 3 4v4c0 3 2.2 5 5 6 2.8-1 5-3 5-6V4L8 2Z"/>',
  minus: '<path d="M4 8h8"/>',
};
const icon = (name) => `<svg class="i" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;

// ── State ────────────────────────────────────────────────────────────────────
const S = {
  loaded: false,
  connected: true,
  demo: false,
  config: null,
  home: '',
  projects: new Map(),
  tasks: new Map(),
  agents: new Map(),
  approvals: new Map(),
  chat: [],
  chatDelta: null,
  providers: {},
  rateLimits: {},
  manager: { busy: false, queued: 0 },
  memory: '',
  view: 'overview',
  drawer: null, // { agentId, events, delta }
};

const $ = (id) => document.getElementById(id);
const ACTIVE = new Set(['queued', 'running', 'waiting']);
const PROVIDER_LABEL = { claude: 'Claude', codex: 'OpenAI' };

// ── Helpers ──────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `Request failed (${response.status})`);
  return json;
}

function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function compact(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

function stamp(ts) {
  const date = new Date(ts);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return time;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function template(html) {
  const holder = document.createElement('template');
  holder.innerHTML = html.trim();
  return holder.content.firstElementChild;
}

/** Updates `from` in place to match `to`, so running animations and open <details> survive re-renders. */
function morph(from, to) {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) {
    from.replaceWith(to);
    return to;
  }
  if (from.nodeType !== Node.ELEMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return from;
  }
  const keyed = to.dataset.keyed !== undefined;
  if (keyed && from.dataset.keyed === undefined) {
    from.replaceWith(to);
    return to;
  }
  for (const { name } of [...from.attributes]) {
    const sticky = name === 'data-key' || (name === 'open' && from.nodeName === 'DETAILS');
    if (!to.hasAttribute(name) && !sticky) from.removeAttribute(name);
  }
  for (const { name, value } of [...to.attributes]) {
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
  // Keyed lists own their children; patch() fills them after the frame is morphed.
  if (keyed) return from;
  const current = [...from.childNodes];
  const next = [...to.childNodes];
  next.forEach((node, index) => {
    if (current[index]) morph(current[index], node);
    else from.appendChild(node);
  });
  for (let index = next.length; index < current.length; index++) current[index].remove();
  return from;
}

/** Keyed list render: untouched items are left alone, changed ones are morphed, new ones animate in. */
function patch(container, items) {
  const existing = new Map();
  for (const el of [...container.children]) existing.set(el.dataset.key, el);
  let previous = null;
  for (const item of items) {
    let el = existing.get(item.key);
    if (el) {
      existing.delete(item.key);
      if (el.__html !== item.html) {
        el = morph(el, template(item.html));
        el.dataset.key = item.key;
        el.__html = item.html;
      }
    } else {
      el = template(item.html);
      el.dataset.key = item.key;
      el.__html = item.html;
      // One entrance only: drop the class so showing a hidden pane later does not replay it.
      el.classList.add('enter');
      el.addEventListener('animationend', () => el.classList.remove('enter'), { once: true });
    }
    const expected = previous ? previous.nextElementSibling : container.firstElementChild;
    if (expected !== el) container.insertBefore(el, expected);
    previous = el;
  }
  for (const el of existing.values()) el.remove();
}

function setHtml(el, html) {
  if (el.__html === html) return;
  el.__html = html;
  el.innerHTML = html;
}

const chip = (provider) =>
  `<span class="chip" data-provider="${esc(provider)}">${esc(PROVIDER_LABEL[provider] ?? provider)}</span>`;

function toolSummary(event, cwd = '') {
  const input = event.input ?? {};
  const file = input.file_path ?? input.path;
  const relative = file && cwd && String(file).startsWith(`${cwd}/`) ? String(file).slice(cwd.length + 1) : file;
  const detail = input.command ?? relative ?? input.pattern ?? input.query ?? input.url ?? input.description;
  if (detail) return String(detail);
  if (Array.isArray(input.changes)) return input.changes.map((c) => `${c.kind} ${c.path}`).join(', ');
  const text = JSON.stringify(input);
  return text === '{}' ? '' : text;
}

// ── Derived data ─────────────────────────────────────────────────────────────
const agentsOf = (taskId) =>
  [...S.agents.values()].filter((a) => a.taskId === taskId).sort((a, b) => b.createdAt - a.createdAt);
const tasksOf = (projectId) =>
  [...S.tasks.values()].filter((t) => t.projectId === projectId).sort((a, b) => a.createdAt - b.createdAt);
const activeAgents = () =>
  [...S.agents.values()].filter((a) => ACTIVE.has(a.status)).sort((a, b) => a.createdAt - b.createdAt);
const pendingApprovals = () => [...S.approvals.values()].sort((a, b) => a.createdAt - b.createdAt);
const blockedTasks = () =>
  [...S.tasks.values()].filter((t) => t.status === 'blocked' && S.projects.get(t.projectId)?.status === 'active');
const needsCount = () => pendingApprovals().length + blockedTasks().length;

// ── Chat ─────────────────────────────────────────────────────────────────────
function managerMessageHtml(message) {
  const blocks = [];
  let run = [];
  const flush = () => {
    if (run.length) blocks.push(`<div class="actions">${run.join('')}</div>`);
    run = [];
  };
  for (const part of message.parts ?? []) {
    if (part.type === 'action') {
      const glyph = part.state === 'running' ? 'spinner' : part.state === 'error' ? 'x' : 'check';
      const inner = `${icon(glyph)}<span>${esc(part.label)}</span>`;
      run.push(
        part.agentId
          ? `<button class="action" data-state="${part.state}" data-action="open-agent" data-id="${esc(part.agentId)}">${inner}</button>`
          : `<div class="action" data-state="${part.state}">${inner}</div>`,
      );
      if (part.detail) run.push(`<div class="action-detail">${esc(part.detail)}</div>`);
    } else if (part.type === 'text') {
      flush();
      blocks.push(`<div class="md">${renderMarkdown(part.text)}</div>`);
    }
  }
  flush();
  const live = S.chatDelta?.id === message.id ? S.chatDelta.text : '';
  if (live) blocks.push(`<div class="md">${renderMarkdown(live)}</div>`);
  if (message.streaming && !live) blocks.push('<div class="typing"><i></i><i></i><i></i></div>');
  if (message.stopped) blocks.push('<div class="msg-time">Stopped</div>');
  return `<div class="msg msg-pm" title="${esc(stamp(message.ts))}">${blocks.join('')}</div>`;
}

function chatItems() {
  const items = [];
  let lastTs = 0;
  for (const message of S.chat) {
    const empty = message.role === 'pm' && !message.parts?.length && !message.streaming;
    if (empty) continue;
    if (message.ts - lastTs > 30 * 60 * 1000) {
      items.push({ key: `t-${message.id}`, html: `<div class="msg-event"><span>${esc(stamp(message.ts))}</span></div>` });
    }
    lastTs = message.ts;
    let html;
    if (message.role === 'user') {
      html = `<div class="msg msg-user" title="${esc(stamp(message.ts))}">${esc(message.text)}</div>`;
    } else if (message.role === 'event') {
      const inner = `<i class="dot" data-status="${esc(message.outcome ?? 'done')}"></i><span>${esc(message.text)}</span>`;
      html = message.agentId
        ? `<button class="msg msg-event" data-action="open-agent" data-id="${esc(message.agentId)}">${inner}</button>`
        : `<div class="msg msg-event">${inner}</div>`;
    } else if (message.role === 'error') {
      html = `<div class="msg msg-error">${esc(message.text)}</div>`;
    } else {
      html = managerMessageHtml(message);
    }
    items.push({ key: message.id, html });
  }
  return items;
}

function renderChat() {
  const name = S.config?.pm.name ?? 'Chief';
  const scroller = $('chat-scroll');
  const pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const list = $('chat-list');
  const items = chatItems();
  if (!items.length && S.loaded) {
    items.push({
      key: 'empty',
      html: `<div class="chat-empty"><h2>One conversation.<br>Every project.</h2><p>Tell ${esc(name)} about anything you're working on. It plans the work, starts the workers, checks what they hand back, and tells you only what needs you.</p></div>`,
    });
  }
  patch(list, items);
  if (pinned) scroller.scrollTop = scroller.scrollHeight;

  $('pm-name').textContent = name;
  $('composer-input').placeholder = `Tell ${name} what you're working on…`;
  document.querySelector('.chat').dataset.busy = String(S.manager.busy);
  const running = activeAgents().length;
  $('pm-status').textContent = S.manager.busy
    ? 'Working…'
    : running
      ? `${running} worker${running === 1 ? '' : 's'} on the job`
      : 'All quiet';
  const stop = $('pm-stop');
  stop.hidden = !S.manager.busy;
  setHtml(stop, icon('stop'));
}

// ── Top bar ──────────────────────────────────────────────────────────────────
function renderTopbar() {
  const needs = needsCount();
  const tabs = [
    ['overview', 'Overview', needs],
    ['workers', 'Workers', S.agents.size],
  ];
  setHtml(
    $('tabs'),
    tabs
      .map(
        ([id, label, count]) =>
          `<button class="tab" data-action="view" data-view="${id}" ${S.view === id ? 'aria-current="page"' : ''}>${label}${
            count ? `<span class="count ${id === 'overview' ? 'hot' : ''}">${count}</span>` : ''
          }</button>`,
      )
      .join(''),
  );

  setHtml(
    $('providers'),
    Object.values(S.providers)
      .map((p) => {
        const state = !p.installed ? 'missing' : p.loggedIn ? 'ready' : 'signin';
        const windows = Object.entries(S.rateLimits[p.id]?.windows ?? {});
        const top = windows.sort((a, b) => (b[1].utilization ?? 0) - (a[1].utilization ?? 0))[0];
        const usage = top ? `${Math.round((top[1].utilization ?? 0) * 100)}%` : '';
        const title = !p.installed
          ? 'Not installed'
          : !p.loggedIn
            ? 'Not signed in'
            : top
              ? `Signed in · ${usage} of your ${top[0].replace(/_/g, ' ')} limit used`
              : `Signed in${p.detail ? ` · ${p.detail}` : ''}`;
        return `<button class="provider" data-state="${state}" data-action="settings" title="${esc(title)}"><i></i>${esc(p.label)}${
          usage ? `<small>${usage}</small>` : ''
        }</button>`;
      })
      .join(''),
  );

  const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
  setHtml($('theme-toggle'), icon(dark ? 'sun' : 'moon'));
  setHtml($('open-settings'), icon('sliders'));
  setHtml($('composer-send'), icon('send'));
  $('pane-badge').textContent = needs ? `· ${needs}` : '';

  const banner = $('banner');
  const pm = S.providers[S.config?.pm.provider];
  let text = '';
  if (!S.connected) text = 'Lost connection to QuietQuest. Reconnecting…';
  else if (S.demo) text = 'Demo mode: sample projects and scripted workers. Nothing here uses your subscriptions.';
  else if (pm && !(pm.installed && pm.loggedIn)) text = `${pm.label} is not ready, so the manager cannot run yet. ${pm.fix ?? ''}`;
  banner.hidden = !text;
  banner.textContent = text;
}

// ── Overview ─────────────────────────────────────────────────────────────────
function needHtml() {
  const items = [];
  for (const approval of pendingApprovals()) {
    const agent = S.agents.get(approval.agentId);
    const project = S.projects.get(approval.projectId);
    const input = approval.input ?? {};
    const body = input.command ?? input.file_path ?? input.url ?? JSON.stringify(input, null, 2);
    items.push({
      key: approval.id,
      html: `<div class="need" data-kind="approval">
        <div class="need-top">${icon('shield')}<span>Approval · ${esc(project?.name ?? '')}</span></div>
        <div class="need-title">${esc(agent?.name ?? 'A worker')} wants to run ${esc(approval.toolName)}</div>
        <div class="code">${esc(body)}</div>
        <div class="need-actions">
          <button class="btn primary" data-action="approve" data-id="${approval.id}" data-decision="allow">Allow</button>
          <button class="btn" data-action="approve" data-id="${approval.id}" data-decision="allow" data-always="1" title="Stop asking about ${esc(approval.toolName)} for this worker">Always for this worker</button>
          <button class="btn danger" data-action="approve" data-id="${approval.id}" data-decision="deny">Deny</button>
          <button class="btn ghost" data-action="open-agent" data-id="${esc(approval.agentId)}">See context</button>
        </div>
      </div>`,
    });
  }
  for (const task of blockedTasks()) {
    const project = S.projects.get(task.projectId);
    items.push({
      key: task.id,
      html: `<div class="need" data-kind="blocked">
        <div class="need-top">${icon('alert')}<span>Blocked · ${esc(project?.name ?? '')}</span></div>
        <div class="need-title">${esc(task.title)}</div>
        <div class="need-body">${esc(task.blocker || 'Waiting on you.')}</div>
        <div class="need-actions">
          <button class="btn" data-action="reply" data-text="About “${esc(task.title)}”: ">Reply to ${esc(S.config?.pm.name ?? 'Chief')}</button>
        </div>
      </div>`,
    });
  }
  return items;
}

function workerCardHtml(agent) {
  const task = S.tasks.get(agent.taskId);
  const project = S.projects.get(agent.projectId);
  return `<button class="worker-card" data-action="open-agent" data-id="${agent.id}" data-selected="${S.drawer?.agentId === agent.id}">
    <div class="worker-top"><i class="dot" data-status="${agent.status}"></i><span class="worker-name">${esc(agent.name)}</span>${chip(agent.provider)}</div>
    <div class="worker-task"><b>${esc(task?.title ?? '')}</b> · ${esc(project?.name ?? '')}</div>
    <div class="activity">${esc(agent.activity || '…')}</div>
    <div class="worker-foot">
      <span>${icon('clock')}<time data-since="${agent.status === 'queued' ? '' : (agent.turnStartedAt ?? agent.startedAt ?? '')}">${agent.status === 'queued' ? 'queued' : ''}</time></span>
      <span>${icon('terminal')}${agent.toolCalls} steps</span>
      ${agent.autonomy !== 'edit' ? `<span>${icon('shield')}${esc(agent.autonomy)}</span>` : ''}
    </div>
  </button>`;
}

function taskRowHtml(task) {
  const workers = agentsOf(task.id);
  const latest = workers[0];
  let sub = '';
  if (task.status === 'blocked' && task.blocker) sub = task.blocker;
  else if (latest && ACTIVE.has(latest.status)) sub = latest.activity;
  else if (task.status === 'done' && task.result) sub = task.result;
  else if (task.status === 'review') sub = 'Report in, waiting for review';
  const glyph = task.status === 'done' ? icon('check') : task.status === 'blocked' ? icon('minus') : '';
  const side = latest ? `<span class="task-side">${chip(latest.provider)}<i class="dot" data-status="${latest.status}"></i></span>` : '<span></span>';
  const inner = `<span class="glyph" data-status="${task.status}">${glyph}</span>
    <span class="task-title">${esc(task.title)}</span>${side}
    ${sub ? `<span></span><span class="task-sub">${esc(sub)}</span>` : ''}`;
  return latest
    ? `<button class="task" data-status="${task.status}" data-action="open-agent" data-id="${latest.id}" title="${esc(task.description || task.title)}">${inner}</button>`
    : `<div class="task" data-status="${task.status}" title="${esc(task.description || task.title)}">${inner}</div>`;
}

function projectHtml(project) {
  const tasks = tasksOf(project.id);
  const live = tasks.filter((t) => t.status !== 'cancelled');
  const done = live.filter((t) => t.status === 'done').length;
  const order = { done: 0, review: 1, in_progress: 2, blocked: 3, todo: 4 };
  const segments = [...live]
    .sort((a, b) => order[a.status] - order[b.status])
    .map((t) => `<i data-status="${t.status}"></i>`)
    .join('');
  const finished = project.status === 'done';
  return `<article class="project" data-status="${project.status}">
    <div class="project-head">
      <div class="project-title"><h3>${esc(project.name)}</h3>${
        project.status !== 'active' ? `<span class="pill" data-status="${finished ? 'done' : ''}">${esc(project.status)}</span>` : ''
      }</div>
      ${project.goal ? `<p class="project-goal">${esc(project.goal)}</p>` : ''}
      ${live.length ? `<div class="progress">${segments}</div><div class="progress-label">${done} of ${live.length} done</div>` : ''}
    </div>
    ${
      !tasks.length
        ? ''
        : finished
          ? `<details class="fold"><summary>${tasks.length} task${tasks.length === 1 ? '' : 's'}</summary><div class="tasks">${tasks.map(taskRowHtml).join('')}</div></details>`
          : `<div class="tasks">${tasks.map(taskRowHtml).join('')}</div>`
    }
    <div class="project-foot" title="${esc(project.dir)}"><span>${esc(project.dir)}</span></div>
  </article>`;
}

function overviewHtml() {
  const active = activeAgents();
  const needs = needHtml();
  const projects = [...S.projects.values()].filter((p) => p.status !== 'archived');
  const open = projects.filter((p) => p.status !== 'done').sort((a, b) => b.createdAt - a.createdAt);
  const finished = projects.filter((p) => p.status === 'done').sort((a, b) => b.updatedAt - a.updatedAt);
  const openTasks = [...S.tasks.values()].filter((t) => ['todo', 'in_progress', 'review'].includes(t.status)).length;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const doneToday = [...S.tasks.values()].filter((t) => t.status === 'done' && t.updatedAt > dayAgo).length;

  if (!projects.length) {
    const name = esc(S.config?.pm.name ?? 'Chief');
    const starters = [
      ['A trip', 'Plan five days in Lisbon in March for two, under €2,400. Start with flights and where to stay.'],
      ['A codebase', 'In ~/code/my-app, find out why the test suite is flaky and fix the worst offender.'],
      ['Research', 'Compare the three best options for a home battery backup and write me a one-page brief.'],
    ];
    return `<div class="welcome">
      <h2>Nothing on the board yet</h2>
      <p>Describe a project to ${name} in the conversation. Projects, tasks, and the workers doing them will show up here as they start.</p>
      <div class="starters">${starters
        .map(([label, text]) => `<button class="starter" data-action="reply" data-text="${esc(text)}"><small>${label}</small>${esc(text)}</button>`)
        .join('')}</div>
    </div>`;
  }

  return `
    <div class="stats">
      <div class="stat" data-tone="${active.length ? 'run' : ''}"><b>${active.length}</b><span>Working now</span></div>
      <div class="stat" data-tone="${needs.length ? 'wait' : ''}"><b>${needs.length}</b><span>Waiting on you</span></div>
      <div class="stat"><b>${openTasks}</b><span>Open tasks</span></div>
      <div class="stat"><b>${doneToday}</b><span>Done in the last day</span></div>
    </div>
    <section class="section" ${needs.length ? '' : 'hidden'}>
      <div class="section-head"><h2>Needs you</h2><span>Workers are waiting on these</span></div>
      <div class="needs" id="needs" data-keyed></div>
    </section>
    <section class="section">
      <div class="section-head"><h2>Working now</h2><span>${active.length ? 'Select a worker to watch it live' : ''}</span></div>
      <div class="running" id="running" data-keyed ${active.length ? '' : 'hidden'}></div>
      ${active.length ? '' : '<div class="quiet">No workers are running. Anything you ask for will start here.</div>'}
    </section>
    <section class="section">
      <div class="section-head"><h2>Projects</h2><span>${open.length} open</span></div>
      <div class="projects" id="projects" data-keyed></div>
      ${open.length ? '' : '<div class="quiet">No open projects. Everything you started is finished.</div>'}
    </section>
    <section class="section" ${finished.length ? '' : 'hidden'}>
      <div class="section-head"><h2>Finished</h2></div>
      <div class="projects" id="finished" data-keyed></div>
    </section>`;
}

function workersHtml() {
  const agents = [...S.agents.values()].sort((a, b) => b.createdAt - a.createdAt);
  if (!agents.length) return '<div class="quiet">No workers have run yet.</div>';
  const rows = agents
    .map((agent) => {
      const task = S.tasks.get(agent.taskId);
      const project = S.projects.get(agent.projectId);
      const active = ACTIVE.has(agent.status);
      const duration = active
        ? `<time data-since="${agent.startedAt ?? ''}"></time>`
        : agent.startedAt && agent.endedAt
          ? elapsed(agent.endedAt - agent.startedAt)
          : '';
      return `<tr data-action="open-agent" data-id="${agent.id}">
        <td><span class="cell-main"><i class="dot" data-status="${agent.status}"></i>${esc(agent.name)}</span></td>
        <td>${esc(task?.title ?? '')}</td>
        <td class="optional">${esc(project?.name ?? '')}</td>
        <td>${chip(agent.provider)}</td>
        <td><span class="pill" data-status="${agent.status}">${esc(agent.status)}</span></td>
        <td class="num optional">${duration}</td>
        <td class="num optional">${compact(agent.usage.inputTokens + agent.usage.outputTokens)}</td>
        <td class="num optional">${ago(agent.createdAt)}</td>
      </tr>`;
    })
    .join('');
  return `<table class="table"><thead><tr><th>Worker</th><th>Task</th><th class="optional">Project</th><th>Runs on</th><th>Status</th><th class="optional">Time</th><th class="optional">Tokens</th><th class="optional">Started</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderView() {
  const view = $('view');
  const html = S.view === 'workers' ? workersHtml() : overviewHtml();
  const next = template(`<div data-mode="${S.view}">${html}</div>`);
  if (view.firstElementChild?.dataset.mode === S.view) morph(view.firstElementChild, next);
  else view.replaceChildren(next);
  if (S.view !== 'overview' || !view.querySelector('#projects')) return;

  const projects = [...S.projects.values()].filter((p) => p.status !== 'archived');
  const cards = (list) => list.map((project) => ({ key: project.id, html: projectHtml(project) }));
  patch(view.querySelector('#needs'), needHtml());
  patch(view.querySelector('#running'), activeAgents().map((agent) => ({ key: agent.id, html: workerCardHtml(agent) })));
  patch(
    view.querySelector('#projects'),
    cards(projects.filter((p) => p.status !== 'done').sort((a, b) => b.createdAt - a.createdAt)),
  );
  patch(
    view.querySelector('#finished'),
    cards(projects.filter((p) => p.status === 'done').sort((a, b) => b.updatedAt - a.updatedAt)),
  );
}

// ── Worker drawer ────────────────────────────────────────────────────────────
function timelineItems(drawer, agent) {
  const items = [];
  const calls = new Map();
  for (const event of drawer.events) {
    const key = `e${event.seq}`;
    switch (event.type) {
      case 'prompt':
        items.push({
          key,
          html: `<div class="ev-prompt"><span class="ev-label">${event.from === 'user' ? 'You' : esc(S.config?.pm.name ?? 'Manager')} · brief</span><p>${esc(event.text)}</p></div>`,
        });
        break;
      case 'text':
        items.push({ key, html: `<div class="ev-text md">${renderMarkdown(event.text)}</div>` });
        break;
      case 'thinking':
        items.push({ key, html: `<div class="ev-think">${esc(event.text)}</div>` });
        break;
      case 'tool_call': {
        const item = { key, call: event, result: null };
        calls.set(event.id, item);
        items.push(item);
        break;
      }
      case 'tool_result': {
        const item = calls.get(event.id);
        if (item) item.result = event;
        break;
      }
      case 'note':
        items.push({ key, html: `<div class="ev-note">${esc(event.text)}</div>` });
        break;
      case 'status':
        items.push({
          key,
          html: `<div class="ev-status" data-status="${esc(event.status)}"><i class="dot" data-status="${esc(event.status)}"></i><span>${esc(event.text ?? event.status)} · ${esc(stamp(event.ts))}</span></div>`,
        });
        break;
      default:
        break;
    }
  }
  const settled = !ACTIVE.has(agent.status);
  for (const item of items) {
    if (!item.call) continue;
    const { call, result } = item;
    const state = result ? (result.isError ? 'error' : 'ok') : settled ? 'ok' : 'running';
    const glyph = state === 'running' ? 'spinner' : state === 'error' ? 'x' : 'check';
    const input = JSON.stringify(call.input ?? {}, null, 2);
    item.html = `<details class="ev-tool" data-state="${state}" data-sub="${Boolean(call.sub)}">
      <summary>${icon(glyph)}<b>${esc(call.name)}</b><span>${esc(toolSummary(call, agent.cwd))}</span></summary>
      <div class="ev-tool-body">
        ${input !== '{}' ? `<div class="code">${esc(input)}</div>` : ''}
        ${result?.output ? `<div class="code">${esc(result.output)}</div>` : ''}
      </div>
    </details>`;
  }
  if (drawer.delta) items.push({ key: 'delta', html: `<div class="ev-text md">${renderMarkdown(drawer.delta)}</div>` });
  return items.map(({ key, html }) => ({ key, html }));
}

function renderDrawer() {
  const el = $('drawer');
  const drawer = S.drawer;
  const agent = drawer && S.agents.get(drawer.agentId);
  el.hidden = !agent;
  $('scrim').hidden = !agent || window.innerWidth >= 1280;
  if (!agent) {
    el.__agent = null;
    return;
  }
  const task = S.tasks.get(agent.taskId);
  const project = S.projects.get(agent.projectId);
  const active = ACTIVE.has(agent.status);
  const tokens = agent.usage.inputTokens + agent.usage.outputTokens;

  if (el.__agent !== agent.id) {
    el.__agent = agent.id;
    el.innerHTML = `<div class="drawer-head" id="drawer-head"></div>
      <div class="drawer-scroll" id="drawer-scroll"><div class="timeline" id="timeline"></div></div>
      <form class="drawer-foot" id="drawer-form">
        <input id="drawer-input" autocomplete="off" aria-label="Message this worker" />
        <button class="btn" type="submit">Send</button>
        <button class="btn danger" type="button" id="drawer-stop" data-action="stop-agent" data-id="${agent.id}">Stop</button>
      </form>`;
  }

  const head = `<div><div class="drawer-title">
      <i class="dot" data-status="${agent.status}"></i><h2>${esc(agent.name)}</h2>
      <span class="pill" data-status="${agent.status}">${esc(agent.status)}</span>
      <button class="icon-btn" data-action="close-drawer" aria-label="Close">${icon('x')}</button>
    </div>
    <p class="drawer-sub">${esc(task?.title ?? '')} · ${esc(project?.name ?? '')}</p>
    <div class="meta">
      ${chip(agent.provider)}
      ${agent.model ? `<span>${esc(agent.model)}</span>` : ''}
      <span title="Autonomy">${icon('shield')}${esc(agent.autonomy)}</span>
      <span title="Time">${icon('clock')}${
        active
          ? `<time data-since="${agent.startedAt ?? ''}"></time>`
          : agent.startedAt && agent.endedAt
            ? elapsed(agent.endedAt - agent.startedAt)
            : '–'
      }</span>
      <span title="Steps">${icon('terminal')}${agent.toolCalls} steps</span>
      <span title="Tokens in and out">${icon('bolt')}${compact(tokens)} tokens</span>
      ${agent.turns > 1 ? `<span title="Turns">${icon('loop')}${agent.turns} turns</span>` : ''}
    </div>
    ${agent.error && !active ? `<div class="msg-error" style="margin-top:12px">${esc(agent.error)}</div>` : ''}</div>`;
  const headEl = $('drawer-head');
  if (headEl.__html !== head) {
    headEl.__html = head;
    if (headEl.firstElementChild) morph(headEl.firstElementChild, template(head));
    else headEl.innerHTML = head;
  }

  const scroller = $('drawer-scroll');
  const pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  patch($('timeline'), timelineItems(drawer, agent));
  if (pinned) scroller.scrollTop = scroller.scrollHeight;

  $('drawer-stop').hidden = !active;
  const input = $('drawer-input');
  input.placeholder = active ? `Add a note for ${agent.name}…` : `Send ${agent.name} a follow-up…`;
  input.title = active
    ? 'Delivered when the worker finishes its current turn'
    : 'The worker resumes with everything it already knows';
}

async function openAgent(agentId) {
  if (!S.agents.has(agentId)) return;
  S.drawer = { agentId, events: [], delta: '' };
  render();
  try {
    const { events } = await api('GET', `/api/agents/${agentId}/events`);
    if (S.drawer?.agentId !== agentId) return;
    const seen = new Set(events.map((e) => e.seq));
    S.drawer.events = [...events, ...S.drawer.events.filter((e) => !seen.has(e.seq))];
    render();
    const scroller = $('drawer-scroll');
    scroller.scrollTop = scroller.scrollHeight;
  } catch (error) {
    console.error(error);
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────
function openSettings() {
  const { pm, workers } = S.config;
  const providerOptions = (selected) =>
    Object.values(S.providers)
      .map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.label)}</option>`)
      .join('');
  const providerRows = Object.values(S.providers)
    .map((p) => {
      const state = !p.installed ? 'failed' : p.loggedIn ? 'done' : 'waiting';
      const windows = Object.entries(S.rateLimits[p.id]?.windows ?? {})
        .map(([name, w]) => `${Math.round((w.utilization ?? 0) * 100)}% of ${name.replace(/_/g, ' ')}`)
        .join(' · ');
      return `<div class="provider-row"><i class="dot" data-status="${state}"></i><div>
        <b>${esc(p.label)}${p.version ? ` <small>${/^\d/.test(p.version) ? 'v' : ''}${esc(p.version)}</small>` : ''}</b>
        <small>${esc(!p.installed ? 'Not installed' : p.loggedIn ? `Signed in${p.detail ? ` · ${p.detail}` : ''}` : 'Not signed in')}${windows ? ` · ${esc(windows)} used` : ''}</small>
        ${p.fix ? `<br><small>${esc(p.fix)}</small>` : ''}
      </div></div>`;
    })
    .join('');

  $('modal-root').innerHTML = `<div class="modal-wrap" data-action="close-modal-outside">
    <form class="modal" id="settings-form">
      <div class="modal-head"><h2>Settings</h2><button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">${icon('x')}</button></div>
      <div class="modal-body">
        <div class="fieldset">
          <h3>Subscriptions</h3>
          <p>QuietQuest drives the official Claude Code and Codex command-line tools with the logins you already have. It never sees your credentials.</p>
          ${providerRows}
          <div style="margin-top:10px"><button class="btn" type="button" data-action="refresh-providers">Check again</button></div>
        </div>
        <div class="fieldset">
          <h3>Manager</h3>
          <p>The one agent you talk to.</p>
          <div class="fields">
            <label class="field">Name<input name="pm.name" value="${esc(pm.name)}" maxlength="24" /></label>
            <label class="field">Runs on<select name="pm.provider">${providerOptions(pm.provider)}</select></label>
            <label class="field">Model (blank for the CLI default)<input name="pm.model" value="${esc(pm.model)}" placeholder="default" /></label>
          </div>
        </div>
        <div class="fieldset">
          <h3>Workers</h3>
          <p>Defaults for the agents the manager starts. It can still choose differently per task.</p>
          <div class="fields">
            <label class="field">Run on<select name="workers.provider">${providerOptions(workers.provider)}</select></label>
            <label class="field">Model (blank for the CLI default)<input name="workers.model" value="${esc(workers.model)}" placeholder="default" /></label>
            <label class="field">Autonomy<select name="workers.autonomy">
              ${[
                ['read', 'Read only'],
                ['edit', 'Edit files, ask for the rest'],
                ['full', 'Full access, never ask'],
              ]
                .map(([value, label]) => `<option value="${value}" ${workers.autonomy === value ? 'selected' : ''}>${label}</option>`)
                .join('')}
            </select></label>
            <label class="field">Workers at once<input name="workers.maxConcurrent" type="number" min="1" max="16" value="${workers.maxConcurrent}" /></label>
            <label class="field">New workers per hour, at most<input name="workers.maxSpawnsPerHour" type="number" min="1" max="200" value="${workers.maxSpawnsPerHour}" /></label>
          </div>
        </div>
        <div class="fieldset">
          <h3>Memory</h3>
          <p>What the manager remembers about you across projects. Edit freely.</p>
          <textarea name="memory" spellcheck="false">${esc(S.memory)}</textarea>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" type="button" data-action="close-modal">Cancel</button>
        <button class="btn primary" type="submit">Save</button>
      </div>
    </form>
  </div>`;
}

const closeModal = () => ($('modal-root').innerHTML = '');

// ── Render loop ──────────────────────────────────────────────────────────────
let scheduled = false;
function render() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (!S.loaded) return;
    renderChat();
    renderTopbar();
    renderView();
    renderDrawer();
    tick();
  });
}

function tick() {
  for (const el of document.querySelectorAll('time[data-since]')) {
    const since = Number(el.dataset.since);
    if (since) el.textContent = elapsed(Date.now() - since);
  }
}
setInterval(tick, 1000);

// ── Live updates ─────────────────────────────────────────────────────────────
function upsertChat(message) {
  const index = S.chat.findIndex((m) => m.id === message.id);
  if (index >= 0) S.chat[index] = message;
  else S.chat.push(message);
  // A fresh copy of the message already contains whatever the live fragment was showing.
  if (S.chatDelta?.id === message.id) S.chatDelta = null;
}

const handlers = {
  project: (data) => S.projects.set(data.id, data),
  task: (data) => S.tasks.set(data.id, data),
  agent: (data) => S.agents.set(data.id, data),
  approval: (data) => (data.status === 'pending' ? S.approvals.set(data.id, data) : S.approvals.delete(data.id)),
  chat: upsertChat,
  chat_delta: (data) => (S.chatDelta = data.text ? data : null),
  manager: (data) => (S.manager = data),
  providers: (data) => (S.providers = data),
  config: (data) => (S.config = data),
  memory: (data) => (S.memory = data.text),
  rate_limit: (data) => (S.rateLimits[data.provider] = data),
  agent_event: ({ agentId, event }) => {
    if (S.drawer?.agentId !== agentId) return;
    if (!S.drawer.events.some((e) => e.seq === event.seq)) S.drawer.events.push(event);
    if (event.type === 'text') S.drawer.delta = '';
  },
  agent_delta: ({ agentId, text }) => {
    if (S.drawer?.agentId === agentId) S.drawer.delta += text;
  },
};

async function load() {
  const state = await api('GET', '/api/state');
  S.config = state.config;
  S.home = state.home;
  S.demo = state.demo;
  S.providers = state.providers;
  S.manager = state.manager;
  S.memory = state.memory;
  S.rateLimits = state.rateLimits ?? {};
  S.chat = state.chat;
  S.projects = new Map(state.projects.map((p) => [p.id, p]));
  S.tasks = new Map(state.tasks.map((t) => [t.id, t]));
  S.agents = new Map(state.agents.map((a) => [a.id, a]));
  S.approvals = new Map(state.approvals.map((a) => [a.id, a]));
  S.loaded = true;
  render();
  requestAnimationFrame(() => {
    const scroller = $('chat-scroll');
    scroller.scrollTop = scroller.scrollHeight;
  });
}

function connect() {
  const source = new EventSource('/api/events');
  source.onopen = () => {
    // Anything missed while disconnected is picked up by reloading the snapshot.
    if (!S.connected || !S.loaded) load().catch(console.error);
    S.connected = true;
    render();
  };
  source.onmessage = (message) => {
    const { type, data } = JSON.parse(message.data);
    handlers[type]?.(data);
    render();
  };
  source.onerror = () => {
    S.connected = false;
    render();
  };
}

// ── Interaction ──────────────────────────────────────────────────────────────
const composer = $('composer-input');

function autosize() {
  composer.style.height = 'auto';
  composer.style.height = `${Math.min(composer.scrollHeight, 180)}px`;
  $('composer-send').disabled = !composer.value.trim();
}

async function sendChat() {
  const text = composer.value.trim();
  if (!text) return;
  composer.value = '';
  autosize();
  try {
    await api('POST', '/api/chat', { text });
    const scroller = $('chat-scroll');
    requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
  } catch (error) {
    composer.value = text;
    autosize();
    alert(error.message);
  }
}

composer.addEventListener('input', autosize);
composer.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendChat();
  }
});
$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  sendChat();
});
$('pm-stop').addEventListener('click', () => api('POST', '/api/manager/stop', {}).catch(console.error));
$('theme-toggle').addEventListener('click', () => {
  const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('qq-theme', next);
  } catch {}
  render();
});
$('open-settings').addEventListener('click', openSettings);
$('scrim').addEventListener('click', () => {
  S.drawer = null;
  render();
});

document.addEventListener('submit', async (event) => {
  if (event.target.id === 'drawer-form') {
    event.preventDefault();
    const input = $('drawer-input');
    const text = input.value.trim();
    if (!text || !S.drawer) return;
    input.value = '';
    try {
      await api('POST', `/api/agents/${S.drawer.agentId}/message`, { text });
    } catch (error) {
      input.value = text;
      alert(error.message);
    }
  }
  if (event.target.id === 'settings-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    const body = { pm: {}, workers: {} };
    for (const [key, value] of form.entries()) {
      const [section, field] = key.split('.');
      if (field) body[section][field] = value;
    }
    try {
      await api('POST', '/api/settings', body);
      await api('POST', '/api/memory', { text: form.get('memory') });
      closeModal();
    } catch (error) {
      alert(error.message);
    }
  }
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const { action, id } = target.dataset;
  try {
    switch (action) {
      case 'view':
        S.view = target.dataset.view;
        render();
        break;
      case 'pane':
        $('app').dataset.pane = target.dataset.pane;
        break;
      case 'open-agent':
        await openAgent(id);
        break;
      case 'close-drawer':
        S.drawer = null;
        render();
        break;
      case 'stop-agent':
        await api('POST', `/api/agents/${id}/stop`, {});
        break;
      case 'approve':
        target.disabled = true;
        await api('POST', `/api/approvals/${id}`, {
          decision: target.dataset.decision,
          always: Boolean(target.dataset.always),
        });
        break;
      case 'reply':
        $('app').dataset.pane = 'chat';
        composer.value = target.dataset.text;
        autosize();
        composer.focus();
        composer.setSelectionRange(composer.value.length, composer.value.length);
        break;
      case 'settings':
        openSettings();
        break;
      case 'refresh-providers':
        target.disabled = true;
        target.textContent = 'Checking…';
        S.providers = await api('POST', '/api/providers/refresh', {});
        openSettings();
        render();
        break;
      case 'close-modal':
        closeModal();
        break;
      case 'close-modal-outside':
        if (event.target === target) closeModal();
        break;
      default:
        break;
    }
  } catch (error) {
    alert(error.message);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if ($('modal-root').firstChild) closeModal();
  else if (S.drawer) {
    S.drawer = null;
    render();
  }
});
window.addEventListener('resize', render);

autosize();
load().catch(console.error);
connect();
