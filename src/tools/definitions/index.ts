import { z } from 'zod';

import type { ToolDefinition as LlmToolDefinition } from '../../agents/llm-contracts.js';
import { zodToJsonSchemaMini } from '../../agents/zod-to-jsonschema-mini.js';
import {
  abort_goal_subtree,
  create_card,
  delete_card,
  diff_card,
  edit_card,
  get_card,
  get_card_history_entry,
  get_card_output,
  get_plan_diary,
  get_status,
  get_tree,
  list_agent_sessions,
  list_card_history,
  list_cards,
  list_directory,
  mark_goal_needs_corrections,
  list_processes_tool,
  navigate_back,
  navigate_workspace,
  pause_runtime,
  queue_notification,
  read_agent_session,
  read_control_actions,
  read_file,
  read_runtime_errors,
  read_runtime_events,
  reconfigure,
  reorder_child,
  restart_card_or_subtree,
  restart_goal,
  restart_server,
  resume_runtime,
  run_shell_command,
  show_config,
  start_project,
  stop_project,
  terminate_process,
  type ToolContext as AnalystToolContext,
  type ToolResult,
} from '../../agents/analyst-tools.js';
import type { PermissionRole } from '../../permissions/index.js';
import { analystIssueSeverityValues, cardStatusValues, cardTypeValues, urgencyValues } from '../../schemas/index.js';
import { defineTool, type JsonSchemaObject, type ToolDefinition as RuntimeToolDefinition } from '../runtime.js';

export const CARD_STATUS_VALUES = cardStatusValues;
export const RUNTIME_CARD_STATUS_VALUES = CARD_STATUS_VALUES.filter((status) => status !== 'needs_verification') as [
  'drafting',
  'backlog',
  'active',
  'running',
  'blocked',
  'changed',
  'done',
  'failed',
  'cancelled',
];
export const CARD_TYPE_VALUES = cardTypeValues;
export const PLANNER_CREATE_CARD_TYPE_VALUES = ['goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'] as const;
export const CREATE_CARD_TYPE_VALUES = CARD_TYPE_VALUES;
export const URGENCY_VALUES = urgencyValues;
export const NOTE_KIND_VALUES = ['comment', 'progress', 'directive', 'escalation'] as const;
export const ANALYST_ISSUE_SEVERITY_VALUES = analystIssueSeverityValues;

type AgentRole = PermissionRole;
type ToolExecutor<Input> = (ctx: AnalystToolContext, params: Input) => Promise<ToolResult>;

export interface UnifiedToolDefinition<Name extends string = string, Input = unknown> {
  readonly name: Name;
  readonly description: string;
  readonly input: z.ZodType<Input>;
  readonly roles: readonly AgentRole[];
  readonly executor?: ToolExecutor<Input>;
  readonly plannerControl?: boolean;
  readonly plannerInput?: z.ZodTypeAny;
  readonly plannerDescription?: string;
  readonly workspace?: boolean;
  readonly skill?: boolean;
  readonly mcpWrapper?: boolean;
}

const toolResultSchema = z.custom<ToolResult>((value) => Boolean(value && typeof value === 'object' && 'success' in value && typeof (value as { success?: unknown }).success === 'boolean'));

function describe<T extends z.ZodTypeAny>(schema: T, description: string): T {
  return schema.describe(description) as T;
}

function enumSchema<T extends readonly [string, ...string[]]>(description: string, values: T): z.ZodEnum<[T[0], ...string[]]> {
  return describe(z.enum([...values] as [T[0], ...string[]]), `${description} Allowed values: ${values.join(', ')}.`);
}

