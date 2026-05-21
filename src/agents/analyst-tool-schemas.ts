import type { ToolDefinition } from './llm-client.js';

// Canonical vocabularies. Keep aligned with src/schemas/validators.ts.
// Exported so analyst-tools.ts can produce "Allowed values: ..." hints using
// the SAME list the JSON schema below advertises to the LLM.
export const CARD_STATUS_VALUES = ['drafting','backlog','active','running','blocked','changed','done','failed','cancelled'] as const;
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

  tool('lets_dance','Record a lets_dance directive on the project card so the runtime starts the planner loop on its next safe tick. Pre-conditions: the project card status must be `active` (not `backlog`) and the runtime must not be paused, frozen, or in error; otherwise the directive is queued but no work begins. If the project is in `backlog`, call edit_card to set status=active before calling lets_dance.',{},[]),
  tool('mark_goal_needs_corrections','Mark a goal/project subtree as needing corrections using canonical AnalystIssue entries.',{ goalId: str('Goal/project card ID.'), issues: arr({ type: 'object', properties: { summary: str('Issue summary.'), severity: strEnum('Optional issue severity.', ANALYST_ISSUE_SEVERITY_VALUES), evidence_path: str('Optional evidence path.') }, required: ['summary'], additionalProperties: false },'Canonical AnalystIssue entries.'), note: str('Optional note.') },['goalId','issues']),
  tool('mark_project_needs_corrections','Record a project-level corrections directive using canonical AnalystIssue entries.',{ issues: arr({ type: 'object', properties: { summary: str('Issue summary.'), severity: strEnum('Optional issue severity.', ANALYST_ISSUE_SEVERITY_VALUES), evidence_path: str('Optional evidence path.') }, required: ['summary'], additionalProperties: false },'Canonical AnalystIssue entries.'), note: str('Optional note.') },['issues']),
  tool('create_card',`Create a new card in the card tree. Status defaults to 'drafting'. To make a project/goal eligible to run, use status='active'. There is no 'ready' status.`,{ type: strEnum('The card type.', CARD_TYPE_VALUES), parent: str('The ID of the parent card. Use null only for a root project card.'), title: str('A short title.'), description: str('A detailed description.'), status: strEnum('Optional initial status.', CARD_STATUS_VALUES), tags: arr(str('A tag string'),'Optional tags.'), priority: int('Optional priority value (0-100).'), urgency: strEnum('Optional urgency level.', URGENCY_VALUES), acceptance: str('Optional acceptance criteria text.'), depends_on: arr(str('A card ID'),'Optional dependency list.'), id: str('Optional pre-assigned card ID.') },['type','title','description']),
  tool('edit_card',`Edit an existing card. Pass id plus only the fields you actually want to change. To make a project/goal eligible to run, use status='active'. Terminal statuses are done/failed/cancelled. There is no 'ready' or 'todo' status.`,{ id: str('The ID of the card to edit.'), title: str('New title.'), description: str('New description.'), status: strEnum('New status.', CARD_STATUS_VALUES), tags: arr(str('A tag string'),'New tags.'), priority: int('New priority (0-100).'), urgency: strEnum('New urgency level.', URGENCY_VALUES), acceptance: str('New acceptance criteria.'), depends_on: arr(str('A card ID'),'New dependency list.'), confirmed: bool('Set true to confirm a preview-only action.'), preview_hash: str('Preview hash returned by a prior preview response.') },['id']),
  tool('move_card','Re-parent a card in the tree.',{ id: str('The ID of the card to move.'), newParent: str('The ID of the new parent card. Use null to move to root level.') },['id','newParent']),
  tool('delete_card','Delete a card and all its descendants.',{ id: str('The ID of the card to delete.') },['id']),
  tool('add_note','Add a note to a card. Notes are transient append-only messages that influence running agents; they do NOT change card fields.',{ cardId: str('The ID of the card to add the note to.'), content: str('The text content of the note.'), kind: strEnum('The kind of note.', NOTE_KIND_VALUES) },['cardId','content']),
  tool('list_cards','List and filter cards in the project.',{ status: strEnum('Filter by status.', CARD_STATUS_VALUES), type: strEnum('Filter by card type.', CARD_TYPE_VALUES), parent: str('Filter by parent card ID.'), tag: str('Filter by tag.') },[]),
  tool('get_card','Get full details of a single card.',{ id: str('The ID of the card to retrieve.') },['id']),
  tool('get_tree','Show the card tree.',{ rootId: str('Optional root card ID.') },[]),
  tool('get_plan_diary','Read a goal planning diary.',{ goalId: str('The ID of the goal card.') },['goalId']),
  tool('get_card_output','Get output of processes associated with a card.',{ cardId: str('The ID of the card.'), lines: int('Number of lines to show.'), processId: str('Optional specific process ID.') },['cardId']),
  tool('get_status','Get the overall project status.',{},[]),
  tool('list_card_history','List card history headers for a card.',{ cardId: str('The ID of the card whose history to list.') },['cardId']),
  tool('get_card_history_entry','Get a specific card history entry snapshot.',{ cardId: str('The ID of the card.'), version_seq: int('The historical version sequence to retrieve.') },['cardId','version_seq']),
  tool('diff_card','Get a field-level diff between two card versions.',{ cardId: str('The ID of the card.'), fromSeq: int('Optional source version sequence. Defaults to previous version.'), toSeq: int('Optional target version sequence. Defaults to current version.') },['cardId']),
  tool('list_notes','List notes on a card.',{ cardId: str('The ID of the card.'), includeHandled: bool('Whether to include handled notes. Defaults to false.') },['cardId']),
  tool('get_note','Get a single note from a card.',{ cardId: str('The ID of the card.'), noteId: str('The ID of the note.') },['cardId','noteId']),
  tool('mark_note_handled','Mark a note handled.',{ cardId: str('The ID of the card.'), noteId: str('The ID of the note.') },['cardId','noteId']),
  tool('pause_runtime','Globally pause the runtime.',{},[]),
  tool('resume_runtime','Resume the runtime after a pause.',{},[]),
  tool('abort_goal','Abort a goal and all descendants.',{ goalId: str('The ID of the goal card to abort.') },['goalId']),
  tool('restart_card','Restart a completed, failed, or cancelled card.',{ id: str('The ID of the card to restart.') },['id']),
  tool('restart_goal','Restart a goal.',{ goalId: str('The ID of the goal card to restart.') },['goalId']),
  tool('read_file','Read the contents of any file the saivage service can see on the host. Returns up to maxBytes bytes (default 200000, max 1000000). Binary files return content=null with binary=true. Use absolute paths or paths relative to the saivage server cwd.',{ path: str('Absolute or relative file path.'), maxBytes: int('Max bytes to read (default 200000, max 1000000).') },['path']),
  tool('list_directory','List the contents of any directory the saivage service can see on the host. Use absolute paths or paths relative to the saivage server cwd.',{ path: str('Absolute or relative directory path.'), maxEntries: int('Max entries to return (default 500, max 5000).') },['path']),
  tool('run_shell_command','Run a bounded inspection shell command. Destructive commands are denied on web-chat and must not be used to mutate project source or runtime state.',{ command: str('Shell command to inspect the host or project state.'), cwd: str('Optional working directory. Defaults to the project root.'), timeoutMs: int('Optional timeout in milliseconds (default 15000, max 60000).'), maxOutputBytes: int('Optional per-stream output cap in bytes (default 65536, max 1048576).'), confirmed: bool('Set true to confirm a preview-only action.'), preview_hash: str('Preview hash returned by a prior preview response.') },['command']),
  tool('read_runtime_events','Tail the project runtime events log (.saivage/runtime/events.jsonl). Optionally filter by event kind.',{ limit: int('Number of recent events (default 50, max 1000).'), kind: str('Optional event kind filter.') },[]),
  tool('read_runtime_errors','Tail the project runtime errors log (.saivage/runtime/errors.jsonl).',{ limit: int('Number of recent errors (default 50, max 1000).') },[]),
  tool('read_control_actions','Tail the control-action audit log (.saivage/runtime/control-actions.jsonl). Shows mutating actions performed by analyst/planner/operator.',{ limit: int('Number of recent entries (default 50, max 1000).'), since: str('Optional ISO timestamp; only return entries created at or after this time.') },[]),
  tool('list_processes_tool','List all runtime processes (not card-scoped). Optionally filter by status (running, finished, failed, killed) or cardId.',{ status: str('Optional status filter.'), cardId: str('Optional card-scope filter.') },[]),
  tool('list_agent_sessions','List all agent sessions in the project (analyst, planner, executor, etc.), not just the current analyst session.',{},[]),
  tool('read_agent_session','Read a specific agent session\'s metadata and most recent persisted messages. Useful for inspecting what other agents (planner, executor, etc.) have been doing.',{ sessionId: str('The session ID to inspect.'), lastN: int('How many most-recent messages to return (default 50, max 1000).') },['sessionId']),
];

export const ANALYST_TOOL_NAMES: string[] = ANALYST_TOOL_DEFINITIONS.map((t) => t.function.name);
export default ANALYST_TOOL_DEFINITIONS;
