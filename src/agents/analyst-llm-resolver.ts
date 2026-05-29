import { join } from 'node:path';
import type { AgentMessage } from '../schemas/index.js';
import type { ToolDefinition, ToolCall, LlmInvocationClient } from './llm-contracts.js';
import { unwrapFailure } from './llm-errors.js';
import { LlmProviderGateway } from './llm-provider-gateway.js';
import { ANALYST_TOOL_DEFINITIONS } from './analyst-tool-schemas.js';
import { RoleToolPolicy } from './role-tool-policy.js';
import { ANALYST_UNSUPPORTED_ACTION_TEMPLATE } from './analyst-tool-runner.js';
import { loadConfig, getModelParamsForRole, getRuntimeConfig } from './config-schema.js';
import type { RuntimeSection, SaivageConfig } from './config-schema.js';
import { ModelRouter } from './model-router.js';
import { ProviderRegistry } from './provider.js';
import { type CandidateAvailability, MemoryCandidateAvailability } from './candidate-availability.js';
import { capabilityRequestForLlmOptions } from './provider-capabilities.js';
import { resolveLlmTransportConfig } from './llm-transport.js';
import { createLlmExchangeRecorder, toRecorderLogger } from './llm-exchange-recorder.js';
import type { LlmExchangeRecorder, LlmExchangeRecorderLogger } from './llm-exchange-recorder.js';
import {
  mark_goal_needs_corrections,
  create_card, edit_card, move_card, delete_card, list_cards, get_card, get_tree, get_plan_diary, get_card_output, get_status,
  list_card_history, get_card_history_entry, diff_card,
  start_project, stop_project, terminate_process, pause_runtime, resume_runtime, abort_goal_subtree, restart_card_or_subtree, restart_goal,
  read_file, list_directory, run_shell_command, read_runtime_events, read_runtime_errors, read_control_actions,
  list_processes_tool, list_agent_sessions, read_agent_session, queue_notification, reorder_child, navigate_workspace, navigate_back, show_config, restart_server, reconfigure,
} from './analyst-tools.js';
import type { ToolResult, ToolContext } from './analyst-tools.js';

export const ANALYST_NO_MODEL_REPLY = "Analyst LLM unavailable: no model candidate is configured for role 'analyst'. Configure a provider/model for role 'analyst' in the project configuration and try again.";

export class AnalystOfflineError extends Error {
  constructor(message: string = ANALYST_NO_MODEL_REPLY) {
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
  list_cards: list_cards as unknown as ToolFn,
  get_card: get_card as unknown as ToolFn,
  get_tree: get_tree as unknown as ToolFn,
  get_plan_diary: get_plan_diary as unknown as ToolFn,
  get_card_output: get_card_output as unknown as ToolFn,
  get_status: get_status as unknown as ToolFn,
  list_card_history: list_card_history as unknown as ToolFn,
  get_card_history_entry: get_card_history_entry as unknown as ToolFn,
  diff_card: diff_card as unknown as ToolFn,
  start_project: start_project as unknown as ToolFn,
  stop_project: stop_project as unknown as ToolFn,
  terminate_process: terminate_process as unknown as ToolFn,
  pause_runtime: pause_runtime as unknown as ToolFn,
  resume_runtime: resume_runtime as unknown as ToolFn,
  abort_goal_subtree: abort_goal_subtree as unknown as ToolFn,
  restart_card_or_subtree: restart_card_or_subtree as unknown as ToolFn,
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
  queue_notification: queue_notification as unknown as ToolFn,
  reorder_child: reorder_child as unknown as ToolFn,
  navigate_workspace: navigate_workspace as unknown as ToolFn,
  navigate_back: navigate_back as unknown as ToolFn,
  show_config: show_config as unknown as ToolFn,
  restart_server: restart_server as unknown as ToolFn,
  reconfigure: reconfigure as unknown as ToolFn,
};

function formatToolList(tools: ToolDefinition[]): string {
  return tools.map((tool) => `- ${tool.function.name}: ${tool.function.description}`).join('\n');
}

const ANALYST_SYSTEM_PROMPT = `You are the Saivage Analyst — the user's conversational control surface for the autonomous runtime. You inspect, navigate, mutate cards, queue notifications, control runtime execution, reconfigure non-secret settings, and investigate/repair by calling registered tools. You do not perform delivery work yourself.

Capability classes and registered tools:
- Inspect: get_card, get_tree, get_plan_diary, get_card_output, get_status, list_card_history, get_card_history_entry, diff_card, read_file, list_directory, run_shell_command, read_runtime_events, read_runtime_errors, read_control_actions, list_processes_tool, list_agent_sessions, read_agent_session.
- Navigate the workspace area: navigate_workspace, navigate_back.
- Mutate cards: create_card, edit_card, move_card, delete_card, reorder_child, mark_goal_needs_corrections.
- Queue notifications: queue_notification.
- Control the runtime: start_project, stop_project, pause_runtime, resume_runtime, abort_goal_subtree, restart_card_or_subtree, restart_goal, terminate_process, restart_server.
- Reconfigure: show_config, reconfigure.
- Investigate and repair: use Inspect tools to diagnose, then use card, notification, runtime-control, or reconfigure tools to apply the user's chosen fix.

<TOOL_LIST>
${formatToolList(ANALYST_TOOL_DEFINITIONS)}
</TOOL_LIST>

Response shapes:
- C1 unsupported or invalid action: That action is not supported by the Analyst on this surface. Closest available capability: <CAPABILITY-CLASS-NAME>. Available tools in that class: <COMMA-SEPARATED-TOOL-NAMES>.
- C2 partial success: Partial success: <SUCCEEDED> of <TOTAL> succeeded. Failed: <COMMA-SEPARATED-IDS>. Reasons: <SEMICOLON-SEPARATED-REASONS>.
- C3 unknown internal capability: The Analyst cannot perform <PROPOSED-TOOL-NAME>; it is not a registered capability. Available capability classes: Inspect, Navigate, Mutate cards, Queue notifications, Control the runtime, Reconfigure, Investigate and repair.

Conversational behaviour:
- Resolve deictic references ("this", "the current one", "that card", "do it") against the immediate conversation and workspace context. If no unique referent exists, ask one clarifying question and call no tool.
- Resolve deictic phrases such as "this", "here", "this card", "the current", "the one I'm looking at", and equivalent wording against the per-turn [workspace-context] header. When that header reports "none — no entity is currently in focus", ask exactly one clarifying question instead of guessing.
- For ambiguous requests, ask exactly one clarifying question and call no tool until the user answers.

Safety:
- Never read or expose secret-bearing files or credentials. Secret-bearing paths are off-limits under assertAnalystInspectionTarget semantics.
- Do not use shell commands to mutate source, deploy, run delivery builds/tests, or perform planner/executor work.
- If a tool returns success=false, explain the failure and suggest a grounded next step.

Vocabularies: Card status: drafting | backlog | active | running | blocked | changed | done | failed | cancelled | needs_verification. Card type: project | goal | architecture | code | test | doc | data | research | ops. Urgency: low | normal | high | critical. AnalystIssue severity: info | warning | blocker.`;

export function getAnalystToolDefinitions(): ToolDefinition[] { return ANALYST_TOOL_DEFINITIONS; }
export function getAnalystSystemPrompt(): string { return ANALYST_SYSTEM_PROMPT; }

export class LlmIntentResolver {
  private readonly config: SaivageConfig;
  private readonly registry: ProviderRegistry;
  private readonly router: ModelRouter;
  private readonly runtimeConfig: RuntimeSection;
  private readonly clientCache = new Map<string, LlmInvocationClient>();
  private readonly recorderCache = new Map<string, LlmExchangeRecorder>();
  private recorderLogger?: LlmExchangeRecorderLogger;

