import fs from 'node:fs';
import path from 'node:path';
import { AUTONOMY_LEVELS } from './store.js';
import { WORKER_SYSTEM_PROMPT, workerPrompt } from './prompts.js';
import { newId, now, oneLine, shortPath } from './util.js';

const ACTIVE = new Set(['queued', 'running', 'waiting']);

function describeToolCall(event, cwd = '') {
  const input = event.input ?? {};
  const file = input.file_path ?? input.path;
  const detail =
    input.command ?? (file ? shortPath(file, cwd) : null) ?? input.pattern ?? input.query ?? input.url ?? input.description ?? '';
  return oneLine(`${event.name}${detail ? ` · ${detail}` : ''}`, 120);
}

/**
 * Owns every worker's lifecycle: queueing under the concurrency limit, running one CLI
 * turn at a time, recording its events, routing approvals, and reporting back when it stops.
 */
export class Workers {
  constructor({ store, providers, bridge, onFinished }) {
    this.store = store;
    this.providers = providers;
    this.bridge = bridge;
    this.onFinished = onFinished;
    this.running = new Map(); // agentId → run handle
    this.pendingApprovals = new Map(); // approvalId → resolve
  }

  get config() {
    return this.store.config.workers;
  }

  /** After a restart no child processes survive; say so instead of showing them as running. */
  recover() {
    for (const agent of Object.values(this.store.state.agents)) {
      if (agent.status === 'running' || agent.status === 'waiting') {
        this.store.updateAgent(agent.id, {
          status: 'interrupted',
          endedAt: now(),
          error: 'QuietQuest restarted while this worker was running. Send it a message to resume.',
        });
      }
    }
    for (const approval of Object.values(this.store.state.approvals)) {
      if (approval.status === 'pending') this.store.putApproval({ ...approval, status: 'expired', resolvedAt: now() });
    }
    this.pump();
  }

  spawn({ taskId, name, instructions, provider, model, autonomy, mock }) {
    const task = this.store.state.tasks[taskId];
    if (!task) throw new Error(`No task with id ${taskId}`);
    const project = this.store.state.projects[task.projectId];
    if (!instructions?.trim()) throw new Error('instructions are required: the worker sees nothing else');

    const providerId = provider || this.config.provider;
    this.providers.get(providerId);
    const level = autonomy || this.config.autonomy;
    if (!AUTONOMY_LEVELS.includes(level)) {
      throw new Error(`autonomy must be one of: ${AUTONOMY_LEVELS.join(', ')}`);
    }

    const hourAgo = now() - 60 * 60 * 1000;
    const recent = this.store.state.spawnLog.filter((ts) => ts > hourAgo);
    if (recent.length >= this.config.maxSpawnsPerHour) {
      throw new Error(
        `Spawn limit reached (${this.config.maxSpawnsPerHour} workers per hour). ` +
          'Tell the user; they can raise the limit in Settings.',
      );
    }
    this.store.state.spawnLog = [...recent, now()];

    const agent = this.store.putAgent({
      id: newId('a'),
      name: name?.trim() || 'Worker',
      taskId,
      projectId: project.id,
      provider: providerId,
      model: model || (providerId === this.config.provider ? this.config.model : '') || '',
      autonomy: level,
      cwd: project.dir,
      status: 'queued',
      sessionId: null,
      turns: 0,
      nextPrompt: workerPrompt({ project, task, instructions }),
      activity: 'Waiting for a free slot',
      result: '',
      error: '',
      toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      autoAllow: [],
      createdAt: now(),
      updatedAt: now(),
      ...(mock && { mock }),
    });
    this.store.appendAgentEvent(agent.id, { type: 'prompt', text: instructions, from: 'manager' });
    if (task.status !== 'in_progress') this.store.updateTask(taskId, { status: 'in_progress', blocker: '' });
    this.pump();
    return agent;
  }

  /** Follow-up to a worker. Finished workers resume their session; busy ones get it next. */
  message(agentId, text, from = 'manager') {
    const agent = this.store.state.agents[agentId];
    if (!agent) throw new Error(`No worker with id ${agentId}`);
    if (!text?.trim()) throw new Error('message text is required');
    this.store.appendAgentEvent(agentId, { type: 'prompt', text, from });
    if (ACTIVE.has(agent.status)) {
      this.store.updateAgent(agentId, { nextPrompt: [agent.nextPrompt, text].filter(Boolean).join('\n\n') });
      return { queued: true, note: 'Worker is busy; the message will be delivered when its current turn ends.' };
    }
    this.store.updateAgent(agentId, {
      status: 'queued',
      nextPrompt: text,
      activity: 'Waiting for a free slot',
      error: '',
      endedAt: null,
    });
    const task = this.store.state.tasks[agent.taskId];
    if (task && task.status !== 'in_progress') this.store.updateTask(task.id, { status: 'in_progress' });
    this.pump();
    return { queued: true };
  }

