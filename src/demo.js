import { newId, now } from './util.js';

const MIN = 60 * 1000;

/**
 * Fills a throwaway home with a believable board so the dashboard can be explored
 * (and screenshotted) without any provider login. Live workers here are scripted mocks.
 */
export function seedDemo({ store, workers }) {
  const t0 = now();

  const finishedWorker = ({ task, name, provider, minutesAgo, tookMinutes, report, events, status = 'done', error = '' }) => {
    const id = newId('a');
    const endedAt = t0 - minutesAgo * MIN;
    store.putAgent({
      id,
      name,
      taskId: task.id,
      projectId: task.projectId,
      provider,
      model: '',
      autonomy: 'edit',
      cwd: store.state.projects[task.projectId].dir,
      status,
      sessionId: `demo-${id}`,
      turns: 1,
      nextPrompt: '',
      activity: status === 'done' ? 'Finished' : error,
      result: report,
      error,
      toolCalls: events.filter((e) => e.type === 'tool_call').length,
      usage: { inputTokens: 21000 + events.length * 1800, outputTokens: 2600, costUsd: 0 },
      autoAllow: [],
      createdAt: endedAt - tookMinutes * MIN,
      startedAt: endedAt - tookMinutes * MIN,
      endedAt,
      updatedAt: endedAt,
    });
    for (const event of events) store.appendAgentEvent(id, event);
    if (report) store.appendAgentEvent(id, { type: 'text', text: report });
    store.appendAgentEvent(id, { type: 'status', status, text: status === 'done' ? 'Finished' : error });
    return id;
  };

  // ── Lisbon trip ───────────────────────────────────────────────────────────
  const trip = store.createProject({
    name: 'Lisbon in March',
    goal: 'Five days in Lisbon with Sam, 12–17 March. Walkable base, good food, under €2,400 all in.',
  });
  store.updateProject(trip.id, {
    notes: 'Decided: fly TAP direct from Newark (€612 for two). Sam prefers Alfama or Chiado over Bairro Alto (noise).',
  });
  const [flights, hotels, itinerary, dinners] = [
    ['Compare direct flight options', 'Direct flights only, morning arrival preferred.'],
    ['Shortlist neighbourhoods and hotels', 'Three options under €160 a night, walkable to the centre.'],
    ['Draft a five-day itinerary', 'One anchor activity a day, the rest loose.'],
    ['Reserve two special dinners', 'One seafood, one tasting menu.'],
  ].map(([title, description]) => store.createTask({ projectId: trip.id, title, description }));
  store.updateTask(flights.id, { status: 'done', result: 'TAP direct EWR→LIS, €612 for two, arrives 07:40.' });
  store.updateTask(dinners.id, {
    status: 'blocked',
    blocker: 'Need you to confirm which two evenings are free before I book anything.',
  });
  finishedWorker({
    task: flights,
    name: 'Flight scout',
    provider: 'claude',
    minutesAgo: 42,
    tookMinutes: 6,
    report:
      '**Best option: TAP TP202, EWR→LIS direct, €612 for two.**\n\n- Departs 19:25, arrives 07:40 the next morning\n- United UA64 is €40 cheaper but lands at 10:55\n- Comparison table saved to `notes/flights.md`',
    events: [
      { type: 'prompt', from: 'manager', text: 'Compare direct flights EWR→LIS for 12–17 March for two adults…' },
      { type: 'tool_call', id: 'c1', name: 'WebSearch', input: { query: 'direct flights Newark Lisbon March 12' } },
      { type: 'tool_result', id: 'c1', output: '8 results' },
      { type: 'tool_call', id: 'c2', name: 'WebFetch', input: { url: 'https://www.flytap.com/' } },
      { type: 'tool_result', id: 'c2', output: 'TP202 19:25 → 07:40 (+1) from €306 pp' },
      { type: 'tool_call', id: 'c3', name: 'Write', input: { file_path: 'notes/flights.md' } },
      { type: 'tool_result', id: 'c3', output: 'File created' },
    ],
  });

  // ── Quarterly taxes ───────────────────────────────────────────────────────
  const taxes = store.createProject({
    name: 'Q4 estimated taxes',
    goal: 'Work out the Q4 estimated payment before 15 January and leave a clean paper trail.',
  });
  const [gather, reconcile, estimate] = [
    ['Collect income statements', 'Every 1099 and invoice export for Oct–Dec.'],
    ['Reconcile the expense sheet', 'Match bank export against the categories in expenses.csv.'],
    ['Estimate the Q4 payment', 'Safe-harbour and actual-liability figures side by side.'],
  ].map(([title, description]) => store.createTask({ projectId: taxes.id, title, description }));
  store.updateTask(gather.id, { status: 'done', result: 'Seven statements collected into income/.' });
  finishedWorker({
    task: gather,
    name: 'Collector',
    provider: 'codex',
    minutesAgo: 95,
    tookMinutes: 4,
    report: 'Collected seven statements into `income/` and listed them in `income/INDEX.md`. Two invoices have no matching deposit yet.',
    events: [
      { type: 'prompt', from: 'manager', text: 'Gather every Oct–Dec income statement into income/…' },
      { type: 'tool_call', id: 'c1', name: 'shell', input: { command: 'ls ~/Downloads/statements' } },
      { type: 'tool_result', id: 'c1', output: '1099-nec-acme.pdf\ninvoices-q4.csv' },
      { type: 'tool_call', id: 'c2', name: 'apply_patch', input: { changes: [{ kind: 'add', path: 'income/INDEX.md' }] } },
      { type: 'tool_result', id: 'c2', output: 'add income/INDEX.md' },
    ],
  });

  // ── Portfolio site ────────────────────────────────────────────────────────
  const site = store.createProject({
    name: 'Portfolio site refresh',
    goal: 'New case-study pages and a faster home page before the conference on the 20th.',
  });
  const [audit, cases, deploy] = [
    ['Audit current page speed', 'Lighthouse on home and two case studies.'],
    ['Write three case-study pages', 'From the notes in drafts/.'],
    ['Set up preview deploys', 'Every branch gets a preview URL.'],
  ].map(([title, description]) => store.createTask({ projectId: site.id, title, description }));
  store.updateTask(audit.id, { status: 'done', result: 'Home LCP 3.9s; hero image is 2.4 MB.' });
  store.updateTask(deploy.id, { status: 'blocked', blocker: 'Deploy token rejected (401). Needs a new token from you.' });
  finishedWorker({
    task: deploy,
    name: 'Deployer',
    provider: 'codex',
    minutesAgo: 18,
    tookMinutes: 3,
    status: 'failed',
    error: 'Deploy token rejected (401). Needs a new token.',
    report: '',
    events: [
      { type: 'prompt', from: 'manager', text: 'Configure preview deploys for every branch…' },
      { type: 'tool_call', id: 'c1', name: 'shell', input: { command: 'npx vercel link --yes' } },
      { type: 'tool_result', id: 'c1', output: 'Error: 401 Unauthorized', isError: true },
    ],
  });

  // ── A finished project ────────────────────────────────────────────────────
  const garage = store.createProject({ name: 'Garage sale listings', goal: 'List the bikes and the old amp.' });
  for (const title of ['Photograph and describe items', 'Post listings', 'Draft reply templates']) {
    const task = store.createTask({ projectId: garage.id, title });
    store.updateTask(task.id, { status: 'done', result: 'Done' });
  }
  store.updateProject(garage.id, { status: 'done' });

  // ── Conversation so far ───────────────────────────────────────────────────
  const say = (message, minutesAgo) => store.addChat({ ...message, ts: t0 - minutesAgo * MIN });
  say({ role: 'user', text: "Sam and I want to do Lisbon in March, the 12th to the 17th. Can you get that moving? Budget's about €2,400." }, 50);
  say(
    {
      role: 'pm',
      parts: [
        { type: 'action', tool: 'create_project', label: 'Created project “Lisbon in March”', state: 'ok', projectId: trip.id },
        { type: 'action', tool: 'create_tasks', label: 'Added 4 tasks to Lisbon in March', state: 'ok' },
        { type: 'action', tool: 'spawn_worker', label: 'Started Flight scout on “Compare direct flight options”', state: 'ok' },
        { type: 'text', text: "On it. I've split the trip into flights, where to stay, the itinerary, and dinners, and started on flights since everything else hangs off the arrival time." },
      ],
    },
    49,
  );
  say({ role: 'event', outcome: 'done', text: 'Flight scout finished “Compare direct flight options”' }, 42);
  say(
    {
      role: 'pm',
      parts: [
        { type: 'action', tool: 'update_task', label: 'Marked “Compare direct flight options” done', state: 'ok' },
        { type: 'action', tool: 'spawn_worker', label: 'Started Stay finder on “Shortlist neighbourhoods and hotels”', state: 'ok' },
        { type: 'text', text: 'Flights: **TAP direct from Newark, €612 for two**, landing 07:40. I have someone on hotels now.\n\nOne thing I need from you: which two evenings should I hold for the special dinners?' },
      ],
    },
    41,
  );
  say({ role: 'user', text: 'Also the site: the deploy thing is still broken, and I need the case studies written up.' }, 20);
  say(
    {
      role: 'pm',
      parts: [
        { type: 'action', tool: 'spawn_worker', label: 'Started Deployer on “Set up preview deploys”', state: 'ok' },
        { type: 'action', tool: 'spawn_worker', label: 'Started Writer on “Write three case-study pages”', state: 'ok' },
        { type: 'text', text: 'Both are under way.' },
      ],
    },
    19,
  );
  say({ role: 'event', outcome: 'failed', text: 'Deployer failed on “Set up preview deploys”' }, 18);
  say(
    {
      role: 'pm',
      parts: [
        { type: 'action', tool: 'update_task', label: 'Marked “Set up preview deploys” blocked', state: 'ok' },
        { type: 'text', text: "Preview deploys are blocked: the deploy token is being rejected (401). I can't fix that from here. If you paste a new token into the project's `.env`, I'll rerun it." },
      ],
    },
    17,
  );

  store.setMemory('- Travels with Sam; Sam is vegetarian.\n- Prefers morning arrivals and direct flights.\n- Wants bad news first, in one line.\n');

  // ── Live (scripted) workers ───────────────────────────────────────────────
  workers.spawn({
    taskId: hotels.id,
    name: 'Stay finder',
    provider: 'claude',
    instructions: 'Shortlist three hotels in Alfama or Chiado under €160 a night for 12–17 March…',
  });
  workers.spawn({
    taskId: reconcile.id,
    name: 'Bookkeeper',
    provider: 'codex',
    instructions: 'Reconcile expenses.csv against the bank export; flag anything uncategorised…',
    mock: { approval: true },
  });
  workers.spawn({
    taskId: cases.id,
    name: 'Writer',
    provider: 'claude',
    instructions: 'Write three case-study pages from drafts/ in the existing page style…',
  });

  return { trip, taxes, site, garage, itinerary, estimate };
}