  constructor(private readonly projectRoot: string, private readonly availability: CandidateAvailability = new MemoryCandidateAvailability()) {
    const { config } = loadConfig(projectRoot);
    this.config = config;
    this.registry = new ProviderRegistry(config);
    this.router = new ModelRouter(config, this.registry, projectRoot, this.availability);
    this.runtimeConfig = getRuntimeConfig(config);
  }

  setEventLogger(eventLogger?: unknown): void {
    this.recorderLogger = eventLogger ? toRecorderLogger(eventLogger) : undefined;
  }

  async chat(messages: AgentMessage[], projectContext: string): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const tools = getAnalystToolDefinitions();
    const chain = await this.router.resolve('analyst', this.capabilityRequest());
    if (chain.length === 0) throw new AnalystOfflineError(ANALYST_NO_MODEL_REPLY);

    const modelParams = getModelParamsForRole(this.config, 'analyst');
    const systemPrompt = `${getAnalystSystemPrompt()}\n\n${projectContext}`;
    const sessionId = messages.find((message) => message.session_id)?.session_id ?? 'analyst';
    let lastTransportError: Error | null = null;

    for (const candidate of chain) {
      try {
        const { baseUrl, apiKey, cacheKey } = await resolveLlmTransportConfig(this.projectRoot, this.registry, candidate);
        let client = this.clientCache.get(cacheKey);
        if (!client) {
          client = new LlmProviderGateway({ baseUrl, apiKey, registry: this.registry });
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
        for (const toolCall of result.toolCalls ?? []) {
          const decision = RoleToolPolicy.assertAnalystSurfaceTool(toolCall.function.name, 'web');
          if (!decision.allowed) {
            await this.availability.markSucceeded(candidate);
            return { content: ANALYST_UNSUPPORTED_ACTION_TEMPLATE('Analyst', Object.keys(TOOL_REGISTRY)), toolCalls: [] };
          }
        }
        await this.availability.markSucceeded(candidate);
        return { content: result.content ?? '', toolCalls: result.toolCalls };
      } catch (err) {
        const failure = unwrapFailure(err);
        if (failure.kind === 'auth_permanent') {
          await this.availability.markFailed(candidate, { state: 'BLOCKED_UNTIL', untilMs: Date.now() + 3_600_000, reason: 'auth_permanent' });
          lastTransportError = err instanceof Error ? err : new Error(String(err));
          continue;
        }
        if (
          failure.kind === 'rate_limit' ||
          failure.kind === 'server_transient' ||
          failure.kind === 'timeout' ||
          failure.kind === 'parse_error'
        ) {
          if (failure.kind !== 'parse_error') {
            const now = Date.now();
            let untilMs = now + Math.max(this.runtimeConfig.recoveryDelayMs ?? 60_000, 5_000);
            if (failure.kind === 'rate_limit') {
              if (typeof failure.retryAfterMs === 'number' && failure.retryAfterMs > 0) untilMs = now + failure.retryAfterMs;
              else if (typeof failure.resetsAt === 'string') {
                const parsed = Date.parse(failure.resetsAt);
                if (Number.isFinite(parsed) && parsed > now) untilMs = parsed;
              }
            }
            await this.availability.markFailed(candidate, { state: failure.kind === 'rate_limit' ? 'BLOCKED_UNTIL' : 'COOLING', untilMs, reason: failure.kind });
          }
          lastTransportError = err instanceof Error ? err : new Error(String(err));
          continue;
        }
        throw err;
      }
    }

    if (lastTransportError) throw lastTransportError;
    throw new AnalystOfflineError(ANALYST_NO_MODEL_REPLY);
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
