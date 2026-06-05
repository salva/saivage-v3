import type { ToolDefinition } from './llm-contracts.js';
import { ANALYST_TOOL_DEFINITIONS } from './analyst-tool-schemas.js';
import { LOAD_SKILL_TOOL_DEFINITION, MCP_TOOL_CALL_TOOL_DEFINITION } from './skill-tools.js';
import {
  READ_ONLY_WORKSPACE_TOOL_DEFINITIONS,
  WORKSPACE_TOOL_DEFINITIONS,
} from './workspace-tools.js';

function str(description: string): Record<string, unknown> {
  return { type: 'string', description };
}
function arr(items: Record<string, unknown>, description?: string): Record<string, unknown> {
  const result: Record<string, unknown> = { type: 'array', items };
  if (description) result.description = description;
  return result;
}
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
  };
}

const PLANNER_CARD_TOOL_NAMES = new Set([
  'list_cards',
  'get_card',
  'get_tree',
  'list_card_history',
  'get_card_history_entry',
  'diff_card',
]);

const PLANNER_CARD_TOOL_DEFINITIONS = ANALYST_TOOL_DEFINITIONS.filter((entry) =>
  PLANNER_CARD_TOOL_NAMES.has(entry.function.name),
);

export const PLANNER_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...PLANNER_CARD_TOOL_DEFINITIONS,
  ...WORKSPACE_TOOL_DEFINITIONS,
  tool(
    'create_card',
    'Create a direct child card under the current planner card. The parent is inferred from the planner session and cannot be supplied.',
    {
      type: { type: 'string', description: 'The card type.', enum: ['goal','architecture','code','test','doc','data','research','ops'] },
      title: str('A short title.'),
      description: str('A detailed description.'),
      status: { type: 'string', description: 'Optional initial planner status.', enum: ['drafting','backlog','active','running','blocked','changed','done','failed','cancelled','needs_verification'] },
      tags: arr(str('A tag string'), 'Optional tags.'),
      priority: { type: 'integer', description: 'Optional priority value (0-100).' },
      urgency: { type: 'string', description: 'Optional urgency level.', enum: ['low','normal','high','critical'] },
      acceptance: str('Optional acceptance criteria text.'),
      depends_on: arr(str('A card ID'), 'Optional dependency list.'),
      related: arr(str('A card ID'), 'Optional related-card list.'),
    },
    ['type', 'title', 'description'],
  ),
  tool(
    'edit_card',
    'Edit one immediate child of the current planner card. The target must be a direct child; parent/depth changes are not accepted.',
    {
      id: str('The direct child card ID to edit.'),
      title: str('New title.'),
      description: str('New description.'),
      status: { type: 'string', description: 'New planner status.', enum: ['drafting','backlog','active','running','blocked','changed','done','failed','cancelled','needs_verification'] },
      tags: arr(str('A tag string'), 'New tags.'),
      priority: { type: 'integer', description: 'New priority (0-100).' },
      urgency: { type: 'string', description: 'New urgency level.', enum: ['low','normal','high','critical'] },
      acceptance: str('New acceptance criteria.'),
      depends_on: arr(str('A card ID'), 'New dependency list.'),
      related: arr(str('A card ID'), 'New related-card list.'),
    },
    ['id'],
  ),
  tool(
    'activate_card',
    'Activate a card so runtime can proceed with the next planner-controlled step.',
    { cardId: str('The ID of the card to activate.') },
    ['cardId'],
  ),
  tool(
    'cancel_card',
    'Destructively cancel a planner-managed card only when it is obsolete, duplicate, mis-scoped, or explicitly rejected; not a scheduling/defer primitive for actionable backlog work.',
    { cardId: str('The ID of the card to cancel.') },
    ['cardId'],
  ),
  tool(
    'delete_card',
    'Delete a backlog or terminal card and cascade through descendants.',
    { cardId: str('The ID of the card to delete.') },
    ['cardId'],
  ),
  tool(
    'restart_card',
    'Restart a terminal or changed card so it can be activated again.',
    { cardId: str('The ID of the card to restart.') },
    ['cardId'],
  ),
  tool(
    'reorder_child',
    'Reorder the immediate children of the current planner card. orderedChildIds must be a permutation of that child set.',
    {
      orderedChildIds: arr(
        str('A child card ID in the new order.'),
        'New child id order; must be a permutation of the current child set.',
      ),
    },
    ['orderedChildIds'],
  ),
  tool(
    'report_goal_done',
    'Report a goal or project as done. Requires non-empty status_text and optional evidence_card_ids.',
    {
      status_text: str('Required concise terminal status shown on the goal card.'),
      summary: str('Optional summary for the goal self-report.'),
      evidence_card_ids: arr(
        str('A descendant done card ID.'),
        'Optional evidence card IDs supporting completion.',
      ),
      report: {
        type: 'object',
        description: 'Optional full self-report payload.',
        additionalProperties: true,
      },
    },
    ['status_text'],
  ),
  tool(
    'report_goal_failed',
    'Report a goal or project as failed. Requires non-empty status_text.',
    {
      status_text: str('Required concise terminal status shown on the goal card.'),
      summary: str('Optional summary for the goal self-report.'),
      evidence_card_ids: arr(
        str('A descendant done card ID.'),
        'Optional evidence card IDs supporting the report.',
      ),
      report: {
        type: 'object',
        description: 'Optional full self-report payload.',
        additionalProperties: true,
      },
    },
    ['status_text'],
  ),
  tool(
    'report_goal_blocked',
    'Report a goal or project as blocked. Requires non-empty status_text.',
    {
      status_text: str('Required concise terminal status shown on the goal card.'),
      summary: str('Optional summary for the goal self-report.'),
      evidence_card_ids: arr(
        str('A descendant done card ID.'),
        'Optional evidence card IDs supporting the report.',
      ),
      report: {
        type: 'object',
        description: 'Optional full self-report payload.',
        additionalProperties: true,
      },
    },
    ['status_text'],
  ),
  tool(
    'queue_notification',
    'Queue an ephemeral notification for delivery into the next agent session targeting a given card or role. The platform forgets the notification once it has been delivered; there is no list/get/acknowledge/delete.',
    {
      recipient: str('A card id, an agent role, or an active session id.'),
      kind: str('A short categorical label for the notification.'),
      body: str('The notification text to inject.'),
    },
    ['recipient', 'kind', 'body'],
  ),
].filter(
  (tool, index, all) =>
    all.findIndex((candidate) => candidate.function.name === tool.function.name) === index,
);

