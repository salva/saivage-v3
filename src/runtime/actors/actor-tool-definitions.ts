import { ALL_TOOL_DEFINITIONS_BY_NAME } from '../../tools/definitions/index.js';
import type { ToolDefinition } from '../../agents/llm-contracts.js';

const activateCardTool = ALL_TOOL_DEFINITIONS_BY_NAME.get('activate_card');
if (!activateCardTool) throw new Error("Missing required planner tool definition 'activate_card'.");

export const XSTATE_PLANNER_TOOL_DEFINITIONS: ToolDefinition[] = [activateCardTool];

export const XSTATE_PROCESS_TOOL_DEFINITIONS: ToolDefinition[] = [
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
