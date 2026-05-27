import type { ToolDefinition } from './llm-contracts.js';
import { ANALYST_TOOL_DEFINITIONS } from './analyst-tool-schemas.js';
import { LOAD_SKILL_TOOL_DEFINITION, MCP_TOOL_CALL_TOOL_DEFINITION } from './skill-tools.js';
import { READ_ONLY_WORKSPACE_TOOL_DEFINITIONS, WORKSPACE_TOOL_DEFINITIONS } from './workspace-tools.js';

function str(description: string): Record<string, unknown> { return { type: 'string', description }; }
function arr(items: Record<string, unknown>, description?: string): Record<string, unknown> { const result: Record<string, unknown> = { type: 'array', items }; if (description) result.description = description; return result; }
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

const PLANNER_CARD_TOOL_NAMES = new Set([
  'create_card',
  'edit_card',
  'move_card',
  'reorder_child',
  'list_cards',
  'get_card',
  'get_tree',
  'list_card_history',
  'get_card_history_entry',
  'diff_card',
]);

const PLANNER_CARD_TOOL_DEFINITIONS = ANALYST_TOOL_DEFINITIONS.filter((entry) => PLANNER_CARD_TOOL_NAMES.has(entry.function.name));

export const PLANNER_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...PLANNER_CARD_TOOL_DEFINITIONS,
  ...WORKSPACE_TOOL_DEFINITIONS,
  tool('activate_card', 'Activate a card so runtime can proceed with the next planner-controlled step.', { cardId: str('The ID of the card to activate.') }, ['cardId']),
  tool('cancel_card', 'Cancel a planner-managed card.', { cardId: str('The ID of the card to cancel.') }, ['cardId']),
  tool('delete_card', 'Delete a backlog or terminal card and cascade through descendants.', { cardId: str('The ID of the card to delete.') }, ['cardId']),
  tool('restart_card', 'Restart a terminal or changed card so it can be activated again.', { cardId: str('The ID of the card to restart.') }, ['cardId']),
  tool('move_card', 'Move a card to a current sibling or to the current grandparent. Root moves and cross-tree moves are refused.', { id: str('The ID of the card to move.'), newParent: str('The ID of the new parent card. Must be either a current sibling or the current grandparent.') }, ['id', 'newParent']),
  tool('reorder_child', 'Reorder the children of a parent card. orderedChildIds must be a permutation of the current child set.', { parentId: str('The parent whose children to reorder.'), orderedChildIds: arr(str('A child card ID in the new order.'), 'New child id order; must be a permutation of the current child set.') }, ['parentId', 'orderedChildIds']),
  tool('report_goal_done', 'Report a goal or project as done. Requires non-empty status_text and optional evidence_card_ids.', {
    goalId: str('The goal or project card ID to report done.'),
    status_text: str('Required concise terminal status shown on the goal card.'),
    summary: str('Optional summary for the goal self-report.'),
    evidence_card_ids: arr(str('A descendant done card ID.'), 'Optional evidence card IDs supporting completion.'),
    report: { type: 'object', description: 'Optional full self-report payload.', additionalProperties: true },
  }, ['goalId', 'status_text']),
  tool('report_goal_failed', 'Report a goal or project as failed. Requires non-empty status_text.', {
    goalId: str('The goal or project card ID to report failed.'),
    status_text: str('Required concise terminal status shown on the goal card.'),
    summary: str('Optional summary for the goal self-report.'),
    evidence_card_ids: arr(str('A descendant done card ID.'), 'Optional evidence card IDs supporting the report.'),
    report: { type: 'object', description: 'Optional full self-report payload.', additionalProperties: true },
  }, ['goalId', 'status_text']),
  tool('report_goal_blocked', 'Report a goal or project as blocked. Requires non-empty status_text.', {
    goalId: str('The goal or project card ID to report blocked.'),
    status_text: str('Required concise terminal status shown on the goal card.'),
    summary: str('Optional summary for the goal self-report.'),
    evidence_card_ids: arr(str('A descendant done card ID.'), 'Optional evidence card IDs supporting the report.'),
    report: { type: 'object', description: 'Optional full self-report payload.', additionalProperties: true },
  }, ['goalId', 'status_text']),
  tool('queue_notification', 'Queue an ephemeral notification for delivery into the next agent session targeting a given card or role. The platform forgets the notification once it has been delivered; there is no list/get/acknowledge/delete.', { recipient: str('A card id, an agent role, or an active session id.'), kind: str('A short categorical label for the notification.'), body: str('The notification text to inject.') }, ['recipient', 'kind', 'body']),
].filter((tool, index, all) => all.findIndex((candidate) => candidate.function.name === tool.function.name) === index);

