import { EventEmitter } from 'node:events';
import type { SaivageConfig, RuntimeSection } from './config-schema.js';
import { getModelParamsForRole } from './config-schema.js';
import type { CandidateAvailability } from './candidate-availability.js';
import type { ModelRouter } from './model-router.js';
import type {
  AgentMessage,
  LlmAttemptOutcome,
  LlmFailureClass,
  OperationalAgentRole,
  RuntimeActivationRecord,
} from '../schemas/index.js';
import type { PlannerActivationBarrier } from '../contracts/index.js';
import type { Contract } from '../contracts/contract.js';
import { serializeToolCallMessage } from '../contracts/persisted-tool-call.js';
import { LlmRequestError } from '../contracts/llm-failure.js';
import { capabilityRequestForLlmOptions } from './provider-capabilities.js';
import {
  defaultInvocationRecoveryPolicy,
  type InvocationRecoveryContext,
} from './invocation-recovery-policy.js';
import type { EventLogger } from '../observability/index.js';
import { createContractVerifier } from './contract-verifier.js';
import { createAgentLoopDriver, type AgentLoopDriverIO } from './agent-loop-driver.js';
import { appendMessage as appendPersistentMessage, appendSystemPromptMessageIfMissing, assertNoActiveAgentSession } from './session-persistence.js';
import { updateSessionModel } from './session-persistence.js';
import { AttemptRecorder } from './attempt-recorder.js';
import { PlannerEnvelopeTracker } from './planner-envelope-tracker.js';
import { SessionMessageLog } from './session-message-log.js';
import { AgentSessionLifecycle } from './session-lifecycle.js';
import { InvocationModelContext } from './invocation-model-context.js';
import { AgentToolExecutor } from './agent-tool-executor.js';
import { InvocationService } from './invocation-service.js';
import { buildAgentProtocolViolation, parseProtocolToolArgs } from './agent-protocol-violation.js';
import { SessionInvariantError } from './session-invariant-error.js';

type AgentRole = OperationalAgentRole;

interface AgentRecoveryContext {
  attempt: number;
  maxAttempts: number;
  isRecovery: boolean;
  previousError?: Error;
  directive: string;
}

interface AgentInvocationAttempt<R> {
  attempt: number;
  success: boolean;
  result?: R;
  error?: Error;
}

export interface AgentInvocationRunnerConfig {
  projectRoot: string;
  saivageDir: string;
  config: SaivageConfig;
  runtimeConfig: RuntimeSection;
  router: ModelRouter;
  candidateAvailability: CandidateAvailability;
  sessionLifecycle: AgentSessionLifecycle;
  messageLog: SessionMessageLog;
  modelContext: InvocationModelContext;
  toolExecutor: AgentToolExecutor;
  invocationService: InvocationService;
  eventBusProvider: () => EventEmitter | undefined;
  eventLogger?: EventLogger;
  redactModelIssueText: (message: unknown) => string;
  redactProviderErrorMessage: (message: unknown) => string;
  compensateActivationBarrierThrow: (
    sessionId: string,
    toolCallId: string,
    activation: RuntimeActivationRecord,
    error: unknown,
  ) => void;
}

