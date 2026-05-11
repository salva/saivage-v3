/**
 * Analyst Tool Schemas — OpenAI-compatible function definitions for all 17 analyst tools.
 *
 * Each tool is described with a JSON Schema parameters object that matches the
 * parameter types accepted by the corresponding tool function in analyst-tools.ts.
 * These schemas are sent to the LLM as the `tools` parameter so the LLM can
 * choose which tool to call based on the user's natural language request.
 */

import type { ToolDefinition } from './llm-client.js';

// ── Helper: Build a JSON Schema property from a Zod-like description ────

/**
 * Create a JSON Schema property definition for a tool parameter.
 */
function str(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

function int(description: string): Record<string, unknown> {
  return { type: 'integer', description };
}

function num(description: string): Record<string, unknown> {
  return { type: 'number', description };
}

function bool(description: string): Record<string, unknown> {
  return { type: 'boolean', description };
}

function arr(items: Record<string, unknown>, description?: string): Record<string, unknown> {
  const result: Record<string, unknown> = { type: 'array', items };
  if (description) result.description = description;
  return result;
}

function obj(properties: Record<string, unknown>, description?: string): Record<string, unknown> {
  const result: Record<string, unknown> = { type: 'object', properties };
  if (description) result.description = description;
  return result;
}

// ── Tools Definitions ──────────────────────────────────────────

/**
 * Tool definition builder.
 */
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

// ── All 17 Analyst Tools ───────────────────────────────────────

export const ANALYST_TOOL_DEFINITIONS: ToolDefinition[] = [
  // 1. create_card
  tool(
    'create_card',
    'Create a new card in the card tree. Use this when the user wants to create a new task, goal, or any other card type. All card types except "project" require a parent. The default status is "drafting".',
    {
      type: str('The card type. Terminal types are: code, test, doc, data, research, ops, architecture. Non-terminal types: goal, plan. Use "project" only for root-level cards.'),
      parent: str('The ID of the parent card. Must be an existing card ID. Use null for root-level cards.'),
      title: str('A short, imperative title for the card.'),
      description: str('A detailed description of what this card should accomplish.'),
      status: str('Optional initial status. Default: "drafting". Common values: backlog, drafting, active.'),
      tags: arr(str('A tag string'), 'Optional tags for categorizing the card.'),
      priority: int('Optional priority value. Lower numbers are more urgent (0 = highest).'),
      urgency: str('Optional urgency level. One of: low, normal, high, critical.'),
      acceptance: str('Optional acceptance criteria text.'),
      depends_on: arr(str('A card ID'), 'Optional list of card IDs that must complete before this card.'),
      id: str('Optional pre-assigned card ID. If not provided, one will be auto-generated.'),
    },
    ['type', 'parent', 'title', 'description'],
  ),

  // 2. edit_card
  tool(
    'edit_card',
    'Edit an existing card\'s fields. Only allowed fields can be modified: title, description, status, tags, priority, urgency, acceptance, depends_on, related, estimate, subtype, assigned_to, result, metrics, started_at, completed_at, duration_ms, error.',
    {
      id: str('The ID of the card to edit.'),
      title: str('New title for the card.'),
      description: str('New description for the card.'),
      status: str('New status. One of: drafting, backlog, active, running, blocked, done, failed, cancelled.'),
      tags: arr(str('A tag string'), 'New tags for the card.'),
      priority: int('New priority value. Lower = more urgent.'),
      urgency: str('New urgency level. One of: low, normal, high, critical.'),
      acceptance: str('New acceptance criteria.'),
      depends_on: arr(str('A card ID'), 'New dependency list.'),
    },
    ['id'],
  ),

  // 3. move_card
  tool(
    'move_card',
    'Re-parent a card in the tree by moving it to a new parent. Use this when the user wants to reorganize cards.',
    {
      id: str('The ID of the card to move.'),
      newParent: str('The ID of the new parent card. Use null to move to root level. Cannot be the card itself or one of its descendants.'),
    },
    ['id', 'newParent'],
  ),

  // 4. delete_card
  tool(
    'delete_card',
    'Delete a card and all its descendants. This is a destructive action that will show a preview first. After the preview, the user must confirm to complete the deletion.',
    {
      id: str('The ID of the card to delete. All descendant cards will also be deleted.'),
    },
    ['id'],
  ),

  // 5. add_note
  tool(
    'add_note',
    'Add a note, comment, directive, or progress update to a card. Notes are appended to a card\'s activity log.',
    {
      cardId: str('The ID of the card to add the note to.'),
      content: str('The text content of the note.'),
      kind: str('The kind of note. One of: comment (general remark), directive (instruction for the executor), progress (status update), escalation (issue needing attention). Default: comment.'),
    },
    ['cardId', 'content'],
  ),

  // 6. list_cards
  tool(
    'list_cards',
    'List and filter cards in the project. Returns a summary of matching cards including their ID, type, title, status, priority, and parent.',
    {
      status: str('Filter by card status. One of: drafting, backlog, active, running, blocked, done, failed, cancelled.'),
      type: str('Filter by card type. One of: project, goal, plan, code, test, doc, data, research, ops, architecture.'),
      parent: str('Filter by parent card ID. Use null for root-level cards only.'),
      tag: str('Filter by tag. Only cards with this tag will be returned.'),
    },
    [],
  ),

  // 7. get_card
  tool(
    'get_card',
    'Get full details of a single card, including its notes and children. Use this when the user asks to inspect, view, or examine a specific card.',
    {
      id: str('The ID of the card to retrieve.'),
    },
    ['id'],
  ),

  // 8. get_tree
  tool(
    'get_tree',
    'Show the card tree, optionally rooted at a specific card. Use this when the user asks to see the hierarchy, tree, or structure of cards.',
    {
      rootId: str('Optional root card ID. Defaults to "project" to show the full tree.'),
    },
    [],
  ),

  // 9. get_plan_diary
  tool(
    'get_plan_diary',
    'Read a goal\'s plan card diary, which contains the planner\'s decision history and any review results. Use this when the user asks about planning history or why something was decided.',
    {
      goalId: str('The ID of the goal card to read the diary for. The plan card must exist (plan-{goalId}).'),
    },
    ['goalId'],
  ),

  // 10. get_card_output
  tool(
    'get_card_output',
    'Get the output (stdout/stderr) of processes associated with a card. Shows recent output from running or completed processes. Use when the user asks what a card/process did or is doing.',
    {
      cardId: str('The ID of the card whose process output to retrieve.'),
      lines: int('Number of lines to show (default 50).'),
      processId: str('Optional specific process ID to get output from.'),
    },
    ['cardId'],
  ),

  // 11. get_status
  tool(
    'get_status',
    'Get the overall project status including runtime state, card counts, running processes, and the ready queue. Use when the user asks "what\'s the status", "how is it going", or "what\'s happening".',
    {},
    [],
  ),

  // 12. pause_runtime
  tool(
    'pause_runtime',
    'Globally pause the runtime. This stops new planner, executor, and reviewer dispatch. Already-running processes are not automatically killed. Use when the user wants to pause all work.',
    {},
    [],
  ),

  // 13. resume_runtime
  tool(
    'resume_runtime',
    'Resume the runtime after a pause. This re-enables dispatch of planner, executor, and reviewer agents.',
    {},
    [],
  ),

  // 14. abort_goal
  tool(
    'abort_goal',
    'Abort (cancel) a goal and all of its descendant cards. This is a destructive action that will show a preview first requiring user confirmation.',
    {
      goalId: str('The ID of the goal card to abort. All descendant cards will be set to "cancelled".'),
    },
    ['goalId'],
  ),

  // 15. restart_card
  tool(
    'restart_card',
    'Restart a completed, failed, or cancelled card by moving it back to backlog and clearing its result and error. Only works for cards with status done, failed, or cancelled.',
    {
      id: str('The ID of the card to restart.'),
    },
    ['id'],
  ),

  // 16. restart_goal
  tool(
    'restart_goal',
    'Restart a goal by cancelling its running children, clearing the plan diary, and setting the goal back to backlog so the planner can start fresh. This is a destructive action that shows a preview first.',
    {
      goalId: str('The ID of the goal card to restart.'),
    },
    ['goalId'],
  ),

  // 17. kill_process
  tool(
    'kill_process',
    'Kill a running external process by its process ID. Shows a preview first requiring confirmation.',
    {
      processId: str('The ID of the process to kill.'),
    },
    ['processId'],
  ),
];

/**
 * Map of tool name -> JSON string parameter schema.
 * Used for validation after LLM returns a tool call.
 */
export const ANALYST_TOOL_NAMES: string[] = ANALYST_TOOL_DEFINITIONS.map((t) => t.function.name);

export default ANALYST_TOOL_DEFINITIONS;
