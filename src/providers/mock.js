/**
 * A scripted stand-in for a real CLI. It powers `--demo` and the test suite, so the whole
 * manager → worker → review loop can run without spending any subscription usage.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WORKER_SCRIPTS = [
  [
    { type: 'thinking', text: 'Starting with what already exists before changing anything.' },
    { type: 'tool_call', name: 'Glob', input: { pattern: '**/*' } },
    { type: 'tool_result', output: 'README.md\nnotes/brief.md\nnotes/open-questions.md' },
    { type: 'tool_call', name: 'Read', input: { file_path: 'notes/brief.md' } },
    { type: 'tool_result', output: '# Brief\nGoal, constraints, and what "done" looks like.' },
    { type: 'text', text: 'I have the brief. Gathering sources next.' },
    { type: 'tool_call', name: 'WebSearch', input: { query: 'current options and prices' } },
    { type: 'tool_result', output: '5 results' },
    { type: 'tool_call', name: 'Write', input: { file_path: 'notes/findings.md' } },
    { type: 'tool_result', output: 'File created' },
  ],
  [
    { type: 'tool_call', name: 'Read', input: { file_path: 'README.md' } },
    { type: 'tool_result', output: '# Project\nSee notes/ for context.' },
    { type: 'tool_call', name: 'Bash', input: { command: 'ls -la && git status --short' }, gated: true },
    { type: 'tool_result', output: 'total 12\n M notes/plan.md' },
    { type: 'text', text: 'Drafting the plan now.' },
    { type: 'tool_call', name: 'Edit', input: { file_path: 'notes/plan.md' } },
    { type: 'tool_result', output: 'Applied 1 edit' },
    { type: 'tool_call', name: 'Bash', input: { command: 'npm test' }, gated: true },
    { type: 'tool_result', output: '12 passing' },
  ],
];