const stringArraySchema = z.array(describe(z.string(), 'A string value.'));
const cardIdArraySchema = z.array(describe(z.string(), 'A card ID'));
const cardStatusSchema = enumSchema('Card status.', CARD_STATUS_VALUES);
const runtimeCardStatusSchema = enumSchema('Card status.', RUNTIME_CARD_STATUS_VALUES);
const cardTypeSchema = enumSchema('Card type.', CARD_TYPE_VALUES);
const plannerCreateCardTypeSchema = describe(z.enum([...PLANNER_CREATE_CARD_TYPE_VALUES] as [typeof PLANNER_CREATE_CARD_TYPE_VALUES[0], ...string[]]), 'The card type.');
const urgencySchema = enumSchema('Urgency level.', URGENCY_VALUES);
const analystIssueSeveritySchema = enumSchema('Optional issue severity.', ANALYST_ISSUE_SEVERITY_VALUES);
const emptyInput = z.object({}).strict();

const markGoalNeedsCorrectionsInput = z.object({
  goalId: describe(z.string(), 'Goal/project card ID.'),
  issues: describe(z.array(z.object({
    summary: describe(z.string(), 'Issue summary.'),
    severity: analystIssueSeveritySchema.optional(),
    evidence_path: describe(z.string(), 'Optional evidence path.').optional(),
  }).strict()), 'Canonical AnalystIssue entries.'),
  note: describe(z.string(), 'Optional note.').optional(),
}).strict();

const createCardInput = z.object({
  type: enumSchema('The non-project card type.', CARD_TYPE_VALUES),
  parent: describe(z.string().nullable().optional(), "The ID of the parent card. Use null only when creating the root project card; use 'project' for top-level goals."),
  title: describe(z.string(), 'A short title.'),
  description: describe(z.string(), 'A detailed description.'),
  status: describe(cardStatusSchema.optional(), `Optional initial status. Allowed values: ${CARD_STATUS_VALUES.join(', ')}.`),
  tags: describe(z.array(describe(z.string(), 'A tag string')).optional(), 'Optional tags.'),
  priority: describe(z.number().int().optional(), 'Optional priority value (0-100).'),
  urgency: describe(urgencySchema.optional(), 'Optional urgency level.'),
  acceptance: describe(z.string().optional(), 'Optional acceptance criteria text.'),
  depends_on: describe(cardIdArraySchema.optional(), 'Optional dependency list.'),
  related: describe(cardIdArraySchema.optional(), 'Optional related-card list.'),
}).strict();

const editCardInput = z.object({
  id: describe(z.string(), 'The ID of the card to edit.'),
  title: describe(z.string().optional(), 'New title.'),
  description: describe(z.string().optional(), 'New description.'),
  status: describe(cardStatusSchema.optional(), 'New status.'),
  tags: describe(z.array(describe(z.string(), 'A tag string')).optional(), 'New tags.'),
  priority: describe(z.number().int().optional(), 'New priority (0-100).'),
  urgency: describe(urgencySchema.optional(), 'New urgency level.'),
  acceptance: describe(z.string().optional(), 'New acceptance criteria.'),
  depends_on: describe(stringArraySchema.optional(), 'New dependency list.'),
}).strict();

const plannerCreateCardInput = z.object({
  type: plannerCreateCardTypeSchema,
  title: describe(z.string(), 'A short title.'),
  description: describe(z.string(), 'A detailed description.'),
  status: describe(cardStatusSchema.optional(), 'Optional initial planner status.'),
  tags: describe(z.array(describe(z.string(), 'A tag string')).optional(), 'Optional tags.'),
  priority: describe(z.number().int().optional(), 'Optional priority value (0-100).'),
  urgency: describe(urgencySchema.optional(), 'Optional urgency level.'),
  acceptance: describe(z.string().optional(), 'Optional acceptance criteria text.'),
  depends_on: describe(cardIdArraySchema.optional(), 'Optional dependency list.'),
  related: describe(cardIdArraySchema.optional(), 'Optional related-card list.'),
}).strict();
const plannerEditCardInput = editCardInput.extend({ related: describe(stringArraySchema.optional(), 'New related-card list.') }).strict();

