import { ALL_TOOL_DEFINITIONS_BY_NAME, PLANNER_TOOL_DEFINITIONS } from '../../tools/definitions/index.js';
import type { ToolDefinition } from '../../agents/llm-contracts.js';
import { cardTypeValues, urgencyValues } from '../../schemas/index.js';

function requiredPlannerTool(name: string): ToolDefinition {
  const tool = PLANNER_TOOL_DEFINITIONS.find((candidate) => candidate.function.name === name);
  if (!tool) throw new Error(`Missing required planner tool definition '${name}'.`);
  return tool;
}

function requiredTool(name: string): ToolDefinition {
  const tool = ALL_TOOL_DEFINITIONS_BY_NAME.get(name);
  if (!tool) throw new Error(`Missing required tool definition '${name}'.`);
  return tool;
}

const PLANNER_FILE_TOOL_DEFINITIONS = ['read', 'write', 'glob', 'grep', 'edit'].map(requiredTool);
const REVIEWER_FILE_TOOL_DEFINITIONS = ['read', 'write', 'glob', 'grep', 'edit'].map(requiredTool);
const EXECUTOR_FILE_TOOL_DEFINITIONS = ['read', 'write', 'glob', 'grep', 'edit', 'apply_patch'].map(requiredTool);

export const PLANNER_ACTOR_SURFACE_TOOL_DEFINITIONS: ToolDefinition[] = [
  plannerCreateCardDefinition(),
  plannerEditCardDefinition(),
  plannerCancelCardDefinition(),
];

export const PLANNER_CARD_PROCESSOR_TOOL_DEFINITIONS: ToolDefinition[] = [
  requiredPlannerTool('activate_card'),
  ...PLANNER_ACTOR_SURFACE_TOOL_DEFINITIONS,
  ...PLANNER_FILE_TOOL_DEFINITIONS,
];

export const REVIEWER_CARD_PROCESSOR_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...REVIEWER_FILE_TOOL_DEFINITIONS,
];

export const TERMINAL_CARD_PROCESSOR_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...EXECUTOR_FILE_TOOL_DEFINITIONS,
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command. Set wait=false to start a background process for later wait_process or kill_process.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run.' },
          cwd: { type: 'string', description: 'Scoped working directory. Defaults to project://.' },
          timeout_ms: { type: 'number', description: 'Milliseconds to wait before returning.' },
          inactivity_timeout_ms: { type: 'number', description: 'Reserved for provider-specific inactivity limits.' },
          wait: { type: 'boolean', description: 'When false, start in background and return process_id immediately.' },
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
      description: 'Wait for a process owned by this activation. Use timeout_ms=0 for non-blocking inspection.',
      parameters: processIdSchema({ includeTimeout: true }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_process',
      description: 'Signal a process owned by this activation. Defaults to SIGTERM.',
      parameters: processIdSchema({ includeTimeout: false }),
    },
  },
];

function processIdSchema(input: { includeTimeout: boolean }): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      process_id: { type: 'string', description: 'Process id returned by run_command.' },
      ...(input.includeTimeout ? { timeout_ms: { type: 'number', description: 'Milliseconds to wait before returning a running status.' } } : {}),
    },
    required: ['process_id'],
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
          brief: { type: 'string', description: 'Full brief.md content with Goal, Instructions, and Acceptance Criteria sections.' },
          status: { type: 'string', enum: ['backlog'], description: 'Optional initial status. Planner-created children can only start as backlog.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
          priority: { type: 'number', description: 'Optional priority value.' },
          urgency: { type: 'string', enum: urgencyValues, description: 'Optional urgency level.' },
          depends_on: { type: 'array', items: { type: 'string' }, description: 'Immediate sibling dependencies.' },
          related: { type: 'array', items: { type: 'string' }, description: 'Related immediate child cards.' },
        },
        required: ['type', 'title', 'brief'],
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
