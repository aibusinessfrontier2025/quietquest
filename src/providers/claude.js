import { truncate } from '../util.js';
import { childEnv, probe, runCli, stringifyToolOutput } from './cli.js';

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
export const MCP_SERVER = 'quietquest';
export const APPROVAL_TOOL = `mcp__${MCP_SERVER}__approve`;

/** Maps Claude Code `--output-format stream-json` records to normalized events. */
export function createClaudeParser() {
  let sessionId = null;
  let result = null;
  let lastText = '';
  let usage = null;

  return {
    feed(record) {
      if (record.session_id) sessionId = record.session_id;
      const sub = Boolean(record.parent_tool_use_id);
      const events = [];

      switch (record.type) {
        case 'system':
          if (record.subtype === 'init') events.push({ type: 'session', sessionId: record.session_id });
          break;

        case 'stream_event': {
          const delta = record.event?.delta;
          if (!sub && record.event?.type === 'content_block_delta' && delta?.type === 'text_delta') {
            events.push({ type: 'text_delta', text: delta.text });
          }
          break;
        }

        case 'assistant':
          for (const block of record.message?.content ?? []) {
            if (block.type === 'text' && block.text) {
              if (!sub) lastText = block.text;
              events.push({ type: 'text', text: block.text, ...(sub && { sub }) });
            } else if (block.type === 'thinking' && block.thinking) {
              events.push({ type: 'thinking', text: block.thinking, ...(sub && { sub }) });
            } else if (block.type === 'tool_use') {
              events.push({
                type: 'tool_call',
                id: block.id,
                name: block.name,
                input: block.input ?? {},
                ...(sub && { sub }),
              });
            }
          }
          break;

        case 'user':
          for (const block of Array.isArray(record.message?.content) ? record.message.content : []) {
            if (block.type === 'tool_result') {
              events.push({
                type: 'tool_result',
                id: block.tool_use_id,
                output: truncate(stringifyToolOutput(block.content), 6000),
                isError: Boolean(block.is_error),
                ...(sub && { sub }),
              });
            }
          }
          break;

        case 'rate_limit_event': {
          const info = record.rate_limit_info ?? {};
          const windows = {};
          for (const [name, value] of Object.entries(info.unifiedWindows ?? {})) {
            windows[name] = { utilization: value.utilization, resetsAt: value.resetsAt, status: value.status };
          }
          events.push({ type: 'rate_limit', status: info.status, windows });
          break;
        }

        case 'result':
          result = record;
          usage = {
            inputTokens:
              (record.usage?.input_tokens ?? 0) +
              (record.usage?.cache_creation_input_tokens ?? 0) +
              (record.usage?.cache_read_input_tokens ?? 0),
            outputTokens: record.usage?.output_tokens ?? 0,
            costUsd: record.total_cost_usd ?? 0,
          };
          events.push({ type: 'usage', ...usage });
          break;

        default:
          break;
      }
      return events;
    },

    finish({ exitCode, stderr, stray }) {
      if (result) {
        const ok = result.subtype === 'success' && !result.is_error;
        const text = typeof result.result === 'string' && result.result ? result.result : lastText;
        return {
          ok,
          sessionId,
          text,
          usage,
          error: ok ? null : text || result.subtype || 'Claude reported an error',
        };
      }
      const detail = (stderr || stray || '').trim();
      return {
        ok: false,
        sessionId,
        text: lastText,
        usage,
        error: detail
          ? truncate(detail, 1200)
          : `Claude exited with code ${exitCode} before producing a result`,
      };
    },
  };
}

/**
 * Autonomy → Claude Code permission flags.
 *   read  nothing that needs a permission prompt may run; reading and web lookups are pre-approved
 *   edit  file edits auto-accepted; anything else that would prompt becomes an approval card
 *   full  no permission checks at all
 */
export function buildClaudeArgs({ role, sessionId, model, autonomy, systemPrompt, mcpConfigPath, addDirs = [] }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (sessionId) args.push('--resume', sessionId);
  if (model) args.push('--model', model);
  for (const dir of addDirs) args.push('--add-dir', dir);

  if (role === 'pm') {
    // The manager delegates. It can look things up, but cannot edit or run anything itself.
    args.push('--system-prompt', systemPrompt);
    args.push('--tools', READ_TOOLS.join(','));
    args.push('--allowedTools', [`mcp__${MCP_SERVER}`, ...READ_TOOLS].join(','));
    args.push('--permission-mode', 'dontAsk');
    args.push('--disable-slash-commands');
    args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
    return args;
  }

  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  if (autonomy === 'full') {
    args.push('--permission-mode', 'bypassPermissions');
  } else if (autonomy === 'read') {
    args.push('--permission-mode', 'dontAsk', '--allowedTools', READ_TOOLS.join(','));
  } else {
    args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'WebSearch,WebFetch');
    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath, '--permission-prompt-tool', APPROVAL_TOOL);
    }
  }
  return args;
}

export function createClaudeProvider(getConfig) {
  const settings = () => getConfig().providers.claude;
  const env = (extra) =>
    childEnv({
      stripKeys: settings().useApiKey ? [] : ['ANTHROPIC_API_KEY'],
      // Approval cards may wait on a human, so tool calls must not time out underneath them.
      extra: { MCP_TOOL_TIMEOUT: String(24 * 60 * 60 * 1000), ...extra },
    });

  return {
    id: 'claude',
    label: 'Claude',
    supportsApprovals: true,

    async detect() {
      const bin = settings().bin;
      const version = await probe(bin, ['--version'], { env: env() });
      if (!version.ok) {
        return {
          installed: false,
          loggedIn: false,
          detail: version.missing ? `"${bin}" not found on PATH` : version.stderr.trim().slice(0, 200),
          fix: 'Install Claude Code (npm i -g @anthropic-ai/claude-code), then run `claude` and sign in.',
        };
      }
      const status = await probe(bin, ['auth', 'status'], { env: env() });
      let auth = {};
      try {
        auth = JSON.parse(status.stdout);
      } catch {
        // Older CLIs print prose; fall back to exit status.
        auth = { loggedIn: status.ok };
      }
      return {
        installed: true,
        version: version.stdout.trim().split(/\s+/)[0],
        loggedIn: Boolean(auth.loggedIn),
        detail: auth.loggedIn
          ? [auth.subscriptionType, auth.authMethod].filter(Boolean).join(' · ') || 'signed in'
          : 'not signed in',
        fix: auth.loggedIn ? null : 'Run `claude` in a terminal and sign in with your Claude subscription.',
      };
    },

    run({ role, prompt, cwd, sessionId, model, autonomy, systemPrompt, mcpConfigPath, addDirs, onEvent }) {
      return runCli({
        bin: settings().bin,
        args: buildClaudeArgs({ role, sessionId, model, autonomy, systemPrompt, mcpConfigPath, addDirs }),
        cwd,
        env: env(),
        prompt,
        parser: createClaudeParser(),
        onEvent,
      });
    },
  };
}
