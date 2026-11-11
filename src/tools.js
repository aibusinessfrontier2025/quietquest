import { AUTONOMY_LEVELS, PROJECT_STATUSES, TASK_STATUSES } from './store.js';
import { truncate } from './util.js';

const str = (description) => ({ type: 'string', description });

/**
 * The manager's toolbox, plus the single approval tool workers use. Defined once here and
 * served to the CLIs through the MCP bridge, so every provider gets identical tools.
 */
export function createTools({ store, workers, providers }) {
  const projectView = (project) => {
    const tasks = Object.values(store.state.tasks).filter((t) => t.projectId === project.id);
    return {
      id: project.id,
      name: project.name,
      status: project.status,
      goal: project.goal,
      notes: project.notes,
      dir: project.dir,
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        description: task.description,
        result: task.result,
        blocker: task.blocker,
        workers: Object.values(store.state.agents)
          .filter((a) => a.taskId === task.id)
          .map((a) => ({ id: a.id, name: a.name, provider: a.provider, status: a.status })),
      })),
    };
  };

  const requireProject = (id) => {
    const project = store.state.projects[id];
    if (!project) throw new Error(`No project with id ${id}. Call list_projects to see valid ids.`);
    return project;
  };

  const pick = (source, keys) => {
    const out = {};
    for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
    return out;
  };

  const manager = {
    list_projects: {
      description: 'List every project with its status and task counts.',
      schema: { type: 'object', properties: {} },
      run: () =>
        Object.values(store.state.projects).map((project) => {
          const tasks = Object.values(store.state.tasks).filter((t) => t.projectId === project.id);
          const counts = {};
          for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
          return { id: project.id, name: project.name, status: project.status, goal: project.goal, tasks: counts };
        }),
    },

    get_project: {
      description: 'Full detail for one project: goal, notes, every task, and the workers on each task.',
      schema: { type: 'object', properties: { project_id: str('Project id, e.g. p_1a2b3c4d') }, required: ['project_id'] },
      run: ({ project_id }) => projectView(requireProject(project_id)),
    },

    create_project: {
      description:
        'Create a project. Each project gets its own working folder that its workers share. ' +
        'Pass dir to use an existing folder (for example a code repository) instead of a new one.',
      schema: {
        type: 'object',
        properties: {
          name: str('Short human name, e.g. "Kitchen renovation"'),
          goal: str('What the user wants out of this project, in a sentence or two'),
          dir: str('Optional absolute path of an existing folder to work in'),
        },
        required: ['name', 'goal'],
      },
      run: ({ name, goal, dir }) => {
        const project = store.createProject({ name, goal, dir });
        return { id: project.id, name: project.name, dir: project.dir };
      },
    },

    update_project: {
      description:
        'Change a project. notes replaces the whole notes field: keep it as the running brief of decisions ' +
        'and facts that future workers need.',
      schema: {
        type: 'object',
        properties: {
          project_id: str('Project id'),
          name: str('New name'),
          goal: str('New goal'),
          notes: str('Full replacement for the project notes (markdown)'),
          status: { type: 'string', enum: PROJECT_STATUSES },
        },
        required: ['project_id'],
      },
      run: (args) => {
        requireProject(args.project_id);
        const project = store.updateProject(args.project_id, pick(args, ['name', 'goal', 'notes', 'status']));
        return { id: project.id, status: project.status };
      },
    },

    create_tasks: {
      description: 'Add one or more tasks to a project. Size each task so a single worker can finish it in one sitting.',
      schema: {
        type: 'object',
        properties: {
          project_id: str('Project id'),
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: str('Short imperative title'),
                description: str('What done looks like'),
              },
              required: ['title'],
            },
          },
        },
        required: ['project_id', 'tasks'],
      },
      run: ({ project_id, tasks }) => {
        requireProject(project_id);
        if (!Array.isArray(tasks) || !tasks.length) throw new Error('tasks must be a non-empty array');
        const created = tasks.map((task) =>
          store.createTask({ projectId: project_id, title: task.title, description: task.description }),
        );
        return { tasks: created.map((t) => ({ id: t.id, title: t.title })) };
      },
    },

    update_task: {
      description:
        'Change a task. Set status to done with a one-line result once you have reviewed the work, ' +
        'or to blocked with a blocker that says exactly what is needed and from whom.',
      schema: {
        type: 'object',
        properties: {
          task_id: str('Task id'),
          status: { type: 'string', enum: TASK_STATUSES },
          title: str('New title'),
          description: str('New description'),
          result: str('One-line outcome, shown on the dashboard'),
          blocker: str('What is blocking this task'),
        },
        required: ['task_id'],
      },
      run: (args) => {
        const patch = pick(args, ['status', 'title', 'description', 'result', 'blocker']);
        if (patch.status && patch.status !== 'blocked' && patch.blocker === undefined) patch.blocker = '';
        const task = store.updateTask(args.task_id, patch);
        return { id: task.id, status: task.status };
      },
    },

    spawn_worker: {
      description:
        'Start a worker agent on a task. It runs in the background in the project folder and its report ' +
        'comes back to you as an event when it stops. The worker sees only the project goal and notes, ' +
        'the task, and your instructions, so make the instructions complete.',
      schema: {
        type: 'object',
        properties: {
          task_id: str('Task the worker is for'),
          instructions: str('The full brief: purpose, what done looks like, constraints, where outputs go, what to report'),
          name: str('Short role name shown on the dashboard, e.g. "Researcher"'),
          provider: { type: 'string', enum: providers.ids(), description: 'Which subscription runs it. Omit for the default.' },
          model: str('Optional model override for that provider'),
          autonomy: { type: 'string', enum: AUTONOMY_LEVELS, description: 'read, edit (default), or full' },
        },
        required: ['task_id', 'instructions'],
      },
      run: ({ task_id, instructions, name, provider, model, autonomy }) => {
        const agent = workers.spawn({ taskId: task_id, instructions, name, provider, model, autonomy });
        return { worker_id: agent.id, status: agent.status, provider: agent.provider, autonomy: agent.autonomy };
      },
    },

    message_worker: {
      description:
        'Send a follow-up to a worker. It keeps the context of its earlier work, so this is the cheapest way ' +
        'to ask for a fix or a next step on the same task. Works on finished workers too.',
      schema: {
        type: 'object',
        properties: { worker_id: str('Worker id'), message: str('What you want it to do next') },
        required: ['worker_id', 'message'],
      },
      run: ({ worker_id, message }) => workers.message(worker_id, message, 'manager'),
    },

    stop_worker: {
      description: 'Stop a running or queued worker.',
      schema: { type: 'object', properties: { worker_id: str('Worker id') }, required: ['worker_id'] },
      run: ({ worker_id }) => {
        const agent = workers.stop(worker_id, 'manager');
        return { worker_id: agent.id, status: 'stopping' };
      },
    },

    get_worker: {
      description: "A worker's status, latest activity, and its most recent report.",
      schema: { type: 'object', properties: { worker_id: str('Worker id') }, required: ['worker_id'] },
      run: ({ worker_id }) => {
        const agent = store.state.agents[worker_id];
        if (!agent) throw new Error(`No worker with id ${worker_id}`);
        const recent = store
          .readAgentEvents(worker_id)
          .filter((e) => e.type === 'tool_call' || e.type === 'text')
          .slice(-8)
          .map((e) => (e.type === 'text' ? truncate(e.text, 300) : `${e.name} ${truncate(JSON.stringify(e.input), 160)}`));
        return {
          id: agent.id,
          name: agent.name,
          status: agent.status,
          provider: agent.provider,
          task_id: agent.taskId,
          activity: agent.activity,
          error: agent.error,
          report: truncate(agent.result, 6000),
          recent,
        };
      },
    },

    remember: {
      description:
        'Save a durable fact about the user that should apply across all projects (a preference, a person, ' +
        'a standing instruction). One fact per call.',
      schema: { type: 'object', properties: { note: str('The fact, in one sentence') }, required: ['note'] },
      run: ({ note }) => {
        const current = store.getMemory().trimEnd();
        store.setMemory(`${current ? `${current}\n` : ''}- ${String(note).trim()}\n`);
        return { saved: true };
      },
    },

    rewrite_memory: {
      description: 'Replace the whole memory file. Use to correct or remove facts that are no longer true.',
      schema: { type: 'object', properties: { content: str('Full new memory content (markdown list)') }, required: ['content'] },
      run: ({ content }) => {
        store.setMemory(`${String(content).trimEnd()}\n`);
        return { saved: true };
      },
    },
  };

  const worker = {
    approve: {
      description: 'Internal: asks the user to approve an action. Called by the harness, not by you.',
      schema: {
        type: 'object',
        properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
        required: ['tool_name'],
      },
      run: ({ tool_name, input }, { agentId }) => workers.requestApproval(agentId, tool_name, input ?? {}),
    },
  };

  const sets = { pm: manager, worker };

  return {
    list(role) {
      return Object.entries(sets[role] ?? {}).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.schema,
      }));
    },

    /** Runs a tool. Failures come back as text the model can read and correct. */
    async call(role, name, args, context = {}) {
      const tool = sets[role]?.[name];
      if (!tool) return { isError: true, text: `Unknown tool "${name}"` };
      try {
        const value = await tool.run(args ?? {}, context);
        return { isError: false, text: JSON.stringify(value), value };
      } catch (error) {
        return { isError: true, text: error.message };
      }
    },
  };
}
