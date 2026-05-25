import { join } from 'node:path';
import type { AgentMessage } from '../schemas/index.js';
import type { ToolDefinition, ToolCall } from './llm-client.js';
import {
  LlmAuthError,
  LlmClient,
  LlmParseError,
  LlmRateLimitError,
  LlmServerError,
  LlmTimeoutError,
} from './llm-client.js';
import { ANALYST_TOOL_DEFINITIONS } from './analyst-tool-schemas.js';
import { loadConfig, getModelParamsForRole, getRuntimeConfig } from './config-schema.js';
import type { RuntimeSection } from './config-schema.js';
import { ModelRouter } from './model-router.js';
import { ProviderRegistry } from './provider.js';
import { capabilityRequestForLlmOptions } from './provider-capabilities.js';
import { resolveLlmTransportConfig } from './llm-transport.js';
import { createLlmExchangeRecorder, toRecorderLogger } from './llm-exchange-recorder.js';
import type { LlmExchangeRecorder, LlmExchangeRecorderLogger } from './llm-exchange-recorder.js';
import {
  mark_goal_needs_corrections,
  create_card, edit_card, move_card, delete_card, add_note, list_cards, get_card, get_tree, get_plan_diary, get_card_output, get_status,
  list_card_history, get_card_history_entry, diff_card, list_notes, get_note, mark_note_handled,
  pause_runtime, resume_runtime, abort_goal, restart_card, restart_goal,
  read_file, list_directory, run_shell_command, read_runtime_events, read_runtime_errors, read_control_actions,
  list_processes_tool, list_agent_sessions, read_agent_session,
} from './analyst-tools.js';
import type { ToolResult, ToolContext } from './analyst-tools.js';

export const ANALYST_OFFLINE_REPLY = "analyst is offline: no provider is configured for role=analyst, or the configured provider failed to authenticate. Configure a provider for role 'analyst' in the project configuration and try again.";

export class AnalystOfflineError extends Error {
  constructor(message: string = ANALYST_OFFLINE_REPLY) {
    super(message);
    this.name = 'AnalystOfflineError';
  }
}

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

function formatToolList(tools: ToolDefinition[]): string {
  return tools.map((tool) => `- ${tool.function.name}: ${tool.function.description}`).join('\n');
}

const ANALYST_SYSTEM_PROMPT = `You are the Saivage Analyst — the user's conversational interface to the Saivage system. You inspect, steer, reconfigure, and repair the autonomous runtime by calling tools. You do not perform delivery work yourself; you delegate by creating or editing cards, by queueing notes, and by issuing runtime control actions.

Available tools (call them via the tool-call API channel, never as plain text):
${formatToolList(ANALYST_TOOL_DEFINITIONS)}

Conversational behaviour:
- Resolve deictic references ("this", "the current one", "that card", "and the other one too", "do it") against the IMMEDIATELY PRIOR user turn and the immediately prior assistant turn in this session. If the prior context does not pin a unique referent, ask ONE clarifying question and call NO tool until the user answers.
- When the user's request is genuinely ambiguous (multiple equally plausible target entities, conflicting constraints, or a verb that maps to several tools), ask exactly ONE clarifying question and call NO tool until the user answers. Do not guess.

Safety and grounding:
- Never read or expose secret-bearing files or credentials.
- Do not use shell commands to mutate source, deploy, run delivery builds/tests, or perform planner/executor work. Delegate work through cards, notes, or runtime controls.
- If a tool returns success=false, explain the failure and suggest the next step. Keep replies grounded in fetched data.

Vocabularies (canonical values; do not invent new ones):
- Card status: drafting | backlog | active | running | blocked | changed | done | failed | cancelled.
- Card type: project | goal | architecture | code | test | doc | data | research | ops.
- Urgency: low | normal | high | critical.
- Note kind: comment | progress | directive | escalation.
- AnalystIssue severity: info | warning | blocker.`;

export function getAnalystToolDefinitions(): ToolDefinition[] { return ANALYST_TOOL_DEFINITIONS; }
export function getAnalystSystemPrompt(): string { return ANALYST_SYSTEM_PROMPT; }