  stop(agentId, by = 'user') {
    const agent = this.store.state.agents[agentId];
    if (!agent) throw new Error(`No worker with id ${agentId}`);
    if (!ACTIVE.has(agent.status)) return agent;
    agent.stoppedBy = by;
    const handle = this.running.get(agentId);
    if (handle) {
      this.#expireApprovals(agentId);
      handle.stop();
    } else {
      // Still queued: it never started, so there is nothing to kill.
      this.#finish(agent, { ok: false, stopped: true, error: 'Stopped' });
    }
    return agent;
  }

  /** Process is exiting: stop every child and wait until each has been recorded as interrupted. */
  async shutdown() {
    this.closing = true;
    const settled = [...this.running.values()].map((handle) => handle.settled);
    for (const [agentId, handle] of this.running) {
      // A worker parked on an approval would otherwise never return.
      this.#expireApprovals(agentId);
      handle.stop();
    }
    // Children get SIGKILL after 4s, so this bound is only a backstop.
    const backstop = new Promise((resolve) => setTimeout(resolve, 6000).unref());
    await Promise.race([Promise.all(settled), backstop]);
  }

  pump() {
    if (this.closing) return;
    const queued = Object.values(this.store.state.agents)
      .filter((a) => a.status === 'queued')
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (this.running.size < this.config.maxConcurrent && queued.length) {
      this.#start(queued.shift());
    }
  }

