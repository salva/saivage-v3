import { ALL_TOOL_DEFINITIONS_BY_NAME } from '../../tools/definitions/index.js';
import type { ToolDefinition } from '../../agents/llm-contracts.js';

function requiredTool(name: string): ToolDefinition {
  const tool = ALL_TOOL_DEFINITIONS_BY_NAME.get(name);
  if (!tool) throw new Error(`Missing required tool definition '${name}'.`);
  return tool;
}

const REVIEWER_FILE_TOOL_DEFINITIONS = ['read', 'write', 'glob', 'grep', 'edit'].map(requiredTool);
const EXECUTOR_FILE_TOOL_DEFINITIONS = ['read', 'write', 'glob', 'grep', 'edit', 'apply_patch'].map(requiredTool);
const WEB_TOOL_DEFINITIONS = ['websearch', 'webfetch'].map(requiredTool);
const CARD_HISTORY_TOOL_DEFINITIONS = ['list_card_history', 'get_card_history_entry', 'diff_card'].map(requiredTool);
const SKILL_TOOL_DEFINITIONS = ['skill'].map(requiredTool);
const MCP_TOOL_DEFINITIONS = ['mcp_tool_call'].map(requiredTool);

export const REVIEWER_CARD_PROCESSOR_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...REVIEWER_FILE_TOOL_DEFINITIONS,
  ...CARD_HISTORY_TOOL_DEFINITIONS,
  ...WEB_TOOL_DEFINITIONS,
  ...SKILL_TOOL_DEFINITIONS,
  ...MCP_TOOL_DEFINITIONS,
];

export const TERMINAL_CARD_PROCESSOR_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...EXECUTOR_FILE_TOOL_DEFINITIONS,
  ...CARD_HISTORY_TOOL_DEFINITIONS,
  ...WEB_TOOL_DEFINITIONS,
  ...SKILL_TOOL_DEFINITIONS,
  ...MCP_TOOL_DEFINITIONS,
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
