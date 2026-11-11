#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { seedDemo } from '../src/demo.js';

const HELP = `QuietQuest: one conversation, every project.

Usage
  quietquest [start]      Start the manager and open the dashboard
  quietquest doctor       Check that the Claude and Codex CLIs are installed and signed in

Options
  --port <n>     Port for the dashboard (default 4747)
  --home <dir>   Where state lives (default ~/.quietquest, or $QUIETQUEST_HOME)
  --demo         Explore with a sample board and scripted workers; uses no subscription
  --no-open      Do not open the browser
  -h, --help     Show this help
`;

function parseArgs(argv) {
  const options = { command: 'start', open: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'start' || arg === 'doctor') options.command = arg;
    else if (arg === '--demo') options.demo = true;
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--home') options.home = path.resolve(argv[++i]);
    else if (arg === '-h' || arg === '--help') options.command = 'help';
    else {
      console.error(`Unknown argument: ${arg}\n\n${HELP}`);
      process.exit(2);
    }
  }
  return options;
}

function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser to open (headless machine); the URL is printed either way.
  }
}

async function doctor(options) {
  const app = createApp({ home: options.home });
  const status = await app.providers.refresh();
  let ready = 0;
  for (const provider of Object.values(status)) {
    const ok = provider.installed && provider.loggedIn;
    if (ok) ready += 1;
    const state = !provider.installed ? 'not installed' : provider.loggedIn ? 'ready' : 'not signed in';
    console.log(`${ok ? '✓' : '✗'} ${provider.label.padEnd(7)} ${state}${provider.version ? `  (v${provider.version})` : ''}  ${provider.detail ?? ''}`);
    if (provider.fix) console.log(`    → ${provider.fix}`);
  }
  console.log(ready ? `\n${ready} of ${Object.keys(status).length} providers ready.` : '\nNo provider is ready yet.');
  process.exit(ready ? 0 : 1);
}

async function start(options) {
  let home = options.home;
  if (options.demo && !home) home = fs.mkdtempSync(path.join(os.tmpdir(), 'quietquest-demo-'));

  const app = createApp({ home, port: options.port, demo: options.demo, speed: options.demo ? 1500 : undefined });
  let url;
  try {
    url = await app.start();
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${options.port ?? app.store.config.port} is already in use. Is QuietQuest already running? Try --port.`);
      process.exit(1);
    }
    throw error;
  }
  if (options.demo) seedDemo(app);

  console.log(`\n  QuietQuest${options.demo ? ' (demo)' : ''} is running at ${url}`);
  console.log(`  State: ${app.store.home}\n  Press Ctrl+C to stop.\n`);
  if (options.open) openBrowser(url);

  let closing = false;
  const shutdown = async () => {
    // A second Ctrl+C means "now".
    if (closing) process.exit(1);
    closing = true;
    console.log('\nStopping workers…');
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const options = parseArgs(process.argv.slice(2));
if (options.command === 'help') console.log(HELP);
else if (options.command === 'doctor') await doctor(options);
else await start(options);
