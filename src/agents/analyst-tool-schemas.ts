import type { ToolDefinition } from './llm-client.js';

// Canonical vocabularies. Keep aligned with src/schemas/validators.ts.
// Exported so analyst-tools.ts can produce "Allowed values: ..." hints using
// the SAME list the JSON schema below advertises to the LLM.
export const CARD_STATUS_VALUES = ['drafting','backlog','active','running','blocked','changed','done','failed','cancelled','needs_verification'] as const;
export const CARD_TYPE_VALUES = ['project','goal','architecture','code','test','doc','data','research','ops'] as const;
export const URGENCY_VALUES = ['low','normal','high','critical'] as const;
export const NOTE_KIND_VALUES = ['comment','progress','directive','escalation'] as const;
export const ANALYST_ISSUE_SEVERITY_VALUES = ['info','warning','blocker'] as const;

function str(description: string): Record<string, unknown> { return { type: 'string', description }; }
function strEnum(description: string, values: readonly string[]): Record<string, unknown> { return { type: 'string', description: `${description} Allowed values: ${values.join(', ')}.`, enum: [...values] }; }
function int(description: string): Record<string, unknown> { return { type: 'integer', description }; }
function bool(description: string): Record<string, unknown> { return { type: 'boolean', description }; }
function arr(items: Record<string, unknown>, description?: string): Record<string, unknown> { const result: Record<string, unknown> = { type: 'array', items }; if (description) result.description = description; return result; }
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

