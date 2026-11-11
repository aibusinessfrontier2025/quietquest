import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId, now, slugify } from './util.js';

export const DEFAULT_CONFIG = {
  port: 4747,
  pm: {
    name: 'Chief',
    provider: 'claude',
    model: '',
  },
  workers: {
    provider: 'claude',
    model: '',
    autonomy: 'edit',
    maxConcurrent: 4,
    maxSpawnsPerHour: 30,
  },
  providers: {
    claude: {
      bin: 'claude',
      // false = strip ANTHROPIC_API_KEY so the CLI bills your subscription login.
      useApiKey: false,
    },
    codex: {
      bin: 'codex',
      // false = strip OPENAI_API_KEY so the CLI bills your ChatGPT login.
      useApiKey: false,
    },
  },
};

export const TASK_STATUSES = ['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled'];
export const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'];
export const AUTONOMY_LEVELS = ['read', 'edit', 'full'];

function mergeDeep(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? mergeDeep(base?.[key] ?? {}, value)
        : value;
  }
  return out;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * All durable state lives in plain files under one home directory:
 *   config.json, state.json, chat.jsonl, memory.md, agents/<id>.jsonl, workspaces/<slug>/
 * Every mutation emits a `broadcast` event that the HTTP layer relays to the dashboard.
 */
