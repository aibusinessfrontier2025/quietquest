import fs from 'node:fs';
import path from 'node:path';
import { managerSystemPrompt, managerTurnPrompt } from './prompts.js';
import { oneLine, shortPath } from './util.js';

const TOOL_PREFIX = /^(mcp__quietquest__|quietquest[._])/;

/** Turns a manager tool call into the short line shown in the chat. */
function describeAction(store, tool, input) {
  const task = input.task_id ? store.state.tasks[input.task_id] : null;
  const worker = input.worker_id ? store.state.agents[input.worker_id] : null;
  const project = input.project_id ? store.state.projects[input.project_id] : null;
  switch (tool) {
    case 'create_project':
      return `Created project “${input.name}”`;
    case 'update_project':
      if (input.status) return `Marked ${project?.name ?? 'project'} ${input.status}`;
      return `Updated ${project?.name ?? 'project'}${input.notes !== undefined ? ' notes' : ''}`;
    case 'create_tasks':
      return `Added ${input.tasks?.length ?? 0} task${input.tasks?.length === 1 ? '' : 's'}${project ? ` to ${project.name}` : ''}`;
    case 'update_task':
      if (input.status) return `Marked “${task?.title ?? 'task'}” ${input.status.replace('_', ' ')}`;
      return `Updated “${task?.title ?? 'task'}”`;
    case 'spawn_worker':
      return `Started ${input.name || 'a worker'} on “${task?.title ?? 'task'}”`;
    case 'message_worker':
      return `Sent ${worker?.name ?? 'worker'} a follow-up`;
    case 'stop_worker':
      return `Stopped ${worker?.name ?? 'worker'}`;
    case 'get_worker':
      return `Checked on ${worker?.name ?? 'a worker'}`;
    case 'get_project':
    case 'list_projects':
      return 'Checked the board';
    case 'remember':
    case 'rewrite_memory':
      return 'Updated memory';
    default: {
      const detail = input.query ?? (input.file_path ? shortPath(input.file_path) : null) ?? input.pattern ?? input.url ?? '';
      return oneLine(`${tool}${detail ? ` · ${detail}` : ''}`, 80);
    }
  }
}

/**
 * The single conversation. User messages and worker reports queue up here and are handled
 * one manager turn at a time; anything that arrives mid-turn is batched into the next one.
 */
export class Manager {
  constructor({ store, providers, tools, bridge }) {
    this.store = store;
    this.providers = providers;
    this.tools = tools;
    this.bridge = bridge;
    this.queue = [];
    this.busy = false;
    this.handle = null;
  }

  status() {
    return { busy: this.busy, queued: this.queue.length };
  }

  /** A message typed by the user. */
  submit(text) {
    const message = this.store.addChat({ role: 'user', text });
    this.queue.push({ kind: 'user', text });
    this.drain();
    return message;
  }

  /** A worker stopped; show it in the conversation and let the manager review it. */
  notify(item) {
    this.store.addChat({
      role: 'event',
      agentId: item.agentId,
      outcome: item.ok ? 'done' : item.stopped ? 'stopped' : 'failed',
      text: `${item.name} ${item.ok ? 'finished' : item.stopped ? 'was stopped on' : 'failed on'} “${item.title}”`,
    });
    this.queue.push(item);
    this.drain();
  }

  stop() {
    this.handle?.stop();
  }

  /** Process is exiting: end the current turn and start no more. */
  async shutdown() {
    this.closing = true;
    this.stop();
    await this.turn;
  }

  drain() {
    if (this.closing || this.busy || !this.queue.length) return;
    const items = this.queue.splice(0);
    this.busy = true;
    this.store.broadcast('manager', this.status());
    this.turn = this.#turn(items)
      .catch((error) => {
        console.error('[quietquest] manager turn crashed:', error);
        this.store.addChat({ role: 'error', text: `Manager turn crashed: ${error.message}` });
      })
      .finally(() => {
        this.busy = false;
        this.handle = null;
        this.store.broadcast('manager', this.status());
        setImmediate(() => this.drain());
      });
  }

  #mcp() {
    const mcp = this.bridge.spec({ role: 'pm' });
    const file = path.join(this.store.paths.runtime, 'mcp-pm.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { quietquest: mcp } }), { mode: 0o600 });
    return { mcp, mcpConfigPath: file };
  }

