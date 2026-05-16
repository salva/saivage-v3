/**
 * Analyst Tool Schemas — OpenAI-compatible function definitions for analyst and agent-accessible tools.
 */

import type { ToolDefinition } from './llm-client.js';

function str(description: string): Record<string, unknown> { return { type: 'string', description }; }
function int(description: string): Record<string, unknown> { return { type: 'integer', description }; }
function bool(description: string): Record<string, unknown> { return { type: 'boolean', description }; }
function arr(items: Record<string, unknown>, description?: string): Record<string, unknown> { const result: Record<string, unknown> = { type: 'array', items }; if (description) result.description = description; return result; }
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

export const ANALYST_TOOL_DEFINITIONS: ToolDefinition[] = [
  tool('create_card','Create a new card in the card tree.',{ type: str('The card type.'), parent: str('The ID of the parent card. Use null only for a root project card.'), title: str('A short title.'), description: str('A detailed description.'), status: str('Optional initial status.'), tags: arr(str('A tag string'),'Optional tags.'), priority: int('Optional priority value.'), urgency: str('Optional urgency level.'), acceptance: str('Optional acceptance criteria text.'), depends_on: arr(str('A card ID'),'Optional dependency list.'), id: str('Optional pre-assigned card ID.') },['type','title','description']),
  tool('edit_card','Edit an existing card.',{ id: str('The ID of the card to edit.'), title: str('New title.'), description: str('New description.'), status: str('New status.'), tags: arr(str('A tag string'),'New tags.'), priority: int('New priority.'), urgency: str('New urgency level.'), acceptance: str('New acceptance criteria.'), depends_on: arr(str('A card ID'),'New dependency list.') },['id']),
  tool('move_card','Re-parent a card in the tree.',{ id: str('The ID of the card to move.'), newParent: str('The ID of the new parent card. Use null to move to root level.') },['id','newParent']),
  tool('delete_card','Delete a card and all its descendants.',{ id: str('The ID of the card to delete.') },['id']),
  tool('add_note','Add a note to a card.',{ cardId: str('The ID of the card to add the note to.'), content: str('The text content of the note.'), kind: str('The kind of note.') },['cardId','content']),
  tool('list_cards','List and filter cards in the project.',{ status: str('Filter by status.'), type: str('Filter by card type.'), parent: str('Filter by parent card ID.'), tag: str('Filter by tag.') },[]),
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
  tool('acknowledge_notification','Acknowledge a notification for the calling session.',{ notificationId: str('The ID of the notification to acknowledge.') },['notificationId']),
  tool('pause_runtime','Globally pause the runtime.',{},[]),
  tool('resume_runtime','Resume the runtime after a pause.',{},[]),
  tool('abort_goal','Abort a goal and all descendants.',{ goalId: str('The ID of the goal card to abort.') },['goalId']),
  tool('restart_card','Restart a completed, failed, or cancelled card.',{ id: str('The ID of the card to restart.') },['id']),
  tool('restart_goal','Restart a goal.',{ goalId: str('The ID of the goal card to restart.') },['goalId']),
  tool('kill_process','Kill a running external process by its process ID.',{ processId: str('The ID of the process to kill.') },['processId']),
];

export const ANALYST_TOOL_NAMES: string[] = ANALYST_TOOL_DEFINITIONS.map((t) => t.function.name);
export default ANALYST_TOOL_DEFINITIONS;