const listCardsInput = z.object({
  status: describe(z.union([cardStatusSchema, z.array(cardStatusSchema)]).optional(), `Filter by status. Accepts either one exact enum value or an array of exact enum values. Allowed values: ${CARD_STATUS_VALUES.join(', ')}.`),
  type: describe(z.union([cardTypeSchema, z.array(cardTypeSchema)]).optional(), `Filter by card type. Accepts either one exact enum value or an array of exact enum values. Allowed values: ${CARD_TYPE_VALUES.join(', ')}.`),
  parent: describe(z.string().optional(), 'Filter by parent card ID.'),
  tag: describe(z.string().optional(), 'Filter by tag.'),
}).strict();

const definitions: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'mark_goal_needs_corrections', description: 'Mark a goal/project subtree as needing corrections using canonical AnalystIssue entries.', input: markGoalNeedsCorrectionsInput, roles: ['analyst'], executor: mark_goal_needs_corrections },
  { name: 'create_card', description: `Create a new card in the card tree. The first root project card must be created with type 'project' and parent null; after that, use edit_card with id 'project' to change project instructions. Use parent 'project' for top-level goals. Status defaults to 'drafting'. Card status is planner metadata only; it does not start runtime work. There is no 'ready' status.`, input: createCardInput, roles: ['analyst', 'planner'], executor: create_card, plannerControl: true, plannerInput: plannerCreateCardInput, plannerDescription: 'Create a direct child card under the current planner card. The parent is inferred from the planner session and cannot be supplied.' },
  { name: 'edit_card', description: `Edit an existing card. Pass id plus only the fields you actually want to change. Card status is planner metadata only and never an execution trigger. Terminal statuses are done/failed/cancelled. There is no 'ready' or 'todo' status.`, input: editCardInput, roles: ['analyst', 'planner'], executor: edit_card, plannerControl: true, plannerInput: plannerEditCardInput, plannerDescription: 'Edit one immediate child of the current planner card. The target must be a direct child; parent/depth changes are not accepted.' },
  { name: 'reorder_child', description: 'Reorder the children of a parent card.', input: z.object({ parentId: describe(z.string(), 'Parent whose children to reorder.'), orderedChildIds: describe(z.array(z.string()), 'New child id order; must be a permutation of the current child set.') }).strict(), roles: ['analyst', 'planner'], executor: reorder_child, plannerControl: true, plannerInput: z.object({ orderedChildIds: z.array(z.string()) }).strict(), plannerDescription: 'Reorder the immediate children of the current planner card. orderedChildIds must be a permutation of that child set.' },
  { name: 'queue_notification', description: 'Queue a notification for delivery into the next agent session targeting a given card or role. The platform forgets the notification once it has been delivered; there is no list/get/acknowledge/delete.', input: z.object({ recipient: describe(z.string(), 'A card id, an agent role, or an active session id.'), kind: describe(z.string(), 'A short categorical label for the notification.'), body: describe(z.string(), 'The notification text to inject.') }).strict(), roles: ['analyst', 'planner'], executor: queue_notification, plannerControl: true },
  { name: 'list_cards', description: 'List and filter cards in the project.', input: listCardsInput, roles: ['analyst', 'planner'], executor: list_cards },
  { name: 'get_card', description: 'Get full details of a single card.', input: z.object({ id: describe(z.string(), 'The ID of the card to retrieve.') }).strict(), roles: ['analyst', 'planner'], executor: get_card },
  { name: 'get_tree', description: 'Show the card tree.', input: z.object({ rootId: describe(z.string().optional(), 'Optional root card ID.') }).strict(), roles: ['analyst', 'planner'], executor: get_tree },
  { name: 'get_plan_diary', description: 'Read a goal planning diary.', input: z.object({ goalId: describe(z.string(), 'The ID of the goal card.') }).strict(), roles: ['analyst'], executor: get_plan_diary },
  { name: 'get_card_output', description: 'Get output of processes associated with a card.', input: z.object({ cardId: describe(z.string(), 'The ID of the card.'), lines: describe(z.number().int().optional(), 'Number of lines to show.'), processId: describe(z.string().optional(), 'Optional specific process ID.') }).strict(), roles: ['analyst'], executor: get_card_output },
  { name: 'get_status', description: 'Get the overall project status.', input: emptyInput, roles: ['analyst'], executor: get_status },
  { name: 'load_skill', description: 'Load a skill on-demand during an agent session. Skills provide domain-specific instructions, coding standards, or project conventions. Use this when you encounter a situation that requires a skill not already in your context. Provide the skill name to load its content.', input: z.object({ name: describe(z.string(), 'The name of the skill to load (must match an entry in the skills index)') }).strict(), roles: ['executor', 'reviewer'], skill: true },
  { name: 'list_card_history', description: 'List card history headers for a card.', input: z.object({ cardId: describe(z.string(), 'The ID of the card whose history to list.') }).strict(), roles: ['planner', 'executor', 'reviewer', 'analyst'], executor: list_card_history },
  { name: 'get_card_history_entry', description: 'Get a specific card history entry snapshot.', input: z.object({ cardId: describe(z.string(), 'The ID of the card.'), version_seq: describe(z.number().int(), 'The historical version sequence to retrieve.') }).strict(), roles: ['planner', 'executor', 'reviewer', 'analyst'], executor: get_card_history_entry },
  { name: 'diff_card', description: 'Get a field-level diff between two card versions.', input: z.object({ cardId: describe(z.string(), 'The ID of the card.'), fromSeq: describe(z.number().int().optional(), 'Optional source version sequence. Defaults to previous version.'), toSeq: describe(z.number().int().optional(), 'Optional target version sequence. Defaults to current version.') }).strict(), roles: ['planner', 'executor', 'reviewer', 'analyst'], executor: diff_card },
  { name: 'start_project', description: 'Start root project execution.', input: emptyInput, roles: ['analyst'], executor: start_project },
  { name: 'stop_project', description: 'Stop autonomous project execution.', input: emptyInput, roles: ['analyst'], executor: stop_project },
  { name: 'terminate_process', description: 'Terminate a live runtime process.', input: z.object({ processId: describe(z.string(), 'The process ID to terminate.') }).strict(), roles: ['analyst'], executor: terminate_process },
  { name: 'pause_runtime', description: 'Globally pause the runtime.', input: emptyInput, roles: ['analyst'], executor: pause_runtime },
  { name: 'resume_runtime', description: 'Resume the runtime after a pause.', input: emptyInput, roles: ['analyst'], executor: resume_runtime },
  { name: 'abort_goal_subtree', description: 'Abort a goal and all descendants.', input: z.object({ goalId: describe(z.string(), 'The ID of the goal card to abort.') }).strict(), roles: ['analyst'], executor: abort_goal_subtree },
  { name: 'restart_card_or_subtree', description: 'Restart a completed, failed, or cancelled card or goal subtree.', input: z.object({ id: describe(z.string(), 'The ID of the card/goal to restart.') }).strict(), roles: ['analyst'], executor: restart_card_or_subtree },
  { name: 'restart_goal', description: 'Restart a goal.', input: z.object({ goalId: describe(z.string(), 'The ID of the goal card to restart.') }).strict(), roles: ['analyst'], executor: restart_goal },
  { name: 'navigate_workspace', description: 'Navigate the workspace area.', input: z.object({ target: z.object({ kind: z.enum(['card', 'transcript', 'process', 'plan_diary', 'process_list', 'agent_session_list', 'config']), id: describe(z.string().optional(), 'Optional target id.'), refinement: describe(z.string().optional(), 'Optional view refinement.') }).strict() }).strict(), roles: ['analyst'], executor: navigate_workspace },
  { name: 'navigate_back', description: 'Navigate back in the workspace area.', input: emptyInput, roles: ['analyst'], executor: navigate_back },
  { name: 'show_config', description: 'Show the current project configuration with secrets redacted.', input: emptyInput, roles: ['analyst'], executor: show_config },
  { name: 'restart_server', description: 'Request a supervised server restart.', input: emptyInput, roles: ['analyst'], executor: restart_server },
  { name: 'reconfigure', description: 'Reconfigure role routing, failover, MCP servers, runtime, or server settings.', input: z.object({ action: z.enum(['set_role_routing', 'set_failover_chain', 'mcp_add', 'mcp_edit', 'mcp_remove', 'set_runtime_setting', 'set_server_setting']), role: z.string().optional(), model_candidate: z.string().optional(), for_model: z.string().optional(), ordered_failover_models: z.array(z.string()).optional(), name: z.string().optional(), command: z.string().optional(), args: z.array(z.string()).optional(), env: z.record(z.string()).optional(), key: z.string().optional(), value: z.unknown().optional() }).strict(), roles: ['analyst'], executor: reconfigure },
  { name: 'read_file', description: 'Read the contents of any file the saivage service can see on the host. Returns up to maxBytes bytes (default 200000, max 1000000). Binary files return content=null with binary=true. Use absolute paths or paths relative to the saivage server cwd.', input: z.object({ path: describe(z.string(), 'Absolute or relative file path.'), maxBytes: describe(z.number().int().optional(), 'Max bytes to read (default 200000, max 1000000).') }).strict(), roles: ['analyst'], executor: read_file },
  { name: 'list_directory', description: 'List the contents of any directory the saivage service can see on the host. Use absolute paths or paths relative to the saivage server cwd.', input: z.object({ path: describe(z.string(), 'Absolute or relative directory path.'), maxEntries: describe(z.number().int().optional(), 'Max entries to return (default 500, max 5000).') }).strict(), roles: ['analyst'], executor: list_directory },
  { name: 'run_shell_command', description: 'Run a bounded inspection shell command. Destructive commands are denied on web-chat and must not be used to mutate project source or runtime state.', input: z.object({ command: describe(z.string(), 'Shell command to inspect the host or project state.'), cwd: describe(z.string().optional(), 'Optional working directory. Defaults to the project root.'), timeoutMs: describe(z.number().int().optional(), 'Optional timeout in milliseconds (default 15000, max 60000).'), maxOutputBytes: describe(z.number().int().optional(), 'Optional per-stream output cap in bytes (default 65536, max 1048576).') }).strict(), roles: ['analyst'], executor: run_shell_command },
  { name: 'read_runtime_events', description: 'Tail the project runtime events log (.saivage/runtime/events.jsonl). Optionally filter by event kind.', input: z.object({ limit: z.number().int().optional(), kind: z.string().optional() }).strict(), roles: ['analyst'], executor: read_runtime_events },
  { name: 'read_runtime_errors', description: 'Tail the project runtime errors log (.saivage/runtime/errors.jsonl).', input: z.object({ limit: z.number().int().optional() }).strict(), roles: ['analyst'], executor: read_runtime_errors },
  { name: 'read_control_actions', description: 'Tail the control-action audit log (.saivage/runtime/control-actions.jsonl). Shows mutating actions performed by analyst/planner/operator.', input: z.object({ limit: z.number().int().optional(), since: z.string().optional() }).strict(), roles: ['analyst'], executor: read_control_actions },
  { name: 'list_processes_tool', description: 'List all runtime processes (not card-scoped). Optionally filter by status (running, finished, failed, killed) or cardId.', input: z.object({ status: z.string().optional(), cardId: z.string().optional() }).strict(), roles: ['analyst'], executor: list_processes_tool },
  { name: 'list_agent_sessions', description: 'List all agent sessions in the project (analyst, planner, executor, etc.), not just the current analyst session.', input: emptyInput, roles: ['analyst'], executor: list_agent_sessions },
  { name: 'read_agent_session', description: "Read a specific agent session's metadata and most recent persisted messages. Useful for inspecting what other agents (planner, executor, etc.) have been doing.", input: z.object({ sessionId: z.string(), lastN: z.number().int().optional() }).strict(), roles: ['analyst'], executor: read_agent_session },
  { name: 'list_project_files', description: 'List files under the Saivage project root. Paths are project-relative; Saivage internal state directories are omitted.', input: z.object({ path: describe(z.string().optional(), 'Project-relative directory to list. Defaults to the project root.'), maxResults: describe(z.number().int().optional(), 'Maximum file paths to return. Defaults to 200; capped at 1000.') }).strict(), roles: ['planner', 'executor', 'reviewer'], workspace: true },
  { name: 'read_project_file', description: 'Read a project file safely. Paths must resolve inside the project root; blocked Saivage credential files cannot be read and secrets are redacted where appropriate.', input: z.object({ path: z.string() }).strict(), roles: ['planner', 'executor', 'reviewer'], workspace: true },
  { name: 'write_project_file', description: 'Create or replace a project file. Paths must resolve inside the project root and may not write Saivage internal state or blocked credential/runtime files.', input: z.object({ path: z.string(), content: z.string() }).strict(), roles: ['planner', 'executor'], workspace: true },
  { name: 'wait_for_process', description: 'Wait for a previously-started Saivage process by id. Already-terminal processes return their cached terminal status.', input: z.object({ processId: z.string(), timeoutMs: z.number().int().optional() }).strict(), roles: ['planner', 'executor'], workspace: true },
  { name: 'kill_process', description: 'Request termination of a Saivage process by id. Already-terminal processes are returned unchanged.', input: z.object({ processId: z.string(), signal: z.string().optional() }).strict(), roles: ['planner', 'executor'], workspace: true },
  { name: 'start_and_wait', description: 'Run a shell command and wait for completion using the durable Saivage process runner.', input: z.object({ command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().int().optional() }).strict(), roles: ['planner', 'executor'], workspace: true },
  { name: 'run_project_command', description: 'Run a shell command from the project root or a project-relative working directory. Output is captured through the Saivage process runner.', input: z.object({ command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().int().optional() }).strict(), roles: ['planner', 'executor'], workspace: true },
  { name: 'mcp_tool_call', description: 'Call an MCP (Model Context Protocol) tool on a configured MCP server. MCP tools provide access to git operations, filesystem tools, databases, package registries, and other external capabilities. Provide the server name, tool name, and optional arguments to invoke the tool. Results are returned as tool_result content.', input: z.object({ serverName: z.string(), toolName: z.string(), args: z.record(z.unknown()).optional() }).strict(), roles: ['executor', 'reviewer'], mcpWrapper: true },
  { name: 'activate_card', description: 'Activate a card so runtime can proceed with the next planner-controlled step.', input: z.object({ cardId: describe(z.string(), 'The ID of the card to activate.') }).strict(), roles: ['planner'], plannerControl: true },
  { name: 'cancel_card', description: 'Destructively cancel a planner-managed card only when it is obsolete, duplicate, mis-scoped, or explicitly rejected; not a scheduling/defer primitive for actionable backlog work.', input: z.object({ cardId: describe(z.string(), 'The ID of the card to cancel.') }).strict(), roles: ['planner'], plannerControl: true },
  { name: 'delete_card', description: 'Delete one or more cards (and all their descendants) in a single call.', input: z.object({ ids: describe(z.array(z.string()).min(1), 'Card ids to delete.') }).strict(), roles: ['analyst', 'planner'], executor: delete_card, plannerControl: true, plannerInput: z.object({ cardId: z.string() }).strict(), plannerDescription: 'Delete a backlog or terminal card and cascade through descendants.' },
  { name: 'restart_card', description: 'Restart a terminal or changed card so it can be activated again.', input: z.object({ cardId: z.string() }).strict(), roles: ['planner'], plannerControl: true },
  { name: 'report_goal_done', description: 'Report a goal or project as done. Requires non-empty status_text and optional evidence_card_ids.', input: z.object({ status_text: z.string(), summary: z.string().optional(), evidence_card_ids: z.array(z.string()).optional(), report: z.record(z.unknown()).optional() }).strict(), roles: ['planner'], plannerControl: true },
  { name: 'report_goal_failed', description: 'Report a goal or project as failed. Requires non-empty status_text.', input: z.object({ status_text: z.string(), summary: z.string().optional(), evidence_card_ids: z.array(z.string()).optional(), report: z.record(z.unknown()).optional() }).strict(), roles: ['planner'], plannerControl: true },
  { name: 'report_goal_blocked', description: 'Report a goal or project as blocked. Requires non-empty status_text.', input: z.object({ status_text: z.string(), summary: z.string().optional(), evidence_card_ids: z.array(z.string()).optional(), report: z.record(z.unknown()).optional() }).strict(), roles: ['planner'], plannerControl: true },
] as const;

