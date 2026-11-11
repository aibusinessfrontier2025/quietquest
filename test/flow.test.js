import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { startTestApp, waitFor } from './helpers.js';

const values = (record) => Object.values(record);

test('a message becomes a project, workers run, and the manager closes it out', async () => {
  const { app, close } = await startTestApp();
  try {
    app.manager.submit('Plan the offsite in Denver');
    const { store } = app;

    await waitFor(() => values(store.state.projects).length === 1, { label: 'project' });
    const [project] = values(store.state.projects);
    assert.equal(project.name, 'Plan the offsite in Denver');
    assert.ok(fs.existsSync(project.dir), 'project folder is created');

    await waitFor(() => project.status === 'done', { label: 'project done', timeout: 8000 });
    const tasks = values(store.state.tasks);
    assert.equal(tasks.length, 3);
    assert.ok(tasks.every((t) => t.status === 'done'));

    const agents = values(store.state.agents);
    assert.equal(agents.length, 3);
    assert.ok(agents.every((a) => a.status === 'done' && a.sessionId && a.result));
    assert.deepEqual(new Set(agents.map((a) => a.provider)), new Set(['claude', 'codex']));

    // Every worker left a readable transcript.
    for (const agent of agents) {
      const types = store.readAgentEvents(agent.id).map((e) => e.type);
      assert.equal(types[0], 'prompt');
      assert.ok(types.includes('tool_call') && types.includes('tool_result'));
      assert.equal(types.at(-1), 'status');
    }

    await waitFor(() => !app.manager.busy && !app.manager.queue.length, { label: 'manager idle' });
    const roles = store.chat.map((m) => m.role);
    assert.equal(roles[0], 'user');
    assert.equal(roles.filter((r) => r === 'event').length, 3);
    const first = store.chat.find((m) => m.role === 'pm');
    assert.ok(first.parts.some((p) => p.type === 'action' && p.tool === 'spawn_worker' && p.agentId));
    assert.ok(first.parts.some((p) => p.type === 'text'));
    assert.ok(!store.chat.some((m) => m.streaming), 'no message is left streaming');

    // Chat survives a restart.
    const lines = fs.readFileSync(path.join(store.home, 'chat.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, store.chat.length);
  } finally {
    await close();
  }
});

test('workers queue behind the concurrency limit', async () => {
  const { app, close } = await startTestApp({ speed: 15 });
  try {
    app.store.updateConfig({ workers: { maxConcurrent: 1 } });
    const project = app.store.createProject({ name: 'Queue', goal: 'g' });
    const tasks = ['a', 'b', 'c'].map((title) => app.store.createTask({ projectId: project.id, title }));
    const agents = tasks.map((task) => app.workers.spawn({ taskId: task.id, instructions: 'go' }));

    assert.deepEqual(agents.map((a) => a.status), ['running', 'queued', 'queued']);
    assert.equal(app.workers.running.size, 1);
    await waitFor(() => agents.every((a) => a.status === 'done'), { label: 'all done', timeout: 8000 });
  } finally {
    await close();
  }
});

test('an approval pauses the worker until the user answers', async () => {
  const { app, close } = await startTestApp();
  try {
    const project = app.store.createProject({ name: 'Approvals', goal: 'g' });
    const task = app.store.createTask({ projectId: project.id, title: 'needs a yes' });
    const agent = app.workers.spawn({ taskId: task.id, instructions: 'go', mock: { approval: true } });

    const pending = () => values(app.store.state.approvals).filter((a) => a.status === 'pending');
    await waitFor(() => pending().length === 1, { label: 'first approval' });
    assert.equal(agent.status, 'waiting');
    assert.equal(pending()[0].toolName, 'Bash');
    assert.equal(app.store.snapshot().approvals.length, 1);

    // "Always" covers the second Bash call, so no further card appears.
    app.workers.resolveApproval(pending()[0].id, 'allow', { always: true });
    assert.equal(agent.status, 'running');
    await waitFor(() => agent.status === 'done', { label: 'worker done' });
    assert.equal(values(app.store.state.approvals).length, 1);
    assert.throws(() => app.workers.resolveApproval(values(app.store.state.approvals)[0].id, 'allow'), /no longer pending/);
  } finally {
    await close();
  }
});

test('denying an approval is reported back to the worker', async () => {
  const { app, close } = await startTestApp();
  try {
    const project = app.store.createProject({ name: 'Deny', goal: 'g' });
    const task = app.store.createTask({ projectId: project.id, title: 't' });
    const agent = app.workers.spawn({ taskId: task.id, instructions: 'go', mock: { approval: true } });
    const pending = () => values(app.store.state.approvals).find((a) => a.status === 'pending');
    await waitFor(pending, { label: 'approval' });
    app.workers.resolveApproval(pending().id, 'deny');
    await waitFor(() => app.store.readAgentEvents(agent.id).some((e) => e.type === 'tool_result' && e.isError), {
      label: 'denied result',
    });
  } finally {
    await close();
  }
});

test('stopping a worker returns its task to todo and tells the manager', async () => {
  const { app, close } = await startTestApp({ speed: 40 });
  try {
    const project = app.store.createProject({ name: 'Stop', goal: 'g' });
    const task = app.store.createTask({ projectId: project.id, title: 'long job' });
    const agent = app.workers.spawn({ taskId: task.id, instructions: 'go' });
    assert.equal(task.status, 'in_progress');
    app.workers.stop(agent.id, 'user');
    await waitFor(() => agent.status === 'stopped', { label: 'stopped' });
    assert.equal(task.status, 'todo');
    await waitFor(() => app.store.chat.some((m) => m.role === 'event' && m.outcome === 'stopped'), { label: 'event row' });
  } finally {
    await close();
  }
});

test('a failed worker blocks its task with the reason', async () => {
  const { app, close } = await startTestApp();
  try {
    const project = app.store.createProject({ name: 'Fail', goal: 'g' });
    const task = app.store.createTask({ projectId: project.id, title: 'doomed' });
    const agent = app.workers.spawn({ taskId: task.id, instructions: 'go', mock: { fail: true } });
    await waitFor(() => agent.status === 'failed', { label: 'failed' });
    assert.equal(task.status, 'blocked');
    assert.match(task.blocker, /503/);
  } finally {
    await close();
  }
});

test('a follow-up resumes a finished worker in the same session', async () => {
  const { app, close } = await startTestApp();
  try {
    const project = app.store.createProject({ name: 'Follow', goal: 'g' });
    const task = app.store.createTask({ projectId: project.id, title: 't' });
    const agent = app.workers.spawn({ taskId: task.id, instructions: 'go' });
    await waitFor(() => agent.status === 'done', { label: 'first turn' });
    const session = agent.sessionId;
    app.workers.message(agent.id, 'one more thing', 'user');
    assert.equal(agent.status, 'running');
    await waitFor(() => agent.status === 'done' && agent.turns === 2, { label: 'second turn' });
    assert.equal(agent.sessionId, session);
    const prompts = app.store.readAgentEvents(agent.id).filter((e) => e.type === 'prompt');
    assert.deepEqual(prompts.map((p) => p.from), ['manager', 'user']);
  } finally {
    await close();
  }
});

test('the hourly spawn cap stops a runaway manager', async () => {
  const { app, close } = await startTestApp();
  try {
    app.store.updateConfig({ workers: { maxSpawnsPerHour: 2 } });
    const project = app.store.createProject({ name: 'Cap', goal: 'g' });
    const task = app.store.createTask({ projectId: project.id, title: 't' });
    app.workers.spawn({ taskId: task.id, instructions: 'go' });
    app.workers.spawn({ taskId: task.id, instructions: 'go' });
    const result = await app.tools.call('pm', 'spawn_worker', { task_id: task.id, instructions: 'go' });
    assert.equal(result.isError, true);
    assert.match(result.text, /Spawn limit reached/);
  } finally {
    await close();
  }
});

test('tool errors come back as readable text, not exceptions', async () => {
  const { app, close } = await startTestApp();
  try {
    const missing = await app.tools.call('pm', 'get_project', { project_id: 'p_nope' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /list_projects/);
    const blank = await app.tools.call('pm', 'spawn_worker', { task_id: 't_nope', instructions: 'x' });
    assert.match(blank.text, /No task with id/);
    assert.equal((await app.tools.call('pm', 'nope', {})).isError, true);
    assert.equal((await app.tools.call('worker', 'create_project', { name: 'x', goal: 'y' })).isError, true);
  } finally {
    await close();
  }
});

test('memory tools append and rewrite', async () => {
  const { app, close } = await startTestApp();
  try {
    await app.tools.call('pm', 'remember', { note: 'Prefers morning flights' });
    await app.tools.call('pm', 'remember', { note: 'Sam is vegetarian' });
    assert.equal(app.store.getMemory(), '- Prefers morning flights\n- Sam is vegetarian\n');
    await app.tools.call('pm', 'rewrite_memory', { content: '- Only this' });
    assert.equal(app.store.getMemory(), '- Only this\n');
  } finally {
    await close();
  }
});

test('workers that were running when the process died are marked interrupted on restart', async () => {
  const { app, home, close } = await startTestApp({ speed: 200 });
  try {
    const project = app.store.createProject({ name: 'Crash', goal: 'g' });
    const task = app.store.createTask({ projectId: project.id, title: 't' });
    const agent = app.workers.spawn({ taskId: task.id, instructions: 'go' });
    assert.equal(agent.status, 'running');
    app.store.flush();

    const second = createApp({ home, port: 0, demo: true, speed: 2 });
    await second.start();
    try {
      const recovered = second.store.state.agents[agent.id];
      assert.equal(recovered.status, 'interrupted');
      assert.match(recovered.error, /restarted/);
      assert.equal(second.store.state.projects[project.id].name, 'Crash');
    } finally {
      await second.stop();
    }
  } finally {
    await close();
  }
});

test('shutdown does not hang on a worker that is waiting for approval', async () => {
  const { app, close } = await startTestApp();
  const project = app.store.createProject({ name: 'Shutdown', goal: 'g' });
  const task = app.store.createTask({ projectId: project.id, title: 't' });
  const agent = app.workers.spawn({ taskId: task.id, instructions: 'go', mock: { approval: true } });
  await waitFor(() => agent.status === 'waiting', { label: 'waiting on approval' });
  const started = Date.now();
  await app.stop();
  assert.ok(Date.now() - started < 2000, 'stop returned promptly');
  assert.equal(agent.status, 'interrupted');
  assert.equal(task.status, 'in_progress', 'the task is left resumable');
  assert.ok(values(app.store.state.approvals).every((a) => a.status === 'expired'));
  await close().catch(() => {});
});
