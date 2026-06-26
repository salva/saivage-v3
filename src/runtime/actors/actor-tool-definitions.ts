import { PLANNER_TOOL_DEFINITIONS } from '../../tools/definitions/index.js';
import type { ToolDefinition } from '../../agents/llm-contracts.js';

function requiredPlannerTool(name: string): ToolDefinition {
  const tool = PLANNER_TOOL_DEFINITIONS.find((candidate) => candidate.function.name === name);
  if (!tool) throw new Error(`Missing required planner tool definition '${name}'.`);
  return tool;
}

export const PLANNER_ACTOR_SURFACE_TOOL_DEFINITIONS: ToolDefinition[] = [
  requiredPlannerTool('create_card'),
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