export const TOOL_DEFINITIONS = definitions;

const byName = new Map<string, UnifiedToolDefinition>(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

function schemaFor(tool: UnifiedToolDefinition): JsonSchemaObject {
  return zodToJsonSchemaMini(tool.input) as JsonSchemaObject;
}

export function llmToolDefinition(tool: UnifiedToolDefinition): LlmToolDefinition {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: schemaFor(tool) } };
}

export function toolDefinitionByName(name: string): UnifiedToolDefinition | undefined {
  return byName.get(name);
}

export const ANALYST_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((tool) => tool.roles.includes('analyst') && !tool.workspace).map(llmToolDefinition);
export const ANALYST_TOOL_NAMES = ANALYST_TOOL_DEFINITIONS.map((tool) => tool.function.name);
export const READ_ONLY_WORKSPACE_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((tool) => tool.workspace && !['write_project_file', 'wait_for_process', 'kill_process', 'start_and_wait', 'run_project_command'].includes(tool.name)).map(llmToolDefinition);
export const WORKSPACE_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((tool) => tool.workspace).map(llmToolDefinition);
export const PLANNER_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((tool) => tool.roles.includes('planner') && !tool.skill && !tool.mcpWrapper).map((tool) => {
  if (tool.plannerInput) return llmToolDefinition({ ...tool, description: tool.plannerDescription ?? tool.description, input: tool.plannerInput, roles: ['planner'] });
  return llmToolDefinition(tool);
}).filter((tool, index, all) => all.findIndex((candidate) => candidate.function.name === tool.function.name) === index);