  async #turn(items) {
    const { store } = this;
    const config = store.config.pm;
    const provider = this.providers.get(config.provider);
    const prompt = managerTurnPrompt({ state: store.state, memory: store.getMemory(), items });
    // A session id only means something to the provider that issued it.
    const resumeId = store.state.pm.provider === provider.id ? store.state.pm.sessionId : null;

    const message = store.addChat({ role: 'pm', parts: [], streaming: true });
    let produced = false;

    const onEvent = (event) => {
      const parts = message.parts;
      const last = parts[parts.length - 1];
      switch (event.type) {
        case 'session':
          store.state.pm = { ...store.state.pm, sessionId: event.sessionId, provider: provider.id };
          store.save();
          break;
        case 'text_delta':
          produced = true;
          this.pendingText = (this.pendingText ?? '') + event.text;
          store.broadcast('chat_delta', { id: message.id, text: this.pendingText });
          break;
        case 'text':
          produced = true;
          this.pendingText = '';
          if (last?.type === 'text') last.text += `\n\n${event.text}`;
          else parts.push({ type: 'text', text: event.text });
          store.patchChat(message, {});
          break;
        case 'tool_call': {
          produced = true;
          const tool = event.name.replace(TOOL_PREFIX, '');
          parts.push({
            type: 'action',
            id: event.id,
            tool,
            label: describeAction(store, tool, event.input ?? {}),
            state: 'running',
          });
          store.patchChat(message, {});
          break;
        }
        case 'tool_result': {
          const action = parts.find((p) => p.type === 'action' && p.id === event.id);
          if (action) {
            action.state = event.isError ? 'error' : 'ok';
            if (event.isError) action.detail = oneLine(event.output, 200);
            try {
              const output = JSON.parse(event.output);
              if (output.worker_id) action.agentId = output.worker_id;
              if (action.tool === 'create_project' && output.id) action.projectId = output.id;
            } catch {
              // lookups return prose; nothing to link
            }
            store.patchChat(message, {});
          }
          break;
        }
        case 'rate_limit':
          store.setRateLimit(provider.id, event);
          break;
        default:
          break;
      }
    };

    const run = (sessionId) => {
      this.pendingText = '';
      this.handle = provider.run({
        role: 'pm',
        prompt,
        cwd: store.paths.pm,
        sessionId,
        model: config.model,
        systemPrompt: managerSystemPrompt({
          name: config.name,
          providers: this.providers.ids().map((id) => this.providers.get(id).label),
        }),
        addDirs: this.#projectDirs(),
        ...(provider.isMock ? {} : this.#mcp()),
        meta: { items },
        callTool: async (name, args) => {
          const result = await this.tools.call('pm', name, args);
          if (result.isError) throw new Error(result.text);
          return result.value;
        },
        onEvent,
      });
      return this.handle.done;
    };

    let outcome = await run(resumeId);
    if (!outcome.ok && !outcome.stopped && resumeId && !produced) {
      // The saved session is gone (cleared history, new machine). The board carries the state, so start fresh.
      store.state.pm = { ...store.state.pm, sessionId: null };
      outcome = await run(null);
    }
    this.pendingText = '';

    for (const part of message.parts) {
      if (part.type === 'action' && part.state === 'running') part.state = outcome.ok ? 'ok' : 'error';
    }
    const hasText = message.parts.some((p) => p.type === 'text');
    if (outcome.ok && !hasText && outcome.text) message.parts.push({ type: 'text', text: outcome.text });

    if (outcome.ok || outcome.stopped) {
      store.finalizeChat(message, outcome.stopped ? { stopped: true } : {});
    } else {
      store.finalizeChat(message, {});
      const hint = this.providers.status()[provider.id]?.fix;
      store.addChat({
        role: 'error',
        text: `${provider.label} could not complete that turn: ${outcome.error}${hint ? `\n\n${hint}` : ''}`,
      });
    }
  }

  #projectDirs() {
    const dirs = new Set([this.store.paths.workspaces]);
    for (const project of Object.values(this.store.state.projects)) {
      if (project.status === 'active' && fs.existsSync(project.dir)) dirs.add(project.dir);
    }
    return [...dirs].slice(0, 12);
  }
}
