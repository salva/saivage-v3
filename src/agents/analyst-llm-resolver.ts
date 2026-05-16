import type { AgentMessage } from '../schemas/types.js';
import { LlmClient, type ToolDefinition, type LlmCompleteResult } from './llm-client.js';
import { ANALYST_TOOL_DEFINITIONS } from './analyst-tool-schemas.js';
import { loadConfig } from './config-schema.js';
import { ModelRouter } from './model-router.js';
import { ProviderRegistry, type Candidate } from './provider.js';
import { resolveLlmTransportConfig } from './llm-transport.js';

const ANALYST_SYSTEM_PROMPT = `You are the Saivage Analyst — the user's conversational interface to the
whole Saivage system and the project it is currently running. You are a general chat agent backed by
tools. Your job is to inspect, analyze, and explain what is happening — and to direct work by talking
to the system, not by executing delivery work directly.

What you can do:
- Inspect anything the saivage service can see: cards, the card tree, runtime state, runtime
  events/errors logs, the control-action audit, processes, other agent sessions (planner, executor,
  etc.), arbitrary files on the host via read_file / list_directory, and bounded inspection shell
  commands via run_shell_command.
- Chain tools in one turn. After a tool runs you get its result; use that data to call more tools or
  to write a clear natural-language answer. Do not say "Action completed" — explain what you
  actually saw.
- Issue control actions to the system: pause/resume the runtime, abort or restart goals/cards, kill
  processes, create/edit/move/delete cards, add notes (including 'directive' notes) so the planner
  and executor agents pick up the change of plan.

What you do NOT do:
- You must never use shell to mutate the host, edit the target project's source tree, run builds or
  tests for delivery, deploy, or perform planner/executor/reviewer work. If work needs to happen,
  create a card or add a directive note describing what should be done.
- Destructive shell commands are denied on web-chat. If inspection suggests a dangerous fix, explain
  it and delegate through cards, notes, or canonical control tools instead.
- Secret-bearing paths and secrets are off-limits. A centralized denylist blocks reads and flags shell
  commands that touch auth profiles, env files, SSH keys, cloud credentials, provider tokens, or similar
  secret material; list_directory also redacts matching entries instead of naming them. Use safer
  inspection paths.

Useful safe inspection patterns:
- run_shell_command for: ls, pwd, cat, grep, rg, git status, git diff, journalctl --no-pager,
  systemctl status, systemctl is-active, curl .../health, node --version.
- read_file / list_directory for source, docs, logs, runtime state, and host-visible non-secret files.

How to behave:
- When the user asks a question about state ("what is the runtime doing?", "why did X fail?"), call
  the relevant inspection tools first, then summarize honestly using the data you fetched.
- For preview-only control actions, call the tool first; the system returns a preview with a
  preview_hash that the user must approve. Surface the preview. When the user confirms, call the
  same tool again with confirmed=true and the preview_hash from the previous response.
- If a tool returns success=false, explain the failure and suggest the next step instead of
  silently retrying.
- Use the project context (provided below) to look up card IDs and parents before asking the user
  for them. If the project context is missing what you need, call a list/get tool to fetch it.
- Keep replies grounded in the data you actually fetched. Be concise but complete.`;

import {
  create_card, edit_card, move_card, delete_card, add_note, list_cards, get_card, get_tree, get_plan_diary, get_card_output, get_status,
  list_card_history, get_card_history_entry, diff_card, list_notes, get_note, mark_note_handled, acknowledge_notification,
  pause_runtime, resume_runtime, abort_goal, restart_card, restart_goal, kill_process,
  read_file, list_directory, run_shell_command, read_runtime_events, read_runtime_errors, read_control_actions,
  list_processes_tool, list_agent_sessions, read_agent_session,
} from './analyst-tools.js';
import type { ToolResult, ToolContext } from './analyst-tools.js';

type ToolFn = (ctx: ToolContext, params: Record<string, unknown>) => Promise<ToolResult>;

const TOOL_REGISTRY: Record<string, ToolFn> = {
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
  acknowledge_notification: acknowledge_notification as unknown as ToolFn,
  pause_runtime: pause_runtime as unknown as ToolFn,
  resume_runtime: resume_runtime as unknown as ToolFn,
  abort_goal: abort_goal as unknown as ToolFn,
  restart_card: restart_card as unknown as ToolFn,
  restart_goal: restart_goal as unknown as ToolFn,
  kill_process: kill_process as unknown as ToolFn,
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

export interface ResolvedIntent { tool: string; params: Record<string, unknown>; source: 'llm' | 'regex' | 'help'; llmResponse?: string; }

export class LlmIntentResolver {
  private llmClient: LlmClient | null = null;
  private candidate: Candidate | null = null;
  private tools: ToolDefinition[];
  private configPath: string;
  constructor(configPath: string) { this.tools = ANALYST_TOOL_DEFINITIONS; this.configPath = configPath; }

  private async ensureClient(): Promise<boolean> {
    if (this.llmClient) return true;
    try {
      const { config } = loadConfig(this.configPath);
      const registry = new ProviderRegistry(config);
      const router = new ModelRouter(config, registry, this.configPath);
      const [candidate] = await router.resolve('analyst');
      if (!candidate) return false;
      const { baseUrl, apiKey } = await resolveLlmTransportConfig(this.configPath, registry, candidate);
      this.llmClient = new LlmClient(baseUrl, apiKey);
      this.candidate = candidate;
      return true;
    } catch { return false; }
  }

  async isAvailable(): Promise<boolean> { return this.ensureClient(); }

  async chat(conversationHistory: AgentMessage[], projectContext?: string): Promise<LlmCompleteResult> {
    const ok = await this.ensureClient();
    if (!ok) throw new Error('Analyst LLM client could not be initialized (provider/model not configured).');
    const systemPrompt = projectContext
      ? `${ANALYST_SYSTEM_PROMPT}\n\n## Current Project Context\n${projectContext}`
      : ANALYST_SYSTEM_PROMPT;
    return await this.llmClient!.complete(this.candidate!, systemPrompt, conversationHistory, 'analyst', {
      tools: this.tools,
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: 2000,
    });
  }

  async resolve(userContent: string, conversationHistory: AgentMessage[] = [], projectContext?: string): Promise<ResolvedIntent | null> {
    if (!await this.ensureClient()) return null;
    try {
      const result = await this.chat(conversationHistory, projectContext);
      if (result.finishReason === 'tool_calls' && result.toolCalls.length > 0) {
        const tc = result.toolCalls[0];
        let params: Record<string, unknown> = {};
        try { params = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { params = {}; }
        return { tool: tc.function.name, params, source: 'llm' };
      }
      if (result.content) return { tool: '', params: {}, source: 'help', llmResponse: result.content };
      return null;
    } catch { return null; }
  }
}

export { TOOL_REGISTRY };
