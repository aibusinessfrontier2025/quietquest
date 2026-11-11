import { execFile, spawn } from 'node:child_process';
import { createJsonLineReader } from '../util.js';

/**
 * Normalized event vocabulary every provider emits:
 *   session     { sessionId }
 *   text_delta  { text }                      streaming fragment, never persisted
 *   text        { text }                      a completed assistant message
 *   thinking    { text }
 *   tool_call   { id, name, input, sub? }
 *   tool_result { id, output, isError }
 *   note        { text, level? }
 *   rate_limit  { windows }
 *   usage       { inputTokens, outputTokens, costUsd }
 */

/**
 * Runs a provider CLI for exactly one turn: prompt goes in on stdin, JSONL comes out on stdout.
 * `parser.feed(obj)` maps raw CLI events to normalized ones; `parser.finish(...)` produces the outcome.
 */
export function runCli({ bin, args, cwd, env, prompt, parser, onEvent }) {
  let child;
  let stopped = false;
  let stderr = '';
  const stray = [];

  const done = new Promise((resolve) => {
    try {
      child = spawn(bin, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group so stop() can take down the CLI and anything it launched.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({ ok: false, error: `Could not start ${bin}: ${error.message}` });
      return;
    }

    const emit = (event) => {
      try {
        onEvent?.(event);
      } catch (error) {
        console.error('[quietquest] event handler failed:', error);
      }
    };

    const reader = createJsonLineReader(
      (obj) => {
        for (const event of parser.feed(obj)) emit(event);
      },
      (line) => {
        stray.push(line);
        if (stray.length > 20) stray.shift();
      },
    );

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => reader.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt ?? '');

    child.on('error', (error) => {
      const missing = error.code === 'ENOENT';
      resolve({
        ok: false,
        error: missing
          ? `"${bin}" was not found on your PATH. Install it or set its path in Settings.`
          : `Could not start ${bin}: ${error.message}`,
      });
    });

    child.on('close', (exitCode, signal) => {
      reader.flush();
      const outcome = parser.finish({ exitCode, signal, stderr, stray: stray.join('\n') });
      if (stopped) {
        resolve({ ...outcome, ok: false, stopped: true, error: 'Stopped' });
      } else {
        resolve(outcome);
      }
    });
  });

  const kill = (signal) => {
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      // already gone
    }
  };

  return {
    get pid() {
      return child?.pid ?? null;
    },
    done,
    stop() {
      stopped = true;
      kill('SIGTERM');
      const timer = setTimeout(() => kill('SIGKILL'), 4000);
      timer.unref?.();
      done.then(() => clearTimeout(timer));
    },
  };
}

/** Runs a short CLI command and resolves with whatever it printed, never rejecting. */
export function probe(bin, args, { env, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        missing: error?.code === 'ENOENT',
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

/** Builds the child environment. Subscription logins are used unless the user opts into API keys. */
export function childEnv({ stripKeys = [], extra = {} } = {}) {
  const env = { ...process.env, ...extra };
  for (const key of stripKeys) delete env[key];
  return env;
}

export function stringifyToolOutput(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block?.type === 'text') return block.text;
        if (block?.type === 'image') return '[image]';
        return JSON.stringify(block);
      })
      .join('\n');
  }
  return JSON.stringify(content);
}
