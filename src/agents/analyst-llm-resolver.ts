import type { AgentMessage } from '../schemas/types.js';
import { LlmClient, type ToolDefinition, type LlmCompleteResult } from './llm-client.js';
import { ANALYST_TOOL_DEFINITIONS } from './analyst-tool-schemas.js';
import { loadConfig } from './config-schema.js';
import { ModelRouter } from './model-router.js';
import { ProviderRegistry, type Candidate } from './provider.js';
import { resolveLlmTransportConfig } from './llm-transport.js';
import {
  mark_goal_needs_corrections,
  create_card, edit_card, move_card, delete_card, add_note, list_cards, get_card, get_tree, get_plan_diary, get_card_output, get_status,
  list_card_history, get_card_history_entry, diff_card, list_notes, get_note, mark_note_handled,
  pause_runtime, resume_runtime, abort_goal, restart_card, restart_goal,
  read_file, list_directory, run_shell_command, read_runtime_events, read_runtime_errors, read_control_actions,
  list_processes_tool, list_agent_sessions, read_agent_session,
} from './analyst-tools.js';
import type { ToolResult, ToolContext } from './analyst-tools.js';

const ANALYST_SYSTEM_PROMPT = `You are the Saivage Analyst — the user's conversational interface to the Saivage system.

Inspect first, then answer or act. You may inspect cards, runtime state/events/errors, processes, agent sessions, non-secret files, and bounded shell output. You may mutate planning metadata with card/note tools and runtime controls, but you do not perform delivery work yourself.

Cards are durable project state. Notes are transient planner/executor context. If the user asks for a durable objective/scope/acceptance change, edit the relevant card and optionally add a directive note. If the user only wants to nudge a planner, add a note.

Canonical vocabularies:
- Card status: drafting | backlog | active | running | blocked | changed | done | failed | cancelled. There is no ready/todo/open/wip status.
- Card type: project | goal | architecture | code | test | doc | data | research | ops.
- Urgency: low | normal | high | critical.
- Note kind: comment | progress | directive | escalation.
- AnalystIssue severity: info | warning | blocker.

Runtime control semantics:
- Root project execution starts only through explicit runtime start_project controls owned by the runtime/operator API. Do not try to start root work by mutating card status or by recording directive files.
- Child work starts only when a parent planner calls activate_card; card status is planner-owned metadata, not an executable trigger.
- Mutation tools validate directly and return actionable errors. Do not add confirmed or preview_hash fields.

Safety:
- Never read or expose secret-bearing files or credentials.
- Do not use shell to mutate source, deploy, run delivery builds/tests, or perform planner/executor work. Delegate work through cards, notes, or runtime controls.
- If a tool returns success=false, explain the failure and suggest the next step. Keep replies grounded in fetched data.`;

type ToolFn = (ctx: ToolContext, params: Record<string, unknown>) => Promise<ToolResult>;

export const TOOL_REGISTRY: Record<string, ToolFn> = {
  mark_goal_needs_corrections: mark_goal_needs_corrections as unknown as ToolFn,
  create_card: create_card as unknown as ToolFn,
  edit_card: edit_card as unknown as ToolFn,
  move_card: move_card as unknown as ToolFn,
  delete_card: delete_card as unknown as ToolFn,
  add_note: add_note as unknown as ToolFn,
  list_cards: list_cards as unknown as ToolFn,
  get_card: get_card as unknown as ToolFn,
  get_tree: get_tree as unknown as ToolFn,
  get_plan_diary: get_plan_diary as unknown as ToolFn,
  get_card_output: get_card_output as unknown as ToolFn,
  get_status: get_status as unknown as ToolFn,
  list_card_history: list_card_history as unknown as ToolFn,
  get_card_history_entry: get_card_history_entry as unknown as ToolFn,
  diff_card: diff_card as unknown as ToolFn,
  list_notes: list_notes as unknown as ToolFn,
  get_note: get_note as unknown as ToolFn,
  mark_note_handled: mark_note_handled as unknown as ToolFn,
  pause_runtime: pause_runtime as unknown as ToolFn,
  resume_runtime: resume_runtime as unknown as ToolFn,
  abort_goal: abort_goal as unknown as ToolFn,
  restart_card: restart_card as unknown as ToolFn,
  restart_goal: restart_goal as unknown as ToolFn,
  read_file: read_file as unknown as ToolFn,
  list_directory: list_directory as unknown as ToolFn,
  run_shell_command: run_shell_command as unknown as ToolFn,
  read_runtime_events: read_runtime_events as unknown as ToolFn,
  read_runtime_errors: read_runtime_errors as unknown as ToolFn,
  read_control_actions: read_control_actions as unknown as ToolFn,
  list_processes_tool: list_processes_tool as unknown as ToolFn,
  list_agent_sessions: list_agent_sessions as unknown as ToolFn,
  read_agent_session: read_agent_session as unknown as ToolFn,
};

export interface AnalystLlmRuntimeOptions { projectRoot: string; sessionId?: string; ctx: Omit<ToolContext, 'sessionId'>; }
export interface AnalystLlmResolvedToolCall { id: string; name: string; arguments: Record<string, unknown>; result: ToolResult; }
export interface AnalystLlmResponse { content: string; toolCalls: AnalystLlmResolvedToolCall[]; raw: LlmCompleteResult; candidate?: Candidate; }

function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function getAnalystToolDefinitions(): ToolDefinition[] { return ANALYST_TOOL_DEFINITIONS; }
export function getAnalystSystemPrompt(): string { return ANALYST_SYSTEM_PROMPT; }

export async function resolveAnalystLlm(_messages: AgentMessage[], _options: AnalystLlmRuntimeOptions): Promise<AnalystLlmResponse> { throw new Error('Direct analyst LLM resolver is unavailable in this build; use LlmIntentResolver.chat through AnalystHandler.'); }

export class LlmIntentResolver {
  constructor(private readonly projectRoot: string) {}
  async isAvailable(): Promise<boolean> { return false; }
  async chat(_messages: AgentMessage[], _projectContext: string): Promise<{ content: string; toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> }> { return { content: '', toolCalls: [] }; }
}

export const ANALYST_TOOL_REGISTRY = TOOL_REGISTRY;
