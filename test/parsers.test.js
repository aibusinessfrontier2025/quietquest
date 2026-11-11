import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClaudeArgs, createClaudeParser } from '../src/providers/claude.js';
import { buildCodexArgs, createCodexParser } from '../src/providers/codex.js';

const feedAll = (parser, records) => records.flatMap((record) => parser.feed(record));

// Shapes below were captured from Claude Code 2.1 `-p --output-format stream-json --verbose --include-partial-messages`.
const CLAUDE_RUN = [
  { type: 'system', subtype: 'init', session_id: 'sess-1', tools: ['Bash'] },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '' } }, session_id: 'sess-1', parent_tool_use_id: null },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }] }, session_id: 'sess-1', parent_tool_use_id: null },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.16, resetsAt: 1794672000, status: 'allowed' } } }, session_id: 'sess-1' },
  { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'hi', is_error: false }] }, parent_tool_use_id: null, session_id: 'sess-1' },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'do' } }, session_id: 'sess-1', parent_tool_use_id: null },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ne' } }, session_id: 'sess-1', parent_tool_use_id: null },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] }, session_id: 'sess-1', parent_tool_use_id: null },
  { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-1', total_cost_usd: 0.002216, usage: { input_tokens: 4, cache_creation_input_tokens: 7868, cache_read_input_tokens: 60200, output_tokens: 80 } },
];

test('claude parser normalizes a full turn', () => {
  const parser = createClaudeParser();
  const events = feedAll(parser, CLAUDE_RUN);
  assert.deepEqual(
    events.map((e) => e.type),
    ['session', 'tool_call', 'rate_limit', 'tool_result', 'text_delta', 'text_delta', 'text', 'usage'],
  );
  assert.deepEqual(events[1], { type: 'tool_call', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } });
  assert.equal(events[2].windows.seven_day.utilization, 0.16);
  assert.deepEqual(events[3], { type: 'tool_result', id: 'toolu_1', output: 'hi', isError: false });

  const outcome = parser.finish({ exitCode: 0, stderr: '', stray: '' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.sessionId, 'sess-1');
  assert.equal(outcome.text, 'done');
  assert.equal(outcome.usage.inputTokens, 4 + 7868 + 60200);
  assert.equal(outcome.usage.outputTokens, 80);
});

test('claude parser marks subagent traffic and keeps it out of the final text', () => {
  const parser = createClaudeParser();
  const events = feedAll(parser, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'main' }] }, parent_tool_use_id: null },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'from subagent' }] }, parent_tool_use_id: 'toolu_9' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }, parent_tool_use_id: 'toolu_9' },
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[1].sub, true);
  assert.equal(parser.finish({ exitCode: 1, stderr: 'boom' }).text, 'main');
});

test('claude parser reports stderr when the CLI dies without a result', () => {
  const outcome = createClaudeParser().finish({ exitCode: 1, stderr: 'Invalid API key · Please run /login', stray: '' });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Please run \/login/);
});

test('claude parser treats an error result as a failure', () => {
  const parser = createClaudeParser();
  parser.feed({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's', usage: {} });
  const outcome = parser.finish({ exitCode: 1, stderr: '' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'error_max_turns');
});

test('claude args: manager is read-only and tool-bridged', () => {
  const args = buildClaudeArgs({ role: 'pm', sessionId: 'abc', model: 'opus', systemPrompt: 'SYS', mcpConfigPath: '/tmp/pm.json', addDirs: ['/w'] });
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(flag('--resume'), 'abc');
  assert.equal(flag('--model'), 'opus');
  assert.equal(flag('--system-prompt'), 'SYS');
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.equal(flag('--tools'), 'Read,Glob,Grep,WebSearch,WebFetch');
  assert.match(flag('--allowedTools'), /^mcp__quietquest,/);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('Bash'));
});

test('claude args: worker autonomy maps to permission flags', () => {
  const flag = (args, name) => args[args.indexOf(name) + 1];
  const read = buildClaudeArgs({ role: 'worker', autonomy: 'read' });
  assert.equal(flag(read, '--permission-mode'), 'dontAsk');

  const edit = buildClaudeArgs({ role: 'worker', autonomy: 'edit', mcpConfigPath: '/tmp/w.json' });
  assert.equal(flag(edit, '--permission-mode'), 'acceptEdits');
  assert.equal(flag(edit, '--permission-prompt-tool'), 'mcp__quietquest__approve');
  assert.ok(!edit.includes('--strict-mcp-config'), 'workers keep the user\'s own MCP servers');

  const full = buildClaudeArgs({ role: 'worker', autonomy: 'full' });
  assert.equal(flag(full, '--permission-mode'), 'bypassPermissions');
  assert.ok(!full.includes('--permission-prompt-tool'));
});

const CODEX_RUN = [
  { type: 'thread.started', thread_id: 'th-1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Look first.' } },
  { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: '', exit_code: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: 'README.md\n', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'notes.md', kind: 'add' }], status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'All set.' } },
  { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90 } },
];

test('codex parser normalizes a full turn', () => {
  const parser = createCodexParser();
  const events = feedAll(parser, CODEX_RUN);
  assert.deepEqual(
    events.map((e) => e.type),
    ['session', 'thinking', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'text', 'usage'],
  );
  assert.deepEqual(events[2], { type: 'tool_call', id: 'item_1', name: 'shell', input: { command: 'bash -lc ls' } });
  assert.equal(events[3].isError, false);
  assert.equal(events[5].output, 'add notes.md');
  const outcome = parser.finish({ exitCode: 0, stderr: '' });
  assert.deepEqual(
    { ok: outcome.ok, sessionId: outcome.sessionId, text: outcome.text },
    { ok: true, sessionId: 'th-1', text: 'All set.' },
  );
});

// Captured from codex-cli 0.167 run without a login.
test('codex parser turns a 401 into a sign-in instruction', () => {
  const parser = createCodexParser();
  const events = feedAll(parser, [
    { type: 'thread.started', thread_id: 'th-2' },
    { type: 'turn.started' },
    { type: 'error', message: 'Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)' },
    { type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } },
  ]);
  assert.equal(events.at(-1).type, 'note');
  const outcome = parser.finish({ exitCode: 1, stderr: '' });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /codex login/);
});

test('codex args: new session, resume, and manager bridge', () => {
  const fresh = buildCodexArgs({ role: 'worker', autonomy: 'edit', cwd: '/work', model: 'gpt-5' });
  assert.deepEqual(fresh, ['exec', '--json', '--skip-git-repo-check', '-m', 'gpt-5', '-s', 'workspace-write', '-C', '/work', '-']);

  const resumed = buildCodexArgs({ role: 'worker', autonomy: 'read', cwd: '/work', sessionId: 'th-1' });
  assert.deepEqual(resumed, ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', 'th-1', '-']);

  const pm = buildCodexArgs({
    role: 'pm',
    cwd: '/pm',
    mcp: { command: '/usr/bin/node', args: ['/x/bridge.js'], env: { QQ_URL: 'http://127.0.0.1:1', QQ_ROLE: 'pm' } },
  });
  assert.ok(pm.includes('mcp_servers.quietquest.command="/usr/bin/node"'));
  assert.ok(pm.includes('mcp_servers.quietquest.args=["/x/bridge.js"]'));
  assert.ok(pm.includes('mcp_servers.quietquest.env={QQ_URL="http://127.0.0.1:1",QQ_ROLE="pm"}'));
  assert.equal(pm[pm.indexOf('-s') + 1], 'read-only');
});