function delayInvocationRecovery(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function buildRecoveryDirective(previousErrorMessage: string | undefined): string {
  return `RECOVERY DIRECTIVE: Your previous invocation failed. Inspect authoritative cards, notes, plan diary, runtime state, and files with tools as needed before proceeding. Previous error: ${previousErrorMessage ?? 'Unknown error'}`;
}

export class AgentInvocationRunner {
  constructor(private readonly config: AgentInvocationRunnerConfig) {}

  async invoke<E, R>(
    role: AgentRole,
    goalId: string,
    cardId: string,
    systemPrompt: string,
    contextMessages: AgentMessage[],
    contract: Contract<E, R>,
    requestedSessionId?: string,
    activationBarrier?: PlannerActivationBarrier,
    assessmentId?: string | null,
  ): Promise<R> {
    const modelParams = getModelParamsForRole(this.config.config, role);
    const tools = this.config.toolExecutor.buildToolsForRole(role);
    const capabilityRequest = capabilityRequestForLlmOptions({
      tools,
      stream: false,
    });
    const candidates = await this.config.invocationService.resolveCandidates(role, capabilityRequest);
    if (candidates.length === 0) {
      const noCandidateDecision = defaultInvocationRecoveryPolicy.decideNoCandidates({
        role,
        attempt: 1,
        maxAttempts: Number.POSITIVE_INFINITY,
        recoveryDelayMs: this.config.runtimeConfig.recoveryDelayMs ?? 60000,
        maxRecoveryRetries: Number.POSITIVE_INFINITY,
        capabilityRequest,
        capabilitySkips: this.config.router.getLastCapabilitySkips(),
        goalId,
        cardId,
      });
      throw new Error(noCandidateDecision.message);
    }
    assertNoActiveAgentSession(this.config.saivageDir, role as import('../schemas/types.js').AgentRole);
    const session = this.config.sessionLifecycle.create(role as import('../schemas/types.js').AgentRole, goalId, cardId, requestedSessionId, assessmentId);
    await this.config.sessionLifecycle.notifyCreated(session.id);
    this.config.sessionLifecycle.publishStarted(session.id, role as import('../schemas/types.js').AgentRole, goalId, cardId);
    appendSystemPromptMessageIfMissing(this.config.saivageDir, session.id, systemPrompt);
    for (const msg of contextMessages)
      appendPersistentMessage(
        this.config.saivageDir,
        session.id,
        {
          role: msg.role,
          kind: msg.kind,
          content: msg.content,
          tool: msg.tool,
          links: msg.links,
          model_spec: msg.model_spec,
          requested_model_spec: msg.requested_model_spec,
        },
        { round_id: msg.round_id, message_index: msg.message_index, block_index: msg.block_index },
      );
    const recoveryDelayMs = this.config.runtimeConfig.recoveryDelayMs ?? 60000;
    const maxOuterAttempts = Number.POSITIVE_INFINITY;
    const invocationStart = Date.now();
    const attemptRecorder = new AttemptRecorder(this.config.eventBusProvider(), this.config.eventLogger);
    const plannerEnvelopeTracker = new PlannerEnvelopeTracker();
    const agentFn = async (recoveryCtx: AgentRecoveryContext) => {
      const candidateChain = await this.config.invocationService.resolveCandidates(role, capabilityRequest);
      const capabilitySkips = this.config.router.getLastCapabilitySkips();
      if (candidateChain.length === 0) {
        const noCandidateDecision = defaultInvocationRecoveryPolicy.decideNoCandidates({
          role,
          attempt: recoveryCtx.attempt,
          maxAttempts: recoveryCtx.maxAttempts,
          recoveryDelayMs: this.config.runtimeConfig.recoveryDelayMs ?? 60000,
          maxRecoveryRetries: Number.POSITIVE_INFINITY,
          capabilityRequest,
          capabilitySkips,
          sessionId: session.id,
          goalId,
          cardId,
        });
        throw new Error(noCandidateDecision.message);
      }
      let lastError: Error | null = null;
      try {
        for (const candidate of candidateChain) {
          let sameCandidateRecoveryAttempt = 1;
          for (;;) {
            if (this.config.sessionLifecycle.isCancelled(session.id))
              throw new Error(
                `Agent invocation cancelled for session ${session.id}. Role: ${role}, goal: ${goalId}, card: ${cardId}`,
              );
            if (!this.config.candidateAvailability.isAvailable(candidate)) break;
            let callStart = 0;
            let startedAtIso = '';
            try {
              updateSessionModel(this.config.saivageDir, session.id, candidate.model);
              const recoveryDirective = recoveryCtx.isRecovery
                ? recoveryCtx.directive
                : sameCandidateRecoveryAttempt > 1
                  ? buildRecoveryDirective(lastError ? this.config.redactProviderErrorMessage(lastError.message) : undefined)
                  : '';
              if (recoveryDirective)
                this.config.messageLog.append(session.id, {
                  role: 'system',
                  kind: 'model_recovered',
                  content: recoveryDirective,
                });
              const abortController = new AbortController();
              this.config.sessionLifecycle.trackAbortController(session.id, abortController);
              callStart = Date.now();
              startedAtIso = new Date(callStart).toISOString();
              try {
                const turnTools = [...tools, ...contract.terminals.map((t) => t.toolDefinition)];
                const verifier = createContractVerifier();
                const io: AgentLoopDriverIO<E, R> = {
                  contract,
                  verifier,
                  sessionId: session.id,
                  role,
                  attempt: recoveryCtx.attempt,
                  invokeTurn: async () => {
                    const turnMessages = this.config.modelContext.buildModelMessages(session.id, role, goalId);
                    return this.config.invocationService.invokeCall({
                      role,
                      sessionId: session.id,
                      systemPrompt,
                      contextMessages: turnMessages,
                      tools: turnTools,
                      terminalToolNames: contract.terminals.map((t) => t.name),
                      modelParams: { temperature: modelParams.temperature, maxTokens: modelParams.maxTokens },
                      capabilityRequest,
                      abortSignal: abortController.signal,
                    }, candidate);
                  },
                  persistAssistantToolCalls: (result) => {
                    if (result.kind !== 'tool_calls') return;
                    for (const tc of result.tool_calls) {
                      const parsed = parseProtocolToolArgs(tc.function.arguments);
                      if (parsed.kind === 'violation') {
                        const violation = buildAgentProtocolViolation({
                          session_id: session.id,
                          role,
                          provider: candidate.provider,
                          model: candidate.model,
                          tool_call_id: tc.id,
                          tool_name: tc.function.name,
                          violation: parsed.violation,
                          raw: tc.function.arguments,
                        });
                        this.config.messageLog.append(session.id, {
                          role: 'assistant',
                          kind: 'tool_call',
                          content: JSON.stringify(
                            serializeToolCallMessage({
                              id: tc.id,
                              name: tc.function.name,
                              args: { protocol_violation: violation },
                            }),
                          ),
                          tool: tc.function.name,
                          tool_call_id: tc.id,
                        });
                        continue;
                      }
                      this.config.messageLog.append(session.id, {
                        role: 'assistant',
                        kind: 'tool_call',
                        content: JSON.stringify(
                          serializeToolCallMessage({
                            id: tc.id,
                            name: tc.function.name,
                            args: parsed.args,
                          }),
                        ),
                        tool: tc.function.name,
                        tool_call_id: tc.id,
                      });
                    }
                  },
                  persistAssistantText: (content) => {
                    this.config.messageLog.append(session.id, {
                      role: 'assistant',
                      kind: 'text',
                      content,
                    });
                  },
                  executeActionToolCalls: async (result) => {
                    if (result.kind !== 'tool_calls') return;
                    for (const tc of result.tool_calls) {
                      if (contract.isTerminalToolName(tc.function.name)) continue;
                      const parsedArgs = parseProtocolToolArgs(tc.function.arguments);
                      if (parsedArgs.kind === 'violation') {
                        const violation = buildAgentProtocolViolation({
                          session_id: session.id,
                          role,
                          provider: candidate.provider,
                          model: candidate.model,
                          tool_call_id: tc.id,
                          tool_name: tc.function.name,
                          violation: parsedArgs.violation,
                          raw: tc.function.arguments,
                        });
                        this.config.messageLog.append(session.id, {
                          role: 'tool',
                          kind: 'tool_error',
                          content: JSON.stringify(violation),
                          tool: tc.function.name,
                          tool_call_id: tc.id,
                        });
                        continue;
                      }
                      const msg = await this.config.toolExecutor.processToolCall(tc, role, session.id, {
                        goalId,
                        cardId,
                      });
                      if (role === 'planner' && tc.function.name === 'activate_card' && msg.kind === 'tool_result' && activationBarrier) {
                        let activation: unknown;
                        try {
                          const body = JSON.parse(msg.content) as { activation?: unknown };
                          activation = body.activation;
                        } catch (err) {
                          throw new SessionInvariantError(`Malformed activate_card tool_result JSON for session ${session.id}, tool_call_id ${tc.id}: ${err instanceof Error ? err.message : String(err)}`);
                        }
                        if (!activation || typeof activation !== 'object' || !('activation_id' in activation)) {
                          throw new SessionInvariantError(`Malformed activate_card tool_result payload for session ${session.id}, tool_call_id ${tc.id}: missing activation.activation_id`);
                        }
                        try {
                          this.config.sessionLifecycle.markWaiting(session.id);
                          await activationBarrier.dispatch({ activation: activation as RuntimeActivationRecord });
                        } catch (err) {
                          this.config.compensateActivationBarrierThrow(session.id, tc.id, activation as RuntimeActivationRecord, err);
                          throw err;
                        }
                        continue;
                      }
                      this.config.messageLog.append(session.id, {
                        role: msg.role,
                        kind: msg.kind,
                        content: msg.content,
                        tool: msg.tool,
                        tool_call_id: msg.tool_call_id,
                      });
                      if (
                        role === 'planner' &&
                        msg.kind === 'tool_result' &&
                        (tc.function.name === 'report_goal_done' ||
                          tc.function.name === 'report_goal_failed' ||
                          tc.function.name === 'report_goal_blocked')
                      ) {
                        plannerEnvelopeTracker.trackTerminalToolResult(tc.function.name, goalId, msg.content);
                      }
                    }
                  },
                  persistDuplicateDoneIgnored: (toolCallId, toolName) => {
                    this.config.messageLog.append(session.id, {
                      role: 'tool',
                      kind: 'tool_result',
                      content: 'duplicate terminal call ignored',
                      tool: toolName,
                      tool_call_id: toolCallId,
                    });
                  },
                  persistVerifiedDone: (toolCallId, toolName) => {
                    this.config.messageLog.append(session.id, {
                      role: 'tool',
                      kind: 'tool_result',
                      content: 'verified',
                      tool: toolName,
                      tool_call_id: toolCallId,
                    });
                  },
                  persistViolatedDone: (toolCallId, toolName, content) => {
                    this.config.messageLog.append(session.id, {
                      role: 'tool',
                      kind: 'tool_result',
                      content,
                      tool: toolName,
                      tool_call_id: toolCallId,
                    });
                  },
                  appendRepairMessage: (message) => {
                    this.config.messageLog.append(session.id, {
                      role: 'system',
                      kind: 'model_repair',
                      content: message,
                    });
                  },
                  isCancelled: () => this.config.sessionLifecycle.isCancelled(session.id),
                  emitVerifierRejection: (event) => {
                    if (this.config.eventLogger)
                      this.config.eventLogger.appendEvent({
                        kind: 'llm_verifier_rejection',
                        session_id: event.session_id,
                        role: event.role as import('../schemas/types.js').AgentRole,
                        contract_id: event.contract_id,
                        attempt: event.attempt,
                        repair_round: event.repair_round,
                        obligation_codes: event.obligation_codes,
                        proposed_present: event.proposed_present,
                      });
                    const eventBus = this.config.eventBusProvider();
                    if (eventBus) eventBus.emit('llm_verifier_rejection', event);
                  },
                  takeRuntimeDoneEnvelope:
                    role === 'planner'
                      ? () => plannerEnvelopeTracker.takeEnvelope<E>()
                      : undefined,
                };
                const driver = createAgentLoopDriver<E, R>(io);
                const outcome = await driver.run();
                const callDuration = Date.now() - callStart;
                if (outcome.kind === 'succeeded') {
                  attemptRecorder.recordContractVerdict('satisfied', outcome.repairAttempts);
                  const finalResponse = JSON.stringify(outcome.envelope);
                  this.config.messageLog.append(session.id, {
                    role: 'assistant',
                    kind: 'text',
                    content: finalResponse,
                  });
                  const successDecision = defaultInvocationRecoveryPolicy.decideSuccess({
                    role,
                    candidate,
                    attempt: recoveryCtx.attempt,
                    maxAttempts: recoveryCtx.maxAttempts,
                    recoveryDelayMs: this.config.runtimeConfig.recoveryDelayMs ?? 60000,
                    maxRecoveryRetries: Number.POSITIVE_INFINITY,
                    capabilityRequest,
                    capabilitySkips,
                    sessionId: session.id,
                    goalId,
                    cardId,
                  });
                  if (successDecision.markSucceeded)
                    await this.config.candidateAvailability.markSucceeded(candidate);
                  const succeededOutcome: LlmAttemptOutcome = {
                    kind: 'succeeded',
                    terminal_tool: outcome.terminalName as LlmAttemptOutcome extends {
                      kind: 'succeeded';
                      terminal_tool: infer X;
                    }
                      ? X
                      : never,
                  };
                  const succeededCapSkips = this.config.router.getLastCapabilitySkips();
                  attemptRecorder.recordOutcome({
                    session_id: session.id,
                    role: role as unknown as import('../schemas/types.js').AgentRole,
                    attempt: recoveryCtx.attempt,
                    same_candidate_attempt: sameCandidateRecoveryAttempt,
                    provider: candidate.provider,
                    model: candidate.model,
                    account: candidate.account ?? '_',
                    started_at: startedAtIso,
                    duration_ms: callDuration,
                    outcome: succeededOutcome,
                    capability_skip_reasons:
                      succeededCapSkips && succeededCapSkips.length > 0
                        ? succeededCapSkips.map((d) => ({
                            provider: d.candidate.provider,
                            model: d.candidate.model,
                            reasons: d.reasons.slice(),
                          }))
                        : undefined,
                  });
                  this.config.sessionLifecycle.clearCancellation(session.id);
                  return outcome.result;
                }
                if (outcome.kind === 'cancelled') {
                  throw new Error(
                    `Agent invocation cancelled for session ${session.id}. Role: ${role}, goal: ${goalId}, card: ${cardId}`,
                  );
                }
                throw new LlmRequestError({
                  kind: 'provider_protocol_error',
                  provider: candidate.provider,
                  status: 0,
                  message: `Role '${role}' transport failure: ${outcome.failure.kind}.`,
                });
              } finally {
                this.config.sessionLifecycle.clearAbortController(session.id);
              }
            } catch (err) {
              lastError = err instanceof Error ? err : new Error(String(err));
              const failureDurationMs = Date.now() - callStart;
              const policyContext: InvocationRecoveryContext = {
                role,
                candidate,
                attempt: sameCandidateRecoveryAttempt,
                maxAttempts: recoveryCtx.maxAttempts,
                recoveryDelayMs: this.config.runtimeConfig.recoveryDelayMs ?? 60000,
                maxRecoveryRetries: Number.POSITIVE_INFINITY,
                capabilityRequest,
                capabilitySkips,
                sessionId: session.id,
                goalId,
                cardId,
              };
              const decision = defaultInvocationRecoveryPolicy.decideFailure(lastError, policyContext);
              if (decision.markFailed && decision.availability)
                await this.config.candidateAvailability.markFailed(candidate, decision.availability);
              if (decision.appendModelIssue)
                this.config.messageLog.append(session.id, {
                  role: 'system',
                  kind: 'model_issue',
                  content: this.config.redactModelIssueText(decision.message),
                });
              const failedOutcome: LlmAttemptOutcome = {
                kind: 'failed',
                failure_class: (decision.failure?.kind ?? 'unknown') as LlmFailureClass,
                recovery_action: decision.action,
                error_name: lastError.name,
                error_message: this.config.redactModelIssueText(decision.message),
                error_preview: this.config.redactProviderErrorMessage(lastError.message.slice(0, 240)),
                cooldown_ms: decision.availability
                  ? Math.max(0, decision.availability.untilMs - Date.now())
                  : undefined,
                retry_delay_ms: decision.retryDelayMs,
              };
              const failedCapSkips = this.config.router.getLastCapabilitySkips();
              attemptRecorder.recordOutcome({
                session_id: session.id,
                role: role as unknown as import('../schemas/types.js').AgentRole,
                attempt: recoveryCtx.attempt,
                same_candidate_attempt: sameCandidateRecoveryAttempt,
                provider: candidate.provider,
                model: candidate.model,
                account: candidate.account ?? '_',
                started_at: startedAtIso,
                duration_ms: failureDurationMs,
                outcome: failedOutcome,
                capability_skip_reasons:
                  failedCapSkips && failedCapSkips.length > 0
                    ? failedCapSkips.map((d) => ({
                        provider: d.candidate.provider,
                        model: d.candidate.model,
                        reasons: d.reasons.slice(),
                      }))
                    : undefined,
              });
              if (decision.abort || this.config.sessionLifecycle.isCancelled(session.id)) {
                this.config.sessionLifecycle.publishCancelledRetryStop(
                  session.id,
                  role as unknown as import('../schemas/types.js').AgentRole,
                );
                if (decision.failure?.kind === 'cancelled' || this.config.sessionLifecycle.isCancelled(session.id))
                  throw new Error(
                    `Agent invocation cancelled for session ${session.id}. Role: ${role}, goal: ${goalId}, card: ${cardId}`,
                  );
                throw lastError;
              }
              if (decision.action === 'retry_same_after_delay') {
                await delayInvocationRecovery(decision.retryDelayMs ?? 0);
                sameCandidateRecoveryAttempt += 1;
                continue;
              }
              break;
            }
          }
        }
        throw lastError ?? new Error(`All candidates exhausted for role '${role}'.`);
      } finally {
        this.config.sessionLifecycle.clearCancellation(session.id);
      }
    };
    const attempts: AgentInvocationAttempt<R>[] = [];
    for (let attempt = 1; ; attempt += 1) {
      const previousError = attempts[attempt - 2]?.error;
      const recoveryCtx: AgentRecoveryContext = {
        attempt,
        maxAttempts: maxOuterAttempts,
        isRecovery: attempt > 1,
        previousError,
        directive: attempt > 1 ? buildRecoveryDirective(previousError ? this.config.redactProviderErrorMessage(previousError.message) : undefined) : '',
      };
      try {
        const result = await agentFn(recoveryCtx);
        attempts.push({ attempt, success: true, result });
        const eventBus = this.config.eventBusProvider();
        if (eventBus)
          eventBus.emit('agent_recovered', {
            role,
            attempt,
            sessionId: session.id,
            cardId,
            goalId,
          });
        break;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        attempts.push({ attempt, success: false, error });
        try {
          this.config.messageLog.append(session.id, {
            role: 'system',
            kind: 'model_issue',
            content: `Agent invocation failed (attempt ${attempt}): ${this.config.redactProviderErrorMessage(error.message)}`,
          });
        } catch {
          void 0;
        }
        const eventBus = this.config.eventBusProvider();
        if (eventBus)
          eventBus.emit('agent_invocation_failed', {
            role,
            attempt,
            error: error.message,
            sessionId: session.id,
            cardId,
            goalId,
            recoverable: !this.config.sessionLifecycle.isCancelled(session.id),
          });
        if (
          this.config.sessionLifecycle.isCancelled(session.id) ||
          /cancelled/i.test(error.message) ||
          /No (healthy|capability-compatible) candidates available/.test(error.message)
        ) break;
        await delayInvocationRecovery(recoveryDelayMs);
      }
    }
    const summaryLast = attempts[attempts.length - 1];
    const summaryCancelled =
      this.config.sessionLifecycle.isCancelled(session.id) ||
      (typeof summaryLast?.error?.message === 'string' && /cancelled/i.test(summaryLast.error.message));
    const verdict: 'succeeded' | 'exhausted' | 'cancelled' = summaryLast?.success
      ? 'succeeded'
      : summaryCancelled
        ? 'cancelled'
        : 'exhausted';
    const summaryPayload = {
      session_id: session.id,
      role: role as unknown as import('../schemas/types.js').AgentRole,
      goal_id: goalId,
      card_id: cardId,
      contract_id: contract.name + '.v1',
      attempts_count: attemptRecorder.getOutcomeCount(),
      total_duration_ms: Date.now() - invocationStart,
      verdict,
      repair_attempts: attemptRecorder.getRepairAttempts(),
      contract_verdict: attemptRecorder.getContractVerdict(),
      final_provider: verdict === 'succeeded' ? attemptRecorder.getLastSucceeded()?.provider : undefined,
      final_model: verdict === 'succeeded' ? attemptRecorder.getLastSucceeded()?.model : undefined,
      final_account: verdict === 'succeeded' ? attemptRecorder.getLastSucceeded()?.account : undefined,
      final_terminal_tool: (() => {
        const succeeded = attemptRecorder.getLastSucceeded();
        return verdict === 'succeeded' && succeeded?.outcome.kind === 'succeeded'
          ? succeeded.outcome.terminal_tool
          : undefined;
      })(),
      last_failure_class: verdict === 'succeeded' ? undefined : attemptRecorder.getLastFailedClass(),
    };
    if (this.config.eventLogger)
      this.config.eventLogger.appendEvent({ kind: 'llm_invocation_summary', ...summaryPayload });
    const eventBus = this.config.eventBusProvider();
    if (eventBus) eventBus.emit('llm_invocation_summary', summaryPayload);
    const lastAttempt = attempts[attempts.length - 1];
    if (lastAttempt.success && lastAttempt.result !== undefined) {
      const resultValue = lastAttempt.result as R;
      const statusBearer =
        role === 'planner' &&
        typeof resultValue === 'object' &&
        resultValue !== null &&
        'result' in (resultValue as Record<string, unknown>)
          ? (resultValue as unknown as { result: unknown }).result
          : resultValue;
      const resultStatus =
        typeof statusBearer === 'object' &&
        statusBearer !== null &&
        'status' in (statusBearer as Record<string, unknown>)
          ? (statusBearer as Record<string, unknown>).status
          : null;
      if (role === 'planner' && resultStatus === 'continue')
        this.config.sessionLifecycle.markWaiting(session.id);
      else if (role === 'planner' && resultStatus === 'blocked')
        this.config.sessionLifecycle.complete(session.id, 'blocked');
      else if (role === 'executor' && resultStatus === 'failed')
        this.config.sessionLifecycle.complete(session.id, 'failed');
      else this.config.sessionLifecycle.complete(session.id, 'done');
      return resultValue;
    }
    this.config.sessionLifecycle.complete(session.id, 'failed');
    throw (
      lastAttempt.error ??
      new Error(`Agent '${role}' invocation failed after ${attempts.length} attempts.`)
    );
  }
}
