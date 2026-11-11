import { truncate } from '../util.js';
import { childEnv, probe, runCli, stringifyToolOutput } from './cli.js';

const SANDBOX = { read: 'read-only', edit: 'workspace-write', full: 'danger-full-access' };

/** Maps `codex exec --json` records to normalized events. */
export function createCodexParser() {
  let sessionId = null;
  let lastText = '';
  let usage = null;
  let completed = false;
  let failure = null;
  let lastError = null;
  const opened = new Set();

  const openCall = (events, item, name, input) => {
    if (opened.has(item.id)) return;
    opened.add(item.id);
    events.push({ type: 'tool_call', id: item.id, name, input });
  };

  const handleItem = (events, phase, item) => {
    const finished = phase === 'item.completed';
    switch (item.type) {
      case 'agent_message':
        if (finished && item.text) {
          lastText = item.text;
          events.push({ type: 'text', text: item.text });
        }
        break;
      case 'reasoning':
        if (finished && item.text) events.push({ type: 'thinking', text: item.text });
        break;
      case 'command_execution':
        openCall(events, item, 'shell', { command: item.command });
        if (finished) {
          events.push({
            type: 'tool_result',
            id: item.id,
            output: truncate(item.aggregated_output ?? '', 6000),
            isError: item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0),
          });
        }
        break;
      case 'file_change':
        openCall(events, item, 'apply_patch', { changes: item.changes ?? [] });
        if (finished) {
          events.push({
            type: 'tool_result',
            id: item.id,
            output: (item.changes ?? []).map((c) => `${c.kind} ${c.path}`).join('\n'),
            isError: item.status === 'failed',
          });
        }
        break;
      case 'mcp_tool_call':
        openCall(events, item, `${item.server}.${item.tool}`, item.arguments ?? {});
        if (finished) {
          events.push({
            type: 'tool_result',
            id: item.id,
            output: truncate(
              item.error?.message ?? stringifyToolOutput(item.result?.content ?? item.result),
              6000,
            ),
            isError: item.status === 'failed' || Boolean(item.error),
          });
        }
        break;
      case 'web_search':
        openCall(events, item, 'web_search', { query: item.query });
        if (finished) events.push({ type: 'tool_result', id: item.id, output: '', isError: false });
        break;
      case 'todo_list':
        if (finished || phase === 'item.started') {
          const lines = (item.items ?? []).map((t) => `${t.completed ? '✓' : '○'} ${t.text}`);
          if (lines.length) events.push({ type: 'note', text: lines.join('\n') });
        }
        break;
      case 'error':
        if (item.message) {
          lastError = item.message;
          events.push({ type: 'note', level: 'warn', text: item.message });
        }
        break;
      default:
        break;
    }
  };

  return {
    feed(record) {
      const events = [];
      switch (record.type) {
        case 'thread.started':
          sessionId = record.thread_id;
          events.push({ type: 'session', sessionId });
          break;
        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          if (record.item) handleItem(events, record.type, record.item);
          break;
        case 'turn.completed':
          completed = true;
          usage = {
            inputTokens: record.usage?.input_tokens ?? 0,
            outputTokens: record.usage?.output_tokens ?? 0,
            costUsd: 0,
          };
          events.push({ type: 'usage', ...usage });
          break;
        case 'turn.failed':
          failure = record.error?.message ?? 'Codex turn failed';
          break;
        case 'error':
          // Mostly transient ("Reconnecting… 2/5"); only fatal if the turn then fails.
          lastError = record.message;
          events.push({ type: 'note', level: 'warn', text: record.message ?? 'error' });
          break;
        default:
          break;
      }
      return events;
    },

    finish({ exitCode, stderr, stray }) {
      if (completed && !failure) return { ok: true, sessionId, text: lastText, usage, error: null };
      const detail = failure || lastError || (stderr || stray || '').trim();
      const unauthorized = /401|not logged in|unauthorized/i.test(detail || '');
      return {
        ok: false,
        sessionId,
        text: lastText,
        usage,
        error: unauthorized
          ? 'Codex is not signed in. Run `codex login` in a terminal and sign in with ChatGPT.'
          : truncate(detail || `Codex exited with code ${exitCode} before finishing`, 1200),
      };
    },
  };
}

const toml = (value) => JSON.stringify(value);

/** Inline-TOML overrides that attach the QuietQuest tool bridge to a Codex run. */
function mcpOverrides(mcp) {
  if (!mcp) return [];
  const envTable = Object.entries(mcp.env)
    .map(([key, value]) => `${key}=${toml(value)}`)
    .join(',');
  return [
    '-c', `mcp_servers.quietquest.command=${toml(mcp.command)}`,
    '-c', `mcp_servers.quietquest.args=${toml(mcp.args)}`,
    '-c', `mcp_servers.quietquest.env={${envTable}}`,
  ];
}

export function buildCodexArgs({ role, sessionId, model, autonomy, cwd, mcp }) {
  const sandbox = role === 'pm' ? SANDBOX.read : (SANDBOX[autonomy] ?? SANDBOX.edit);
  const shared = ['--json', '--skip-git-repo-check'];
  if (model) shared.push('-m', model);
  shared.push(...mcpOverrides(role === 'pm' ? mcp : null));
  // `exec resume` has no -s/-C flags, so the sandbox goes in as a config override there.
  if (sessionId) {
    return ['exec', 'resume', ...shared, '-c', `sandbox_mode=${toml(sandbox)}`, sessionId, '-'];
  }
  return ['exec', ...shared, '-s', sandbox, '-C', cwd, '-'];
}

export function createCodexProvider(getConfig) {
  const settings = () => getConfig().providers.codex;
  const env = () => childEnv({ stripKeys: settings().useApiKey ? [] : ['OPENAI_API_KEY'] });

  return {
    id: 'codex',
    label: 'OpenAI',
    supportsApprovals: false,

    async detect() {
      const bin = settings().bin;
      const version = await probe(bin, ['--version'], { env: env() });
      if (!version.ok) {
        return {
          installed: false,
          loggedIn: false,
          detail: version.missing ? `"${bin}" not found on PATH` : version.stderr.trim().slice(0, 200),
          fix: 'Install the Codex CLI (npm i -g @openai/codex), then run `codex login`.',
        };
      }
      const status = await probe(bin, ['login', 'status'], { env: env() });
      const text = `${status.stdout}\n${status.stderr}`.trim();
      const loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
      return {
        installed: true,
        version: version.stdout.trim().split(/\s+/).pop(),
        loggedIn,
        detail: loggedIn ? text.split('\n')[0].replace(/^logged in using /i, '') : 'not signed in',
        fix: loggedIn ? null : 'Run `codex login` in a terminal and sign in with your ChatGPT plan.',
      };
    },

    run({ role, prompt, cwd, sessionId, model, autonomy, systemPrompt, mcp, onEvent }) {
      // Codex has no system-prompt flag, so standing instructions open the first turn instead.
      const fullPrompt = !sessionId && systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
      return runCli({
        bin: settings().bin,
        args: buildCodexArgs({ role, sessionId, model, autonomy, cwd, mcp }),
        cwd,
        env: env(),
        prompt: fullPrompt,
        parser: createCodexParser(),
        onEvent,
      });
    },
  };
}