function hash(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function titleFrom(text) {
  const words = String(text).replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim().split(/\s+/).slice(0, 6);
  const title = words.join(' ');
  return title ? title[0].toUpperCase() + title.slice(1) : 'New project';
}

async function runWorker({ meta, onEvent, requestApproval, speed, isStopped }) {
  // Approval demos need the script that contains gated steps.
  const script = meta?.mock?.approval
    ? WORKER_SCRIPTS[1]
    : WORKER_SCRIPTS[hash(meta?.title ?? '') % WORKER_SCRIPTS.length];
  let callId = 0;
  let denied = false;
  for (const step of script) {
    await sleep(speed);
    if (isStopped()) return { ok: false };
    if (step.type === 'tool_call') {
      callId += 1;
      onEvent({ ...step, gated: undefined, id: `call_${callId}` });
      if (step.gated && meta?.mock?.approval && requestApproval) {
        const verdict = await requestApproval(step.name, step.input);
        denied = verdict.behavior !== 'allow';
      }
    } else if (step.type === 'tool_result') {
      onEvent({ ...step, id: `call_${callId}`, output: denied ? 'Denied by you' : step.output, isError: denied });
      denied = false;
    } else {
      onEvent(step);
    }
  }
  await sleep(speed);
  if (meta?.mock?.fail) {
    return { ok: false, error: 'The source site kept returning 503; I could not finish the comparison.' };
  }
  const text = [
    `**Done: ${meta?.title ?? 'task'}**`,
    '',
    '- Reviewed the existing notes and gathered what was missing',
    '- Wrote the result into `notes/` in the project folder',
    '- Nothing is blocked; one open question is listed at the end of the file',
  ].join('\n');
  onEvent({ type: 'text', text });
  onEvent({ type: 'usage', inputTokens: 18400 + (hash(meta?.title) % 9000), outputTokens: 2100, costUsd: 0 });
  return { ok: true, text };
}

async function runManager({ meta, onEvent, callTool, speed, isStopped }) {
  const say = async (text) => {
    for (const word of text.split(/(?<=\s)/)) {
      if (isStopped()) return;
      onEvent({ type: 'text_delta', text: word });
      await sleep(Math.min(speed / 12, 30));
    }
    onEvent({ type: 'text', text });
  };
  const tool = async (name, input) => {
    const id = `pm_${Math.random().toString(36).slice(2, 8)}`;
    onEvent({ type: 'tool_call', id, name: `mcp__quietquest__${name}`, input });
    const output = await callTool(name, input);
    onEvent({ type: 'tool_result', id, output: JSON.stringify(output), isError: false });
    return output;
  };

  const replies = [];
  for (const item of meta?.items ?? []) {
    if (isStopped()) break;
    await sleep(speed);
    if (item.kind === 'user') {
      const project = await tool('create_project', { name: titleFrom(item.text), goal: item.text });
      const created = await tool('create_tasks', {
        project_id: project.id,
        tasks: [
          { title: 'Research and scope', description: 'Find out what exists and what is missing.' },
          { title: 'Draft the plan', description: 'Turn the research into a concrete plan.' },
          { title: 'Do the first concrete step', description: 'Act on the top item of the plan.' },
        ],
      });
      const [first, second] = created.tasks;
      await tool('spawn_worker', {
        task_id: first.id,
        name: 'Researcher',
        instructions: 'Research the topic and write findings to notes/findings.md.',
        provider: 'claude',
      });
      await tool('spawn_worker', {
        task_id: second.id,
        name: 'Planner',
        instructions: 'Draft a step-by-step plan in notes/plan.md.',
        provider: 'codex',
      });
      replies.push(
        `I've set up **${project.name}** with three tasks and put two workers on the first two. ` +
          `I'll review their reports as they land and start the third once the plan exists.`,
      );
    } else if (item.kind === 'worker') {
      if (item.ok) {
        await tool('update_task', { task_id: item.taskId, status: 'done', result: 'Report reviewed and accepted.' });
        const project = await callTool('get_project', { project_id: item.projectId });
        const next = project.tasks.find((t) => t.status === 'todo');
        const busy = project.tasks.some((t) => t.status === 'in_progress');
        if (next && !busy) {
          await tool('spawn_worker', {
            task_id: next.id,
            name: 'Builder',
            instructions: `Carry out: ${next.title}.`,
          });
          replies.push(`**${item.title}** is done. I've started **${next.title}**.`);
        } else if (project.tasks.every((t) => t.status === 'done' || t.status === 'cancelled')) {
          await tool('update_project', { project_id: item.projectId, status: 'done' });
          replies.push(`**${item.title}** is done, which completes **${project.name}**.`);
        } else {
          replies.push(`**${item.title}** is done.`);
        }
      } else {
        await tool('update_task', {
          task_id: item.taskId,
          status: 'blocked',
          blocker: item.error || 'The worker failed.',
        });
        replies.push(`**${item.title}** hit a problem and I've marked it blocked: ${item.error}`);
      }
    }
  }
  const text = replies.join('\n\n') || 'Noted.';
  await say(text);
  onEvent({ type: 'usage', inputTokens: 5200, outputTokens: 340, costUsd: 0 });
  return { ok: true, text };
}

export function createMockProvider({ id = 'mock', label = 'Mock', speed = 500 } = {}) {
  return {
    id,
    label,
    supportsApprovals: true,
    isMock: true,

    async detect() {
      return { installed: true, version: 'demo', loggedIn: true, detail: 'simulated', fix: null };
    },

    run({ role, sessionId, meta, onEvent, callTool, requestApproval }) {
      let stopped = false;
      const isStopped = () => stopped;
      const session = sessionId || `mock-${Math.random().toString(36).slice(2, 10)}`;
      const done = (async () => {
        onEvent({ type: 'session', sessionId: session });
        const outcome =
          role === 'pm'
            ? await runManager({ meta, onEvent, callTool, speed, isStopped })
            : await runWorker({ meta, onEvent, requestApproval, speed, isStopped });
        if (stopped) return { ok: false, stopped: true, error: 'Stopped', sessionId: session };
        return { error: null, ...outcome, sessionId: session };
      })();
      return {
        pid: null,
        done,
        stop() {
          stopped = true;
        },
      };
    },
  };
}