export class Store extends EventEmitter {
  constructor(home) {
    super();
    this.home = home || process.env.QUIETQUEST_HOME || path.join(os.homedir(), '.quietquest');
    this.paths = {
      config: path.join(this.home, 'config.json'),
      state: path.join(this.home, 'state.json'),
      chat: path.join(this.home, 'chat.jsonl'),
      memory: path.join(this.home, 'memory.md'),
      agents: path.join(this.home, 'agents'),
      workspaces: path.join(this.home, 'workspaces'),
      runtime: path.join(this.home, 'runtime'),
      pm: path.join(this.home, 'pm'),
    };
    for (const dir of [this.home, this.paths.agents, this.paths.workspaces, this.paths.runtime, this.paths.pm]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.config = mergeDeep(DEFAULT_CONFIG, readJson(this.paths.config, {}));
    const state = readJson(this.paths.state, {});
    this.state = {
      projects: state.projects || {},
      tasks: state.tasks || {},
      agents: state.agents || {},
      approvals: state.approvals || {},
      pm: state.pm || { sessionId: null, provider: null },
      spawnLog: state.spawnLog || [],
    };
    this.chat = this.#loadChat();
    // Latest subscription usage each CLI reported; kept in memory only.
    this.rateLimits = {};
    this.eventSeq = new Map();
    this.saveTimer = null;
  }

  #loadChat() {
    let text = '';
    try {
      text = fs.readFileSync(this.paths.chat, 'utf8');
    } catch {
      return [];
    }
    const messages = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        // A torn final line after a crash is not worth failing startup over.
      }
    }
    return messages;
  }

  broadcast(type, data) {
    this.emit('broadcast', { type, data });
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 120);
    this.saveTimer.unref?.();
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    writeAtomic(this.paths.state, JSON.stringify(this.state, null, 1));
  }

  // ── config ────────────────────────────────────────────────────────────────
  updateConfig(patch) {
    this.config = mergeDeep(this.config, patch);
    writeAtomic(this.paths.config, JSON.stringify(this.config, null, 2));
    this.broadcast('config', this.config);
    return this.config;
  }

  setRateLimit(provider, { status, windows }) {
    this.rateLimits[provider] = { provider, status, windows, at: now() };
    this.broadcast('rate_limit', this.rateLimits[provider]);
  }

  // ── memory ────────────────────────────────────────────────────────────────
  getMemory() {
    try {
      return fs.readFileSync(this.paths.memory, 'utf8');
    } catch {
      return '';
    }
  }

  setMemory(text) {
    writeAtomic(this.paths.memory, text);
    this.broadcast('memory', { text });
  }

  // ── projects ──────────────────────────────────────────────────────────────
  createProject({ name, goal = '', dir = '' }) {
    const id = newId('p');
    let workdir = dir ? path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir())) : '';
    if (!workdir) {
      const base = slugify(name);
      let slug = base;
      for (let n = 2; fs.existsSync(path.join(this.paths.workspaces, slug)); n++) slug = `${base}-${n}`;
      workdir = path.join(this.paths.workspaces, slug);
    }
    fs.mkdirSync(workdir, { recursive: true });
    const project = {
      id,
      name,
      goal,
      notes: '',
      status: 'active',
      dir: workdir,
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.projects[id] = project;
    this.save();
    this.broadcast('project', project);
    return project;
  }

  updateProject(id, patch) {
    const project = this.state.projects[id];
    if (!project) throw new Error(`No project with id ${id}`);
    Object.assign(project, patch, { updatedAt: now() });
    this.save();
    this.broadcast('project', project);
    return project;
  }

  // ── tasks ─────────────────────────────────────────────────────────────────
  createTask({ projectId, title, description = '', dependsOn = [] }) {
    if (!this.state.projects[projectId]) throw new Error(`No project with id ${projectId}`);
    const task = {
      id: newId('t'),
      projectId,
      title,
      description,
      dependsOn,
      status: 'todo',
      result: '',
      blocker: '',
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.tasks[task.id] = task;
    this.save();
    this.broadcast('task', task);
    return task;
  }

  updateTask(id, patch) {
    const task = this.state.tasks[id];
    if (!task) throw new Error(`No task with id ${id}`);
    Object.assign(task, patch, { updatedAt: now() });
    this.save();
    this.broadcast('task', task);
    return task;
  }

  // ── agents ────────────────────────────────────────────────────────────────
  putAgent(agent) {
    this.state.agents[agent.id] = agent;
    this.save();
    this.broadcast('agent', agent);
    return agent;
  }

  updateAgent(id, patch) {
    const agent = this.state.agents[id];
    if (!agent) throw new Error(`No worker with id ${id}`);
    Object.assign(agent, patch, { updatedAt: now() });
    this.save();
    this.broadcast('agent', agent);
    return agent;
  }

  #agentLog(id) {
    return path.join(this.paths.agents, `${id}.jsonl`);
  }

  appendAgentEvent(agentId, event) {
    const seq = (this.eventSeq.get(agentId) ?? this.readAgentEvents(agentId).length) + 1;
    this.eventSeq.set(agentId, seq);
    const record = { seq, ts: now(), ...event };
    fs.appendFileSync(this.#agentLog(agentId), `${JSON.stringify(record)}\n`);
    this.broadcast('agent_event', { agentId, event: record });
    return record;
  }

  readAgentEvents(agentId) {
    let text = '';
    try {
      text = fs.readFileSync(this.#agentLog(agentId), 'utf8');
    } catch {
      return [];
    }
    const events = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip torn line
      }
    }
    return events;
  }

  // ── approvals ─────────────────────────────────────────────────────────────
  putApproval(approval) {
    this.state.approvals[approval.id] = approval;
    this.save();
    this.broadcast('approval', approval);
    return approval;
  }

  // ── chat ──────────────────────────────────────────────────────────────────
  /** Adds a message. Streaming messages stay in memory until `finalizeChat`. */
  addChat(message) {
    const full = { id: newId('m'), ts: now(), ...message };
    this.chat.push(full);
    if (!full.streaming) fs.appendFileSync(this.paths.chat, `${JSON.stringify(full)}\n`);
    this.broadcast('chat', full);
    return full;
  }

  patchChat(message, patch) {
    Object.assign(message, patch);
    this.broadcast('chat', message);
  }

  finalizeChat(message, patch = {}) {
    Object.assign(message, patch);
    delete message.streaming;
    fs.appendFileSync(this.paths.chat, `${JSON.stringify(message)}\n`);
    this.broadcast('chat', message);
  }

  // ── snapshot for the dashboard ────────────────────────────────────────────
  snapshot() {
    return {
      config: this.config,
      home: this.home,
      projects: Object.values(this.state.projects),
      tasks: Object.values(this.state.tasks),
      agents: Object.values(this.state.agents),
      approvals: Object.values(this.state.approvals).filter((a) => a.status === 'pending'),
      chat: this.chat.slice(-400),
      memory: this.getMemory(),
      rateLimits: this.rateLimits,
    };
  }
}