export const PLANNER_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_DEFINITIONS.filter((tool) => tool.plannerControl || ['create_card', 'edit_card', 'reorder_child', 'queue_notification'].includes(tool.name)).map((tool) => tool.name));
export const WORKSPACE_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_DEFINITIONS.filter((tool) => tool.workspace).map((tool) => tool.name));
export const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_DEFINITIONS.filter((tool) => tool.skill).map((tool) => tool.name));
export const MCP_WRAPPER_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_DEFINITIONS.filter((tool) => tool.mcpWrapper).map((tool) => tool.name));

export function toolNamesForRole(role: AgentRole): string[] {
  return TOOL_DEFINITIONS.filter((tool) => tool.roles.includes(role)).map((tool) => tool.name);
}

export function allRoleToolNames(): Record<AgentRole, string[]> {
  return {
    planner: toolNamesForRole('planner'),
    executor: toolNamesForRole('executor'),
    reviewer: toolNamesForRole('reviewer'),
    analyst: toolNamesForRole('analyst'),
    operator: toolNamesForRole('operator'),
  };
}

function actorForRole(role: PermissionRole, toolName?: string): AnalystToolContext['actor'] {
  if (role === 'operator') return 'planner';
  if (role === 'planner' && toolName === 'edit_card') return 'runtime';
  return role;
}

export const AGENT_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((tool) => tool.executor && !tool.plannerControl).map((tool) => defineTool({
  name: tool.name,
  description: tool.description,
  input: tool.input,
  output: toolResultSchema,
  parameters: schemaFor(tool),
  roles: tool.roles,
  execute: async (ctx, input) => tool.executor!({ projectRoot: ctx.projectRoot, store: ctx.cardStore, actor: actorForRole(ctx.role, tool.name), surface: ctx.surface, sessionId: ctx.sessionId }, input),
})) as readonly RuntimeToolDefinition<string, unknown, ToolResult>[];

export const ALL_TOOL_DEFINITIONS_BY_NAME = new Map<string, LlmToolDefinition>([
  ...TOOL_DEFINITIONS.map(llmToolDefinition),
  ...PLANNER_TOOL_DEFINITIONS,
].map((definition) => [definition.function.name, definition]));
