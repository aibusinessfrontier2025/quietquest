import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROJECT_STATUSES, TASK_STATUSES } from './store.js';

const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(text);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}

function isLocalOrigin(origin) {
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Loopback-only HTTP server: the dashboard, its JSON API, a server-sent event stream,
 * and the token-protected /internal routes the tool bridge calls.
 */
export function createServer({ store, manager, workers, tools, providers, token, demo }) {
  const clients = new Set();

  store.on('broadcast', (message) => {
    const frame = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of clients) client.write(frame);
  });

  const routes = {
    'GET /api/state': () => ({
      ...store.snapshot(),
      providers: providers.status(),
      manager: manager.status(),
      demo,
    }),

    'POST /api/chat': ({ body }) => {
      const text = String(body.text ?? '').trim();
      if (!text) throw new HttpError(400, 'text is required');
      return manager.submit(text);
    },

    'POST /api/manager/stop': () => {
      manager.stop();
      return { ok: true };
    },

    'GET /api/agents/:id/events': ({ params }) => {
      if (!store.state.agents[params.id]) throw new HttpError(404, 'No such worker');
      return { events: store.readAgentEvents(params.id) };
    },

    'POST /api/agents/:id/stop': ({ params }) => workers.stop(params.id, 'user'),

    'POST /api/agents/:id/message': ({ params, body }) => workers.message(params.id, String(body.text ?? ''), 'user'),

    'POST /api/approvals/:id': ({ params, body }) => {
      if (!['allow', 'deny'].includes(body.decision)) throw new HttpError(400, 'decision must be allow or deny');
      return workers.resolveApproval(params.id, body.decision, { always: Boolean(body.always) });
    },

    'POST /api/tasks/:id': ({ params, body }) => {
      if (body.status && !TASK_STATUSES.includes(body.status)) throw new HttpError(400, 'Invalid status');
      return store.updateTask(params.id, body.status ? { status: body.status } : {});
    },

    'POST /api/projects/:id': ({ params, body }) => {
      if (body.status && !PROJECT_STATUSES.includes(body.status)) throw new HttpError(400, 'Invalid status');
      return store.updateProject(params.id, body.status ? { status: body.status } : {});
    },

    'POST /api/settings': ({ body }) => {
      const patch = {};
      if (body.pm) patch.pm = pickKnown(body.pm, ['name', 'provider', 'model']);
      if (body.workers) {
        patch.workers = pickKnown(body.workers, ['provider', 'model', 'autonomy', 'maxConcurrent', 'maxSpawnsPerHour']);
      }
      for (const section of [patch.pm, patch.workers]) {
        if (section?.provider && !providers.has(section.provider)) {
          throw new HttpError(400, `Unknown provider ${section.provider}`);
        }
      }
      const config = store.updateConfig(patch);
      workers.pump();
      return config;
    },

    'POST /api/memory': ({ body }) => {
      store.setMemory(String(body.text ?? ''));
      return { ok: true };
    },

    'POST /api/providers/refresh': async () => {
      const status = await providers.refresh();
      store.broadcast('providers', status);
      return status;
    },

    // ── tool bridge ─────────────────────────────────────────────────────────
    'GET /internal/tools': ({ url }) => ({ tools: tools.list(url.searchParams.get('role')) }),

    'POST /internal/call': async ({ body }) => {
      const result = await tools.call(body.role, body.name, body.arguments, { agentId: body.agentId });
      return { text: result.text, isError: result.isError };
    },
  };

  function pickKnown(source, keys) {
    const out = {};
    for (const key of keys) {
      if (source[key] === undefined) continue;
      out[key] = ['maxConcurrent', 'maxSpawnsPerHour'].includes(key)
        ? Math.max(1, Math.min(200, Number(source[key]) || 1))
        : String(source[key]);
    }
    return out;
  }

  function match(method, pathname) {
    for (const [key, handler] of Object.entries(routes)) {
      const [routeMethod, pattern] = key.split(' ');
      if (routeMethod !== method) continue;
      const names = [];
      const regex = new RegExp(
        `^${pattern.replace(/:[a-z]+/g, (name) => {
          names.push(name.slice(1));
          return '([^/]+)';
        })}$`,
      );
      const found = regex.exec(pathname);
      if (found) {
        const params = Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(found[i + 1])]));
        return { handler, params };
      }
    }
    return null;
  }

  function serveStatic(pathname, response) {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(WEB_ROOT, relative));
    if (!file.startsWith(WEB_ROOT + path.sep)) throw new HttpError(403, 'Forbidden');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Not found');
    response.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(response);
  }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://local');
    const { pathname } = url;

    // Refuse anything addressed to a name other than loopback: this blocks DNS-rebinding pages.
    const host = String(request.headers.host ?? '').replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(host)) throw new HttpError(403, 'QuietQuest only answers on localhost');

    if (pathname.startsWith('/internal/')) {
      if (!tokenMatches(request.headers['x-qq-token'], token)) throw new HttpError(401, 'Bad bridge token');
    } else if (request.method !== 'GET') {
      // Browsers cannot send JSON cross-site without a preflight we never grant, and a foreign
      // Origin is rejected outright, so other websites cannot drive the manager.
      const origin = request.headers.origin;
      if (origin && !isLocalOrigin(origin)) throw new HttpError(403, 'Cross-origin requests are not allowed');
      if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) {
        throw new HttpError(415, 'Use content-type: application/json');
      }
    }

    if (request.method === 'GET' && pathname === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      response.write(': connected\n\n');
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }

    const route = match(request.method, pathname);
    if (route) {
      const body = request.method === 'POST' ? await readBody(request) : {};
      let result;
      try {
        result = await route.handler({ params: route.params, body, url });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, error.message);
      }
      sendJson(response, 200, result ?? { ok: true });
      return;
    }

    if (request.method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/internal/')) {
      serveStatic(pathname, response);
      return;
    }
    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('[quietquest] request failed:', error);
      if (!response.headersSent) sendJson(response, status, { error: error.message });
      else response.end();
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();

  return {
    server,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      return new Promise((resolve) => {
        server.close(resolve);
        // Idle keep-alive sockets from the browser would otherwise hold the port open.
        server.closeAllConnections?.();
      });
    },
  };
}