export class LlmIntentResolver {
  private readonly registry: ProviderRegistry;
  private readonly router: ModelRouter;
  private readonly runtimeConfig: RuntimeSection;
  private readonly clientCache = new Map<string, LlmClient>();
  private readonly recorderCache = new Map<string, LlmExchangeRecorder>();
  private recorderLogger?: LlmExchangeRecorderLogger;

  constructor(private readonly projectRoot: string) {
    const { config } = loadConfig(projectRoot);
    this.registry = new ProviderRegistry(config);
    this.router = new ModelRouter(config, this.registry);
    this.runtimeConfig = getRuntimeConfig(config);
  }

  setEventLogger(eventLogger?: unknown): void {
    this.recorderLogger = eventLogger ? toRecorderLogger(eventLogger) : undefined;
  }

  async isAvailable(): Promise<boolean> {
    const chain = await this.router.resolve('analyst', this.capabilityRequest());
    return chain.length > 0;
  }

  async chat(messages: AgentMessage[], projectContext: string): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const tools = getAnalystToolDefinitions();
    const chain = await this.router.resolve('analyst', this.capabilityRequest());
    if (chain.length === 0) throw new AnalystOfflineError(ANALYST_OFFLINE_REPLY);

    const { config } = this.router.getConfig ? { config: this.router.getConfig() } : loadConfig(this.projectRoot);
    const modelParams = getModelParamsForRole(config, 'analyst');
    const systemPrompt = `${getAnalystSystemPrompt()}\n\n${projectContext}`;
    const sessionId = messages.find((message) => message.session_id)?.session_id ?? 'analyst';
    let lastTransportError: Error | null = null;
    let authFailures = 0;

    for (const candidate of chain) {
      try {
        const { baseUrl, apiKey, cacheKey } = await resolveLlmTransportConfig(this.projectRoot, this.registry, candidate);
        let client = this.clientCache.get(cacheKey);
        if (!client) {
          client = new LlmClient(baseUrl, apiKey, this.registry);
          this.clientCache.set(cacheKey, client);
        }
        const result = await client.complete(candidate, systemPrompt, messages, sessionId, {
          tools,
          tool_choice: 'auto',
          stream: false,
          temperature: modelParams.temperature,
          max_tokens: modelParams.maxTokens,
          recorder: this.recorderForSession(sessionId),
        });
        this.registry.markSucceeded(candidate);
        return { content: result.content ?? '', toolCalls: result.toolCalls };
      } catch (err) {
        if (err instanceof LlmAuthError) {
          authFailures += 1;
          this.registry.markFailed(candidate, this.runtimeConfig.recoveryDelayMs ?? 60000);
          continue;
        }
        if (
          err instanceof LlmRateLimitError ||
          err instanceof LlmServerError ||
          err instanceof LlmTimeoutError ||
          err instanceof LlmParseError
        ) {
          lastTransportError = err;
          continue;
        }
        throw err;
      }
    }

    if (authFailures === chain.length) throw new AnalystOfflineError(ANALYST_OFFLINE_REPLY);
    if (lastTransportError) throw lastTransportError;
    throw new AnalystOfflineError(ANALYST_OFFLINE_REPLY);
  }

  private capabilityRequest(): ReturnType<typeof capabilityRequestForLlmOptions> {
    return capabilityRequestForLlmOptions({ tools: getAnalystToolDefinitions(), tool_choice: 'auto', stream: false });
  }

  private recorderForSession(sessionId: string): LlmExchangeRecorder {
    let recorder = this.recorderCache.get(sessionId);
    if (!recorder) {
      recorder = createLlmExchangeRecorder({
        saivageDir: join(this.projectRoot, '.saivage'),
        sessionId,
        eventLogger: this.recorderLogger,
      });
      this.recorderCache.set(sessionId, recorder);
    }
    return recorder;
  }
}

export const ANALYST_TOOL_REGISTRY = TOOL_REGISTRY;
