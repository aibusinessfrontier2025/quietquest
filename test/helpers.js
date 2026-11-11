import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

/** A started app on a random port with scripted providers and a throwaway home. */
export async function startTestApp(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quietquest-test-'));
  const app = createApp({ home, port: 0, demo: true, speed: 2, ...options });
  await app.start();
  return {
    app,
    home,
    async close() {
      await app.stop();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export async function waitFor(check, { timeout = 5000, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
