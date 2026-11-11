import { createClaudeProvider } from './claude.js';
import { createCodexProvider } from './codex.js';
import { createMockProvider } from './mock.js';

/**
 * Provider registry. In demo mode the same ids are served by scripted mocks, so the
 * dashboard looks and behaves the same without touching either subscription.
 */
export function createProviders(getConfig, { demo = false, speed } = {}) {
  const list = demo
    ? [
        createMockProvider({ id: 'claude', label: 'Claude', speed }),
        createMockProvider({ id: 'codex', label: 'OpenAI', speed }),
      ]
    : [createClaudeProvider(getConfig), createCodexProvider(getConfig)];
  const byId = new Map(list.map((provider) => [provider.id, provider]));
  let status = {};

  return {
    ids: () => [...byId.keys()],
    get(id) {
      const provider = byId.get(id);
      if (!provider) throw new Error(`Unknown provider "${id}". Use one of: ${[...byId.keys()].join(', ')}`);
      return provider;
    },
    has: (id) => byId.has(id),
    status: () => status,
    async refresh() {
      const entries = await Promise.all(
        list.map(async (provider) => [provider.id, { id: provider.id, label: provider.label, ...(await provider.detect()) }]),
      );
      status = Object.fromEntries(entries);
      return status;
    },
  };
}