  #mcpFor(agent) {
    const mcp = this.bridge.spec({ role: 'worker', agentId: agent.id });
    const file = path.join(this.store.paths.runtime, `mcp-${agent.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { quietquest: mcp } }), { mode: 0o600 });
    return { mcp, mcpConfigPath: file };
  }

  #start(agent) {
    const provider = this.providers.get(agent.provider);
    const task = this.store.state.tasks[agent.taskId];
    const prompt = agent.nextPrompt;
    fs.mkdirSync(agent.cwd, { recursive: true });
    this.store.updateAgent(agent.id, {
      status: 'running',
      nextPrompt: '',
      turns: agent.turns + 1,
      startedAt: agent.startedAt ?? now(),
      turnStartedAt: now(),
      endedAt: null,
      activity: 'Starting…',
    });

    const wantsApprovals = agent.autonomy === 'edit' && provider.supportsApprovals;
    const handle = provider.run({
      role: 'worker',
      prompt,
      cwd: agent.cwd,
      sessionId: agent.sessionId,
      model: agent.model,
      autonomy: agent.autonomy,
      systemPrompt: WORKER_SYSTEM_PROMPT,
      ...(wantsApprovals && !provider.isMock ? this.#mcpFor(agent) : {}),
      meta: { title: task?.title, mock: agent.mock },
      requestApproval: (toolName, input) => this.requestApproval(agent.id, toolName, input),
      onEvent: (event) => this.#onEvent(agent.id, event),
    });
    this.running.set(agent.id, handle);
    if (handle.pid) this.store.updateAgent(agent.id, { pid: handle.pid });

    handle.settled = handle.done.then((outcome) => {
      this.running.delete(agent.id);
      this.#finish(this.store.state.agents[agent.id], outcome);
    });
  }

  #onEvent(agentId, event) {
    const agent = this.store.state.agents[agentId];
    switch (event.type) {
      case 'session':
        if (event.sessionId !== agent.sessionId) this.store.updateAgent(agentId, { sessionId: event.sessionId });
        return;
      case 'text_delta':
        this.store.broadcast('agent_delta', { agentId, text: event.text });
        return;
      case 'usage':
        this.store.updateAgent(agentId, {
          usage: {
            inputTokens: agent.usage.inputTokens + event.inputTokens,
            outputTokens: agent.usage.outputTokens + event.outputTokens,
            costUsd: agent.usage.costUsd + event.costUsd,
          },
        });
        return;
      case 'rate_limit':
        this.store.setRateLimit(agent.provider, event);
        return;
      case 'tool_call':
        // The approval tool is plumbing; the approval card already tells that story.
        if (event.name.endsWith('__approve')) return;
        this.store.appendAgentEvent(agentId, event);
        this.store.updateAgent(agentId, { activity: describeToolCall(event, agent.cwd), toolCalls: agent.toolCalls + 1 });
        return;
      case 'text':
        this.store.appendAgentEvent(agentId, event);
        if (!event.sub) this.store.updateAgent(agentId, { activity: oneLine(event.text, 120) });
        return;
      default:
        this.store.appendAgentEvent(agentId, event);
    }
  }

  #finish(agent, outcome) {
    this.#expireApprovals(agent.id);
    if (this.closing) {
      // Not the worker's doing and not the user's: leave the task alone so it can be resumed.
      this.store.updateAgent(agent.id, {
        status: 'interrupted',
        sessionId: outcome.sessionId ?? agent.sessionId,
        endedAt: now(),
        pid: null,
        error: 'QuietQuest was shut down while this worker was running. Send it a message to resume.',
      });
      return;
    }
    const stopped = Boolean(outcome.stopped);
    const status = outcome.ok ? 'done' : stopped ? 'stopped' : 'failed';
    const text = outcome.text || '';
    this.store.appendAgentEvent(agent.id, {
      type: 'status',
      status,
      text: outcome.ok ? 'Finished' : stopped ? 'Stopped' : outcome.error,
    });
    const hasFollowUp = Boolean(agent.nextPrompt) && !stopped;
    this.store.updateAgent(agent.id, {
      status: hasFollowUp ? 'queued' : status,
      sessionId: outcome.sessionId ?? agent.sessionId,
      result: text || agent.result,
      error: outcome.ok ? '' : outcome.error || 'Failed',
      endedAt: now(),
      pid: null,
      activity: outcome.ok ? 'Finished' : stopped ? 'Stopped' : oneLine(outcome.error, 120),
    });

    if (!hasFollowUp) {
      const task = this.store.state.tasks[agent.taskId];
      if (task?.status === 'in_progress' && !this.#taskHasActiveWorker(task.id)) {
        if (outcome.ok) this.store.updateTask(task.id, { status: 'review' });
        else if (stopped) this.store.updateTask(task.id, { status: 'todo' });
        else this.store.updateTask(task.id, { status: 'blocked', blocker: oneLine(outcome.error, 300) });
      }
      // The manager does not need telling about a stop it ordered itself.
      if (!(stopped && agent.stoppedBy === 'manager')) {
        this.onFinished?.({
          kind: 'worker',
          agentId: agent.id,
          name: agent.name,
          taskId: agent.taskId,
          projectId: agent.projectId,
          title: task?.title ?? '',
          ok: Boolean(outcome.ok),
          stopped,
          text,
          error: stopped ? 'Stopped by the user before finishing.' : outcome.error,
        });
      }
    }
    delete agent.stoppedBy;
    this.pump();
  }

  #taskHasActiveWorker(taskId) {
    return Object.values(this.store.state.agents).some((a) => a.taskId === taskId && ACTIVE.has(a.status));
  }

  // ── approvals ─────────────────────────────────────────────────────────────
  /** Called (via the tool bridge) when a worker wants to do something that needs a yes. */
  requestApproval(agentId, toolName, input) {
    const agent = this.store.state.agents[agentId];
    if (!agent) return Promise.resolve({ behavior: 'deny', message: 'Unknown worker' });
    if (agent.autoAllow?.includes(toolName)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    const approval = this.store.putApproval({
      id: newId('ap'),
      agentId,
      projectId: agent.projectId,
      toolName,
      input,
      status: 'pending',
      createdAt: now(),
    });
    if (agent.status === 'running') {
      this.store.updateAgent(agentId, {
        status: 'waiting',
        activity: `Needs approval · ${oneLine(describeToolCall({ name: toolName, input }, agent.cwd), 90)}`,
      });
    }
    return new Promise((resolve) => this.pendingApprovals.set(approval.id, resolve));
  }

  resolveApproval(approvalId, decision, { always = false, message = '' } = {}) {
    const approval = this.store.state.approvals[approvalId];
    if (!approval || approval.status !== 'pending') throw new Error('That approval is no longer pending');
    const allow = decision === 'allow';
    this.store.putApproval({ ...approval, status: allow ? 'allowed' : 'denied', resolvedAt: now() });
    const agent = this.store.state.agents[approval.agentId];
    if (agent) {
      if (allow && always && !agent.autoAllow.includes(approval.toolName)) agent.autoAllow.push(approval.toolName);
      this.store.appendAgentEvent(agent.id, {
        type: 'note',
        text: `${allow ? 'You approved' : 'You denied'} ${describeToolCall({ name: approval.toolName, input: approval.input }, agent.cwd)}`,
      });
      const stillWaiting = Object.values(this.store.state.approvals).some(
        (a) => a.agentId === agent.id && a.status === 'pending',
      );
      if (agent.status === 'waiting' && !stillWaiting) {
        this.store.updateAgent(agent.id, { status: 'running', activity: allow ? 'Approved, continuing…' : 'Denied, continuing…' });
      }
    }
    const resolve = this.pendingApprovals.get(approvalId);
    this.pendingApprovals.delete(approvalId);
    resolve?.(
      allow
        ? { behavior: 'allow', updatedInput: approval.input }
        : { behavior: 'deny', message: message || 'The user denied this action.' },
    );
    return approval;
  }

  #expireApprovals(agentId) {
    for (const approval of Object.values(this.store.state.approvals)) {
      if (approval.agentId === agentId && approval.status === 'pending') {
        this.store.putApproval({ ...approval, status: 'expired', resolvedAt: now() });
        const resolve = this.pendingApprovals.get(approval.id);
        this.pendingApprovals.delete(approval.id);
        resolve?.({ behavior: 'deny', message: 'The worker was stopped.' });
      }
    }
  }
}
