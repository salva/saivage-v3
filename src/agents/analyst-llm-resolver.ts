/**
 * LLM-based Intent Resolver for the Analyst Handler.
 *
 * This replaces the heuristic regex-based intent parsing as the primary
 * routing mechanism. The LLM receives user messages along with tool definitions
 * for all 17 analyst tools, and chooses which tool to call based on the
 * natural language request.
 *
 * The regex-based `parseIntent()` is kept as a fallback for when the LLM
 * is unavailable (e.g., no API key configured, network error) or returns
 * no tool calls.
 */

import type { AgentMessage } from '../schemas/types.js';
import { LlmClient, type LlmCompleteResult, type ToolDefinition } from './llm-client.js';
import { ANALYST_TOOL_DEFINITIONS } from './analyst-tool-schemas.js';
import { loadConfig } from './config-schema.js';

// ── System Prompt for the Analyst LLM ──────────────────────────

const ANALYST_SYSTEM_PROMPT = `You are the Saivage Analyst — a conversational agent that helps users manage their project.

You have access to 17 tools for:
- **Card management**: create, edit, move, delete cards and add notes
- **Execution control**: pause/resume runtime, abort/restart goals and cards, kill processes
- **Inspection**: list cards, get card details, show tree, read plan diaries, get process output, get status

When the user asks a question or gives a command:
1. Choose the most appropriate tool to fulfill their request
2. Extract all necessary parameters from the user's message
3. If a parameter is missing, make a reasonable guess or ask the user
4. If the request requires a destructive action (delete, abort, kill, restart), call the tool anyway — the system will show a preview and ask for confirmation before executing

Always respond in a helpful, conversational manner. If the user's request doesn't match any available tool, let them know what you CAN help with.`;

// ── Tool Name ↔ Tool Fn Map (imported from analyst-tools.ts) ──

import {
  create_card,
  edit_card,
  move_card,
  delete_card,
  add_note,
  list_cards,
  get_card,
  get_tree,
  get_plan_diary,
  get_card_output,
  get_status,
  pause_runtime,
  resume_runtime,
  abort_goal,
  restart_card,
  restart_goal,
  kill_process,
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
  pause_runtime: pause_runtime as unknown as ToolFn,
  resume_runtime: resume_runtime as unknown as ToolFn,
  abort_goal: abort_goal as unknown as ToolFn,
  restart_card: restart_card as unknown as ToolFn,
  restart_goal: restart_goal as unknown as ToolFn,
  kill_process: kill_process as unknown as ToolFn,
};

// ── Parsed Intent (output of the resolver) ─────────────────────

export interface ResolvedIntent {
  tool: string;
  params: Record<string, unknown>;
  source: 'llm' | 'regex' | 'help';
  llmResponse?: string; // Text content from LLM if it responded without calling a tool
}

// ── LlmIntentResolver ──────────────────────────────────────────

export class LlmIntentResolver {
  private llmClient: LlmClient | null = null;
  private tools: ToolDefinition[];
  private configPath: string;

  constructor(configPath: string) {
    this.tools = ANALYST_TOOL_DEFINITIONS;
    this.configPath = configPath;
  }

  /**
   * Initialize the LLM client from project config.
   * This reads the config to find the default provider/account/model
   * and creates an LlmClient for the analyst.
   *
   * Returns true if the client was successfully initialized,
   * false if no LLM provider is configured (fall back to regex).
   */
  private ensureClient(): boolean {
    if (this.llmClient) return true;

    try {
      const { config } = loadConfig(this.configPath);
      const models = config.models?.default;
      if (!models || models.length === 0) return false;

      const providers = config.providers;
      if (!providers) return false;

      // Find the default provider — first model in models.default
      const defaultModel = models[0];
      // Find which provider serves this model
      let baseUrl: string | undefined;
      let apiKey: string | undefined;

      for (const [providerName, providerCfg] of Object.entries(providers)) {
        const cfg = providerCfg as {
          baseUrl?: string;
          apiKey?: string;
          models?: string[];
        };
        if (cfg.models?.includes(defaultModel)) {
          baseUrl = cfg.baseUrl || 'https://api.openai.com';
          apiKey = cfg.apiKey;
          break;
        }
      }

      if (!baseUrl) {
        // Fallback: use the first provider
        const firstProvider = Object.values(providers)[0] as {
          baseUrl?: string;
          apiKey?: string;
        } | undefined;
        if (!firstProvider) return false;
        baseUrl = firstProvider.baseUrl || 'https://api.openai.com';
        apiKey = firstProvider.apiKey;
      }

      this.llmClient = new LlmClient(baseUrl, apiKey);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a user's message into an intent using the LLM.
   *
   * The flow is:
   * 1. Send the user's message to the LLM with tool definitions
   * 2. If LLM returns tool_calls, parse them into a ResolvedIntent
   * 3. If LLM returns text content, return it as a help/chat response
   * 4. If LLM is unavailable or returns no tool_calls, return null so the caller falls back to regex
   *
   * @param userContent - The user's natural language message
   * @param conversationHistory - Previous messages in the session for context
   * @returns A ResolvedIntent or null if LLM is unavailable
   */
  async resolve(
    userContent: string,
    conversationHistory: AgentMessage[] = [],
  ): Promise<ResolvedIntent | null> {
    if (!this.ensureClient()) {
      return null; // LLM not configured, fall back to regex
    }

    try {
      const result = await this.llmClient!.complete(
        {
          provider: 'analyst',
          account: null,
          model: 'default',

        },
        ANALYST_SYSTEM_PROMPT,
        conversationHistory,
        'analyst-llm-resolve',
        {
          tools: this.tools,
          tool_choice: 'auto',
          temperature: 0.1,
          max_tokens: 1000,
        },
      );

      // Check if LLM returned tool calls
      if (result.finishReason === 'tool_calls' && result.toolCalls.length > 0) {
        const tc = result.toolCalls[0]; // Use the first tool call
        let params: Record<string, unknown> = {};
        try {
          params = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          // If arguments can't be parsed, pass empty params
          params = {};
        }

        return {
          tool: tc.function.name,
          params,
          source: 'llm',
        };
      }

      // LLM returned text content (chat response without tool call)
      if (result.content) {
        return {
          tool: '',
          params: {},
          source: 'help',
          llmResponse: result.content,
        };
      }

      // No tool calls and no content — fall back
      return null;
    } catch {
      // LLM call failed (network error, auth, etc.) — fall back to regex
      return null;
    }
  }
}

export { TOOL_REGISTRY };
