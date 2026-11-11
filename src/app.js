import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Manager } from './manager.js';
import { createProviders } from './providers/index.js';
import { createServer } from './server.js';
import { Store } from './store.js';
import { createTools } from './tools.js';
import { Workers } from './workers.js';

const BRIDGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-bridge.js');

/** Wires the pieces together. Nothing touches the network or disk until start(). */
export function createApp({ home, port, demo = false, speed } = {}) {
  const store = new Store(home);
  const providers = createProviders(() => store.config, { demo, speed });
  const token = randomBytes(24).toString('hex');

  // How a CLI reaches back into this process: a stdio MCP server that calls our loopback API.
  const bridge = {
    url: null,
    spec({ role, agentId = '' }) {
      return {
        command: process.execPath,
        args: [BRIDGE_PATH],
        env: { QQ_URL: bridge.url, QQ_TOKEN: token, QQ_ROLE: role, QQ_AGENT_ID: agentId },
      };
    },
  };

  let manager;
  const workers = new Workers({ store, providers, bridge, onFinished: (item) => manager.notify(item) });
  const tools = createTools({ store, workers, providers });
  manager = new Manager({ store, providers, tools, bridge });
  const http = createServer({ store, manager, workers, tools, providers, token, demo });

  return {
    store,
    providers,
    workers,
    manager,
    tools,
    bridge,
    token,
    url: null,

    async start() {
      const actualPort = await http.listen(port ?? store.config.port);
      this.url = bridge.url = `http://127.0.0.1:${actualPort}`;
      workers.recover();
      // Version and login checks shell out, so they run after the dashboard is reachable.
      providers.refresh().then((status) => store.broadcast('providers', status));
      return this.url;
    },

    async stop() {
      await Promise.all([manager.shutdown(), workers.shutdown()]);
      store.flush();
      await http.close();
    },
  };
}
