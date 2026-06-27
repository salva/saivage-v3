import { PLANNER_TOOL_DEFINITIONS } from '../../tools/definitions/index.js';
import type { ToolDefinition } from '../../agents/llm-contracts.js';
import { cardTypeValues, urgencyValues } from '../../schemas/index.js';

function requiredPlannerTool(name: string): ToolDefinition {
  const tool = PLANNER_TOOL_DEFINITIONS.find((candidate) => candidate.function.name === name);
  if (!tool) throw new Error(`Missing required planner tool definition '${name}'.`);
  return tool;
}

export const PLANNER_ACTOR_SURFACE_TOOL_DEFINITIONS: ToolDefinition[] = [
  plannerCreateCardDefinition(),
  plannerEditCardDefinition(),
  plannerCancelCardDefinition(),
];

export const PLANNER_CARD_PROCESSOR_TOOL_DEFINITIONS: ToolDefinition[] = [
  requiredPlannerTool('activate_card'),
  ...PLANNER_ACTOR_SURFACE_TOOL_DEFINITIONS,
];

export const TERMINAL_CARD_PROCESSOR_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'run_process',
      description: 'Start a process for this terminal card and optionally wait for initial output without killing the process on timeout.',
      parameters: {
        type: 'object',
        properties: {
          processId: { type: 'string', description: 'Optional stable process id for later wait, inspect, or kill calls.' },
          command: { type: 'string', description: 'Executable command to run.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Command arguments.' },
          timeoutMs: { type: 'number', description: 'Milliseconds to wait for completion before returning a running status.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_process',
      description: 'Wait for a previously started process and return accumulated output.',
      parameters: processIdSchema({ includeTimeout: true }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_process',
      description: 'Inspect a previously started process without waiting for completion.',
      parameters: processIdSchema({ includeTimeout: false }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_process',
      description: 'Explicitly kill a previously started process.',
      parameters: processIdSchema({ includeTimeout: false }),
    },
  },
];

function processIdSchema(input: { includeTimeout: boolean }): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      processId: { type: 'string', description: 'Process id returned by run_process or supplied when starting the process.' },
      ...(input.includeTimeout ? { timeoutMs: { type: 'number', description: 'Milliseconds to wait before returning a running status.' } } : {}),
    },
    required: ['processId'],
    additionalProperties: false,
  };
}

function plannerCreateCardDefinition(): ToolDefinition {
  const existing = requiredPlannerTool('create_card');
  return {
    ...existing,
    function: {
      ...existing.function,
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: cardTypeValues.filter((type) => type !== 'project'), description: 'The non-project child card type.' },
          title: { type: 'string', description: 'A short child-card title.' },
          description: { type: 'string', description: 'Detailed child-card instructions.' },
          status: { type: 'string', enum: ['backlog'], description: 'Optional initial status. Planner-created children can only start as backlog.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
          priority: { type: 'number', description: 'Optional priority value.' },
          urgency: { type: 'string', enum: urgencyValues, description: 'Optional urgency level.' },
          acceptance: { type: 'string', description: 'Acceptance criteria.' },
          depends_on: { type: 'array', items: { type: 'string' }, description: 'Immediate sibling dependencies.' },
          related: { type: 'array', items: { type: 'string' }, description: 'Related immediate child cards.' },
        },
        required: ['type', 'title'],
        additionalProperties: false,
      },
    },
  };
}

function plannerEditCardDefinition(): ToolDefinition {
  const existing = requiredPlannerTool('edit_card');
  return {
    ...existing,
    function: {
      ...existing.function,
      description: 'Edit one non-running immediate child card of the current planner card. Failed or blocked children are reopened to changed.',
      parameters: {
        type: 'object',
        properties: {
          card_id: { type: 'string', description: 'The immediate child card ID to edit.' },
          title: { type: 'string', description: 'New title.' },
          description: { type: 'string', description: 'New description.' },
          acceptance: { type: 'string', description: 'New acceptance criteria.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'New tags.' },
          priority: { type: 'number', description: 'New priority value.' },
          urgency: { type: 'string', enum: urgencyValues, description: 'New urgency level.' },
          related: { type: 'array', items: { type: 'string' }, description: 'New related-card IDs.' },
        },
        required: ['card_id'],
        additionalProperties: false,
      },
    },
  };
}

function plannerCancelCardDefinition(): ToolDefinition {
  const existing = requiredPlannerTool('cancel_card');
  return {
    ...existing,
    function: {
      ...existing.function,
      parameters: {
        type: 'object',
        properties: {
          card_id: { type: 'string', description: 'The immediate child card ID to cancel.' },
          reason: { type: 'string', description: 'Optional cancellation reason.' },
        },
        required: ['card_id'],
        additionalProperties: false,
      },
    },
  };
}
