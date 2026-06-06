import { join } from 'node:path';
import type { AgentMessage } from '../schemas/index.js';
import type { ToolDefinition, LlmInvocationClient, LlmCompleteResult } from './llm-contracts.js';
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
import { buildLlmOptions } from './llm-options-factory.js';
import { defaultInvocationRecoveryPolicy } from './invocation-recovery-policy.js';
import {
  ANALYST_ISSUE_SEVERITY_VALUES,
  CARD_STATUS_VALUES,
  CARD_TYPE_VALUES,
  TOOL_DEFINITIONS,
  URGENCY_VALUES,
  type UnifiedToolDefinition,
} from '../tools/definitions/index.js';
import type { ToolResult, ToolContext } from './analyst-tools.js';

export const ANALYST_NO_MODEL_REPLY = "Analyst LLM unavailable: no model candidate is configured for role 'analyst'. Configure a provider/model for role 'analyst' in the project configuration and try again.";

export class AnalystOfflineError extends Error {
  constructor(message: string = ANALYST_NO_MODEL_REPLY) {
    super(message);
    this.name = 'AnalystOfflineError';
  }
}

type ToolFn = (ctx: ToolContext, params: Record<string, unknown>) => Promise<ToolResult>;
type CanonicalToolExecutor = NonNullable<UnifiedToolDefinition['executor']>;

function adaptAnalystToolExecutor(executor: CanonicalToolExecutor): ToolFn {
  return (ctx, params) => executor(ctx, params);
}

export const TOOL_REGISTRY: Record<string, ToolFn> = Object.fromEntries(
  TOOL_DEFINITIONS
    .flatMap((tool) => tool.roles.includes('analyst') && !tool.workspace && tool.executor
      ? [[tool.name, adaptAnalystToolExecutor(tool.executor)] as const]
      : []),
);

function formatToolList(tools: ToolDefinition[]): string {
  return tools.map((tool) => `- ${tool.function.name}: ${tool.function.description}`).join('\n');
}

function formatVocabularySnippet(): string {
  return [
    `Card status: ${CARD_STATUS_VALUES.join(' | ')}`,
    `Card type: ${CARD_TYPE_VALUES.join(' | ')}`,
    `Urgency: ${URGENCY_VALUES.join(' | ')}`,
    `AnalystIssue severity: ${ANALYST_ISSUE_SEVERITY_VALUES.join(' | ')}`,
  ].join('. ');
}

const ANALYST_SYSTEM_PROMPT = `You are the Saivage Analyst — the user's conversational control surface for the autonomous runtime. You inspect, navigate, mutate cards, queue notifications, control runtime execution, reconfigure non-secret settings, and investigate/repair by calling registered tools. You do not perform delivery work yourself.

Capability classes and registered tools:
- Inspect: get_card, get_tree, get_plan_diary, get_card_output, get_status, list_card_history, get_card_history_entry, diff_card, read_file, list_directory, run_shell_command, read_runtime_events, read_runtime_errors, read_control_actions, list_processes_tool, list_agent_sessions, read_agent_session.
- Navigate the workspace area: navigate_workspace, navigate_back.
- Mutate cards: create_card, edit_card, delete_card, reorder_child, mark_goal_needs_corrections.
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

Vocabularies: ${formatVocabularySnippet()}.`;

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

  async chat(messages: AgentMessage[], projectContext: string): Promise<LlmCompleteResult> {
    const tools = getAnalystToolDefinitions();
    const capabilityRequest = this.capabilityRequest();
    const chain = await this.router.resolve('analyst', capabilityRequest);
    if (chain.length === 0) {
      const decision = defaultInvocationRecoveryPolicy.decideNoCandidates({
        role: 'analyst',
        attempt: 1,
        maxAttempts: 1,
        recoveryDelayMs: this.runtimeConfig.recoveryDelayMs ?? 60000,
        maxRecoveryRetries: this.runtimeConfig.maxRecoveryRetries ?? 3,
        capabilityRequest,
        capabilitySkips: this.router.getLastCapabilitySkips(),
      });
      throw new AnalystOfflineError(decision.message === `No healthy candidates available for role 'analyst'.` ? ANALYST_NO_MODEL_REPLY : decision.message);
    }

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
        const result = await client.complete(candidate, systemPrompt, messages, sessionId, buildLlmOptions(
          'analyst',
          tools,
          [],
          { temperature: modelParams.temperature, max_tokens: modelParams.maxTokens },
          undefined,
          this.recorderForSession(sessionId),
        ));
        if (result.kind === 'message') {
          await this.availability.markSucceeded(candidate);
          return result;
        }
        for (const toolCall of result.tool_calls) {
          const decision = RoleToolPolicy.assertAnalystSurfaceTool(toolCall.function.name, 'web');
          if (!decision.allowed) {
            await this.availability.markSucceeded(candidate);
            return { kind: 'message', content: ANALYST_UNSUPPORTED_ACTION_TEMPLATE('Analyst', Object.keys(TOOL_REGISTRY)) };
          }
        }
        await this.availability.markSucceeded(candidate);
        return result;
      } catch (err) {
        const decision = defaultInvocationRecoveryPolicy.decideFailure(err, {
          role: 'analyst',
          candidate,
          attempt: 1,
          maxAttempts: chain.length,
          recoveryDelayMs: this.runtimeConfig.recoveryDelayMs ?? 60000,
          maxRecoveryRetries: this.runtimeConfig.maxRecoveryRetries ?? 3,
          capabilityRequest,
          capabilitySkips: this.router.getLastCapabilitySkips(),
          sessionId,
        });
        const failureKind = decision.failure?.kind ?? 'unknown';
        if (failureKind === 'auth_permanent') {
          if (decision.markFailed && decision.availability) await this.availability.markFailed(candidate, decision.availability);
          lastTransportError = err instanceof Error ? err : new Error(String(err));
          continue;
        }
        if (
          failureKind === 'rate_limit' ||
          failureKind === 'server_transient' ||
          failureKind === 'timeout' ||
          failureKind === 'parse_error'
        ) {
          if (decision.markFailed && decision.availability) await this.availability.markFailed(candidate, decision.availability);
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
    return capabilityRequestForLlmOptions({ tools: getAnalystToolDefinitions(), stream: false });
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
