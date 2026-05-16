import type { AgentMessage } from '../schemas/types.js';
import { LlmClient, type ToolDefinition } from './llm-client.js';
import { ANALYST_TOOL_DEFINITIONS } from './analyst-tool-schemas.js';
import { loadConfig } from './config-schema.js';
import { ModelRouter } from './model-router.js';
import { ProviderRegistry, type Candidate } from './provider.js';
import { resolveLlmTransportConfig } from './llm-transport.js';

const ANALYST_SYSTEM_PROMPT = `You are the Saivage Analyst — a conversational control-plane agent that helps users manage and repair their project.

You have access to tools for card management, execution control, history inspection, notes, notifications, and project inspection.
Choose the most appropriate tool, extract parameters, and use project context before asking follow-up questions.
If the request requires a destructive action, call the tool anyway — the system will handle preview/confirmation.`;

import {
  create_card, edit_card, move_card, delete_card, add_note, list_cards, get_card, get_tree, get_plan_diary, get_card_output, get_status,
  list_card_history, get_card_history_entry, diff_card, list_notes, get_note, mark_note_handled, acknowledge_notification,
  pause_runtime, resume_runtime, abort_goal, restart_card, restart_goal, kill_process,
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
  async resolve(userContent: string, conversationHistory: AgentMessage[] = [], projectContext?: string): Promise<ResolvedIntent | null> {
    if (!await this.ensureClient()) return null;
    try {
      const result = await this.llmClient!.complete(this.candidate!, projectContext ? `${ANALYST_SYSTEM_PROMPT}\n\n## Current Project Context\n${projectContext}` : ANALYST_SYSTEM_PROMPT, conversationHistory, 'analyst-llm-resolve', { tools: this.tools, tool_choice: 'auto', temperature: 0.1, max_tokens: 1000 });
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