export const ANALYST_TOOL_DEFINITIONS: ToolDefinition[] = [
  tool('mark_goal_needs_corrections','Mark a goal/project subtree as needing corrections using canonical AnalystIssue entries.',{ goalId: str('Goal/project card ID.'), issues: arr({ type: 'object', properties: { summary: str('Issue summary.'), severity: strEnum('Optional issue severity.', ANALYST_ISSUE_SEVERITY_VALUES), evidence_path: str('Optional evidence path.') }, required: ['summary'], additionalProperties: false },'Canonical AnalystIssue entries.'), note: str('Optional note.') },['goalId','issues']),
  tool('create_card',`Create a new card in the card tree. Status defaults to 'drafting'. Card status is planner metadata only; it does not start runtime work. There is no 'ready' status.`,{ type: strEnum('The card type.', CARD_TYPE_VALUES), parent: str('The ID of the parent card. Use null only for a root project card.'), title: str('A short title.'), description: str('A detailed description.'), status: strEnum('Optional initial status.', CARD_STATUS_VALUES), tags: arr(str('A tag string'),'Optional tags.'), priority: int('Optional priority value (0-100).'), urgency: strEnum('Optional urgency level.', URGENCY_VALUES), acceptance: str('Optional acceptance criteria text.'), depends_on: arr(str('A card ID'),'Optional dependency list.'), id: str('Optional pre-assigned card ID.') },['type','title','description']),
  tool('edit_card',`Edit an existing card. Pass id plus only the fields you actually want to change. Card status is planner metadata only and never an execution trigger. Terminal statuses are done/failed/cancelled. There is no 'ready' or 'todo' status.`,{ id: str('The ID of the card to edit.'), title: str('New title.'), description: str('New description.'), status: strEnum('New status.', CARD_STATUS_VALUES), tags: arr(str('A tag string'),'New tags.'), priority: int('New priority (0-100).'), urgency: strEnum('New urgency level.', URGENCY_VALUES), acceptance: str('New acceptance criteria.'), depends_on: arr(str('A card ID'),'New dependency list.') },['id']),
  tool('move_card','Move a card to a current sibling or to the current grandparent. Root moves and cross-tree moves are refused.',{ id: str('The ID of the card to move.'), newParent: str('The ID of the new parent card. Must be either a current sibling or the current grandparent; root moves are refused.') },['id','newParent']),
  tool('delete_card','Delete one or more cards (and all their descendants) in a single call.',{ ids: { ...arr(str('Card id to delete.')), minItems: 1 } },['ids']),
  tool('list_cards','List and filter cards in the project.',{ status: strEnum('Filter by status.', CARD_STATUS_VALUES), type: strEnum('Filter by card type.', CARD_TYPE_VALUES), parent: str('Filter by parent card ID.'), tag: str('Filter by tag.') },[]),
  tool('get_card','Get full details of a single card.',{ id: str('The ID of the card to retrieve.') },['id']),
  tool('get_tree','Show the card tree.',{ rootId: str('Optional root card ID.') },[]),
  tool('get_plan_diary','Read a goal planning diary.',{ goalId: str('The ID of the goal card.') },['goalId']),
  tool('get_card_output','Get output of processes associated with a card.',{ cardId: str('The ID of the card.'), lines: int('Number of lines to show.'), processId: str('Optional specific process ID.') },['cardId']),
  tool('get_status','Get the overall project status.',{},[]),
  tool('list_card_history','List card history headers for a card.',{ cardId: str('The ID of the card whose history to list.') },['cardId']),
  tool('get_card_history_entry','Get a specific card history entry snapshot.',{ cardId: str('The ID of the card.'), version_seq: int('The historical version sequence to retrieve.') },['cardId','version_seq']),
  tool('diff_card','Get a field-level diff between two card versions.',{ cardId: str('The ID of the card.'), fromSeq: int('Optional source version sequence. Defaults to previous version.'), toSeq: int('Optional target version sequence. Defaults to current version.') },['cardId']),

  tool('start_project','Start root project execution.',{},[]),
  tool('stop_project','Stop autonomous project execution.',{},[]),
  tool('terminate_process','Terminate a live runtime process.',{ processId: str('The process ID to terminate.') },['processId']),
  tool('pause_runtime','Globally pause the runtime.',{},[]),
  tool('resume_runtime','Resume the runtime after a pause.',{},[]),
  tool('abort_goal_subtree','Abort a goal and all descendants.',{ goalId: str('The ID of the goal card to abort.') },['goalId']),
  tool('restart_card_or_subtree','Restart a completed, failed, or cancelled card or goal subtree.',{ id: str('The ID of the card/goal to restart.') },['id']),
  tool('restart_goal','Restart a goal.',{ goalId: str('The ID of the goal card to restart.') },['goalId']),
  tool('queue_notification','Queue a notification to a single recipient. S04 owns persistence; S02 reports not-yet-available.',{ recipient: str('Recipient card id or role.'), kind: str('Notification kind.'), body: str('Notification body.') },['recipient','kind','body']),
  tool('reorder_child','Reorder the children of a parent card.',{ parentId: str('Parent whose children to reorder.'), orderedChildIds: arr(str('A child card ID in the new order.'),'New child id order; must be a permutation of the current child set.') },['parentId','orderedChildIds']),
  tool('navigate_workspace','Navigate the workspace area.',{ target: { type: 'object', properties: { kind: { type: 'string', enum: ['card','transcript','process','plan_diary','process_list','agent_session_list','config'] }, id: str('Optional target id.'), refinement: str('Optional view refinement.') }, required: ['kind'], additionalProperties: false } },['target']),
  tool('navigate_back','Navigate back in the workspace area.',{},[]),
  tool('show_config','Show the current project configuration with secrets redacted.',{},[]),
  tool('restart_server','Request a supervised server restart.',{},[]),
  tool('reconfigure','Reconfigure role routing, failover, MCP servers, runtime, or server settings.',{ action: { type: 'string', enum: ['set_role_routing','set_failover_order','mcp_add','mcp_edit','mcp_remove','set_runtime_setting','set_server_setting'] }, role: str('Role name.'), model_candidate: str('Model candidate.'), ordered_providers: arr(str('Provider id'),'Provider order.'), name: str('MCP server name.'), command: str('MCP command.'), args: arr(str('Argument'),'MCP args.'), env: { type: 'object', additionalProperties: { type: 'string' } }, key: str('Setting key.'), value: { description: 'Setting value.' } },['action']),
  tool('read_file','Read the contents of any file the saivage service can see on the host. Returns up to maxBytes bytes (default 200000, max 1000000). Binary files return content=null with binary=true. Use absolute paths or paths relative to the saivage server cwd.',{ path: str('Absolute or relative file path.'), maxBytes: int('Max bytes to read (default 200000, max 1000000).') },['path']),
  tool('list_directory','List the contents of any directory the saivage service can see on the host. Use absolute paths or paths relative to the saivage server cwd.',{ path: str('Absolute or relative directory path.'), maxEntries: int('Max entries to return (default 500, max 5000).') },['path']),
  tool('run_shell_command','Run a bounded inspection shell command. Destructive commands are denied on web-chat and must not be used to mutate project source or runtime state.',{ command: str('Shell command to inspect the host or project state.'), cwd: str('Optional working directory. Defaults to the project root.'), timeoutMs: int('Optional timeout in milliseconds (default 15000, max 60000).'), maxOutputBytes: int('Optional per-stream output cap in bytes (default 65536, max 1048576).') },['command']),
  tool('read_runtime_events','Tail the project runtime events log (.saivage/runtime/events.jsonl). Optionally filter by event kind.',{ limit: int('Number of recent events (default 50, max 1000).'), kind: str('Optional event kind filter.') },[]),
  tool('read_runtime_errors','Tail the project runtime errors log (.saivage/runtime/errors.jsonl).',{ limit: int('Number of recent errors (default 50, max 1000).') },[]),
  tool('read_control_actions','Tail the control-action audit log (.saivage/runtime/control-actions.jsonl). Shows mutating actions performed by analyst/planner/operator.',{ limit: int('Number of recent entries (default 50, max 1000).'), since: str('Optional ISO timestamp; only return entries created at or after this time.') },[]),
  tool('list_processes_tool','List all runtime processes (not card-scoped). Optionally filter by status (running, finished, failed, killed) or cardId.',{ status: str('Optional status filter.'), cardId: str('Optional card-scope filter.') },[]),
  tool('list_agent_sessions','List all agent sessions in the project (analyst, planner, executor, etc.), not just the current analyst session.',{},[]),
  tool('read_agent_session','Read a specific agent session\'s metadata and most recent persisted messages. Useful for inspecting what other agents (planner, executor, etc.) have been doing.',{ sessionId: str('The session ID to inspect.'), lastN: int('How many most-recent messages to return (default 50, max 1000).') },['sessionId']),
];

export const ANALYST_TOOL_NAMES: string[] = ANALYST_TOOL_DEFINITIONS.map((t) => t.function.name);
export default ANALYST_TOOL_DEFINITIONS;