export const PLANNER_CONTROL_TOOL_NAMES = new Set<string>([
  'activate_card',
  'create_card',
  'edit_card',
  'cancel_card',
  'delete_card',
  'restart_card',
  'reorder_child',
  'report_goal_done',
  'report_goal_failed',
  'report_goal_blocked',
  'queue_notification',
]);

export const WORKSPACE_TOOL_NAMES = new Set([
  'list_project_files',
  'read_project_file',
  'write_project_file',
  'start_and_wait',
  'run_project_command',
  'wait_for_process',
  'kill_process',
]);
export const SKILL_TOOL_NAMES = new Set(['load_skill']);
export const MCP_WRAPPER_TOOL_NAMES = new Set(['mcp_tool_call']);

export const ROLE_TOOL_NAMES = {
  planner: [
    'create_card',
    'edit_card',
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

export const ALL_TOOL_DEFINITIONS_BY_NAME = new Map<string, ToolDefinition>(
  [
    ...ANALYST_TOOL_DEFINITIONS,
    LOAD_SKILL_TOOL_DEFINITION,
    ...WORKSPACE_TOOL_DEFINITIONS,
    ...READ_ONLY_WORKSPACE_TOOL_DEFINITIONS,
    MCP_TOOL_CALL_TOOL_DEFINITION,
    ...PLANNER_TOOL_DEFINITIONS,
  ].map((definition) => [definition.function.name, definition]),
);

export class AgentToolCatalog {
  static roleToolNames(role: keyof typeof ROLE_TOOL_NAMES): string[] {
    return [...ROLE_TOOL_NAMES[role]];
  }
  static isPlannerTool(name: string): boolean {
    return (ROLE_TOOL_NAMES.planner as readonly string[]).includes(name);
  }
  static isPlannerControlTool(name: string): boolean {
    return PLANNER_CONTROL_TOOL_NAMES.has(name);
  }
  static isWorkspaceTool(name: string): boolean {
    return WORKSPACE_TOOL_NAMES.has(name);
  }
  static definitionFor(name: string): ToolDefinition | undefined {
    return ALL_TOOL_DEFINITIONS_BY_NAME.get(name);
  }
}
