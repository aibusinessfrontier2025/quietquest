import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';
import { startTestApp, waitFor } from './helpers.js';

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const json = { 'content-type': 'application/json' };

test('dashboard API serves state and accepts chat', async () => {
  const { app, close } = await startTestApp();
  try {
    const state = (await request(`${app.url}/api/state`)).json();
    assert.deepEqual(Object.keys(state.providers), ['claude', 'codex']);
    assert.equal(state.demo, true);

    const sent = await request(`${app.url}/api/chat`, { method: 'POST', headers: json, body: '{"text":"Hello there"}' });
    assert.equal(sent.status, 200);
    assert.equal(sent.json().role, 'user');
    assert.equal((await request(`${app.url}/api/chat`, { method: 'POST', headers: json, body: '{"text":"  "}' })).status, 400);

    const page = await request(`${app.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>QuietQuest<\/title>/);
    assert.equal((await request(`${app.url}/..%2f..%2fpackage.json`)).status, 404);
    await waitFor(() => !app.manager.busy, { label: 'manager idle' });
  } finally {
    await close();
  }
});

test('requests from other sites cannot drive the manager', async () => {
  const { app, close } = await startTestApp();
  try {
    const chat = `${app.url}/api/chat`;
    const body = '{"text":"spawn something"}';
    // A cross-site form post cannot set a JSON content type.
    assert.equal((await request(chat, { method: 'POST', headers: { 'content-type': 'text/plain' }, body })).status, 415);
    assert.equal((await request(chat, { method: 'POST', headers: { ...json, origin: 'https://evil.example' }, body })).status, 403);
    assert.equal((await request(chat, { method: 'POST', headers: { ...json, origin: 'null' }, body })).status, 403);
    // DNS rebinding arrives with the attacker's hostname in Host.
    assert.equal((await request(`${app.url}/api/state`, { headers: { host: 'evil.example' } })).status, 403);
    assert.equal(app.store.chat.length, 0);
    assert.equal((await request(chat, { method: 'POST', headers: { ...json, origin: app.url }, body })).status, 200);
    await waitFor(() => !app.manager.busy, { label: 'manager idle' });
  } finally {
    await close();
  }
});

test('internal bridge routes require the token', async () => {
  const { app, close } = await startTestApp();
  try {
    assert.equal((await request(`${app.url}/internal/tools?role=pm`)).status, 401);
    assert.equal((await request(`${app.url}/internal/tools?role=pm`, { headers: { 'x-qq-token': 'wrong' } })).status, 401);
    const ok = await request(`${app.url}/internal/tools?role=pm`, { headers: { 'x-qq-token': app.token } });
    assert.ok(ok.json().tools.some((t) => t.name === 'spawn_worker'));
  } finally {
    await close();
  }
});

test('settings are validated and persisted', async () => {
  const { app, close } = await startTestApp();
  try {
    const bad = await request(`${app.url}/api/settings`, { method: 'POST', headers: json, body: '{"pm":{"provider":"nope"}}' });
    assert.equal(bad.status, 400);
    const good = await request(`${app.url}/api/settings`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ pm: { name: 'Robin', provider: 'codex' }, workers: { maxConcurrent: '9', evil: 'x' } }),
    });
    assert.equal(good.status, 200);
    assert.equal(app.store.config.pm.name, 'Robin');
    assert.equal(app.store.config.pm.provider, 'codex');
    assert.equal(app.store.config.workers.maxConcurrent, 9);
    assert.equal(app.store.config.workers.evil, undefined);
  } finally {
    await close();
  }
});

/** Speaks newline-delimited JSON-RPC to the bridge exactly as the CLIs do. */
function startBridge(spec) {
  const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let nextId = 0;
  return {
    call(method, params) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return new Promise((resolve) => waiting.set(id, resolve));
    },
    notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
    close: () => child.stdin.end(),
  };
}

test('the MCP bridge exposes manager tools to a CLI', async () => {
  const { app, close } = await startTestApp();
  const bridge = startBridge(app.bridge.spec({ role: 'pm' }));
  try {
    const init = await bridge.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'quietquest');
    bridge.notify('notifications/initialized');

    const { result } = await bridge.call('tools/list', {});
    const names = result.tools.map((t) => t.name);
    assert.ok(names.includes('create_project') && names.includes('spawn_worker'));
    assert.ok(!names.includes('approve'), 'the manager does not get the approval tool');
    assert.ok(result.tools.every((t) => t.inputSchema.type === 'object'));

    const created = await bridge.call('tools/call', { name: 'create_project', arguments: { name: 'From the CLI', goal: 'prove the bridge' } });
    assert.equal(created.result.isError, false);
    const { id } = JSON.parse(created.result.content[0].text);
    assert.equal(app.store.state.projects[id].name, 'From the CLI');

    const failed = await bridge.call('tools/call', { name: 'get_project', arguments: { project_id: 'p_missing' } });
    assert.equal(failed.result.isError, true);
    assert.equal((await bridge.call('resources/list', {})).error.code, -32601);
  } finally {
    bridge.close();
    await close();
  }
});

test('a worker approval travels bridge → dashboard → bridge', async () => {
  const { app, close } = await startTestApp({ speed: 300 });
  const project = app.store.createProject({ name: 'Bridge approval', goal: 'g' });
  const task = app.store.createTask({ projectId: project.id, title: 't' });
  const agent = app.workers.spawn({ taskId: task.id, instructions: 'go' });
  const bridge = startBridge(app.bridge.spec({ role: 'worker', agentId: agent.id }));
  try {
    await bridge.call('initialize', { protocolVersion: '2025-06-18' });
    const { result } = await bridge.call('tools/list', {});
    assert.deepEqual(result.tools.map((t) => t.name), ['approve']);

    const answer = bridge.call('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'rm -rf build' } } });
    const pending = await waitFor(() => Object.values(app.store.state.approvals).find((a) => a.status === 'pending'), { label: 'approval card' });
    assert.equal(pending.agentId, agent.id);
    assert.deepEqual(pending.input, { command: 'rm -rf build' });

    const decided = await request(`${app.url}/api/approvals/${pending.id}`, { method: 'POST', headers: json, body: '{"decision":"deny"}' });
    assert.equal(decided.status, 200);
    const verdict = JSON.parse((await answer).result.content[0].text);
    assert.equal(verdict.behavior, 'deny');
  } finally {
    bridge.close();
    await close();
  }
});