export const PLANNER_CONTROL_TOOL_NAMES = new Set<string>([
  'activate_card',
  'cancel_card',
  'delete_card',
  'restart_card',
  'move_card',
  'reorder_child',
  'report_goal_done',
  'report_goal_failed',
  'report_goal_blocked',
  'queue_notification',
]);

export const WORKSPACE_TOOL_NAMES = new Set(['list_project_files', 'read_project_file', 'write_project_file', 'start_and_wait', 'run_project_command', 'wait_for_process', 'kill_process']);
export const SKILL_TOOL_NAMES = new Set(['load_skill']);
export const MCP_WRAPPER_TOOL_NAMES = new Set(['mcp_tool_call']);

export const ROLE_TOOL_NAMES = {
  planner: [
    'create_card',
    'edit_card',
    'move_card',
    'reorder_child',
    'queue_notification',
    'list_cards',
    'get_card',
    'get_tree',
    'list_card_history',
    'get_card_history_entry',
    'diff_card',
    'list_project_files',
    'read_project_file',
    'write_project_file',
    'wait_for_process',
    'kill_process',
    'start_and_wait',
    'run_project_command',
    'activate_card',
    'cancel_card',
    'delete_card',
    'restart_card',
    'report_goal_done',
    'report_goal_failed',
    'report_goal_blocked',
  ],
  executor: [
    'load_skill',
    'list_project_files',
    'read_project_file',
    'write_project_file',
    'wait_for_process',
    'kill_process',
    'start_and_wait',
    'run_project_command',
    'list_card_history',
    'get_card_history_entry',
    'diff_card',
    'mcp_tool_call',
  ],
  reviewer: [
    'load_skill',
    'list_project_files',
    'read_project_file',
    'list_card_history',
    'get_card_history_entry',
    'diff_card',
    'mcp_tool_call',
  ],
  analyst: ANALYST_TOOL_DEFINITIONS.map((definition) => definition.function.name),
} as const;

export const ALL_TOOL_DEFINITIONS_BY_NAME = new Map<string, ToolDefinition>([
  ...ANALYST_TOOL_DEFINITIONS,
  LOAD_SKILL_TOOL_DEFINITION,
  ...WORKSPACE_TOOL_DEFINITIONS,
  ...READ_ONLY_WORKSPACE_TOOL_DEFINITIONS,
  MCP_TOOL_CALL_TOOL_DEFINITION,
  ...PLANNER_TOOL_DEFINITIONS,
].map((definition) => [definition.function.name, definition]));

export class AgentToolCatalog {
  static roleToolNames(role: keyof typeof ROLE_TOOL_NAMES): string[] { return [...ROLE_TOOL_NAMES[role]]; }
  static isPlannerTool(name: string): boolean { return (ROLE_TOOL_NAMES.planner as readonly string[]).includes(name); }
  static isPlannerControlTool(name: string): boolean { return PLANNER_CONTROL_TOOL_NAMES.has(name); }
  static isWorkspaceTool(name: string): boolean { return WORKSPACE_TOOL_NAMES.has(name); }
  static definitionFor(name: string): ToolDefinition | undefined { return ALL_TOOL_DEFINITIONS_BY_NAME.get(name); }
}
