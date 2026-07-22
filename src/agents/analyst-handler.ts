import { type AnalystConversationSessionId } from '../schemas/index.js';
import {
  ANALYST_NO_MODEL_REPLY,
  AnalystOfflineError,
  formatVocabularySnippet,
} from './analyst-prompt.js';
import { buildRuntimeDiagnosticEvent } from '../runtime/runtime-diagnostic-event.js';
import type { EventLog } from '../observability/index.js';
import { ANALYST_UNSUPPORTED_ACTION_TEMPLATE } from './analyst-tool-runner.js';
import { getModelParamsForRole } from '../schemas/saivage-config.js';
import type { SaivageConfig } from '../schemas/saivage-config.js';
import type { CardService } from '../cards/card-api.js';
import { capabilityRequestForLlmOptions } from './provider-capabilities.js';
import { buildAgentProtocolViolation, parseProtocolToolArgs } from './agent-protocol-violation.js';
import { buildAnalystIngressRows, buildAnalystRestartRows, providerConversationProjection } from '../runtime/actors/conversation-session.js';
import { ConversationLLMActor, type AnalystCancellationPublication, type LLMActorOutcome, type LLMProviderPort, type LlmTerminalHandoff } from '../runtime/actors/llm-actor.js';
import { buildLlmTurnMessage } from '../runtime/actors/llm-delivery-log.js';
import { appendConversationBatch, readConversation, type ConversationFileContext } from '../persistence/conversation-file.js';
import type { PreparedLlmInvocationInput } from '../runtime/actors/llm-invocation.js';
import { invokeToolCall, surfaceToolDefinitions, type InvocationSurface, type ToolResult } from '../tools/invocation.js';
import { deferred, type Deferred } from '../runtime/actors/deferred.js';
import { formatPromptToolList, type PromptTemplateRegistry } from '../utils/prompt-api.js';
import type { RestartPort } from '../boot/restart-port.js';
import type { RestartChatAcknowledgement } from '../contracts/operator-api-chats.js';
import { ActivationOperationTracker, type InvocationJoinOutcome } from '../runtime/actors/invocation-lifecycle.js';
import type { CompactorPort } from '../runtime/actors/llm-actor.js';
import { prepareCompaction, type AutonomousCompactionPolicy } from '../runtime/actors/compaction/compactor.js';
import type { SummarizerProviderPort } from '../runtime/actors/compaction/summarizer.js';
import type { ExecutingLlmSnapshot } from '../runtime/actors/executing-llm-snapshot.js';
import type { CanonicalLlmInvocationInput } from '../runtime/actors/llm-invocation.js';
import { randomUUID } from 'node:crypto';
import { AppLogPublicationError, rethrowAppLogPublicationError } from '../persistence/app-log.js';


export interface WorkspaceContext {
  view: string | null;
  entityId: string | null;
  refinement: Record<string, string> | null;
}

function isWorkspaceContextEmpty(workspaceContext?: WorkspaceContext): boolean {
  if (!workspaceContext) return true;
  const refinement = workspaceContext.refinement;
  return workspaceContext.view === null
    && workspaceContext.entityId === null
    && (!refinement || Object.keys(refinement).length === 0);
}

export function buildWorkspaceContextNote(workspaceContext?: WorkspaceContext): string {
  if (isWorkspaceContextEmpty(workspaceContext)) return '[workspace-context] none — no entity is currently in focus';
  const lines = ['[workspace-context]'];
  if (workspaceContext?.view !== null && workspaceContext?.view !== undefined) lines.push(`view: ${workspaceContext.view}`);
  if (workspaceContext?.entityId !== null && workspaceContext?.entityId !== undefined) lines.push(`entity: ${workspaceContext.entityId}`);
  const refinement = workspaceContext?.refinement;
  if (refinement && Object.keys(refinement).length > 0) {
    lines.push(`refinement: ${Object.entries(refinement).map(([key, value]) => `${key}=${value}`).join(';')}`);
  }
  return lines.join('\n');
}

export interface AnalystResponse {
  sessionId: AnalystConversationSessionId;
  restart: RestartChatAcknowledgement | null;
  cancelled?: boolean;
  toolInvocations?: Array<{
    tool: string;
    params: Record<string, unknown>;
    result: ToolResult;
    sourceInputId: string;
    toolCallId: string;
  }>;
}

export interface AnalystTurnInput {
  userContent: string;
  workspaceContext?: WorkspaceContext;
}

export type AnalystTurnResult = AnalystResponse;

type AnalystToolInvocations = NonNullable<AnalystResponse['toolInvocations']>;

type RestartConfirmation = Readonly<{ kind: 'restart_confirmation' }>;
type TerminalCompletion = Readonly<{ input: CanonicalLlmInvocationInput; outcome: Extract<LLMActorOutcome, { type: 'result' | 'error' }> }>;
type AnalystTurnStep =
  | { kind: 'preparing' }
  | { kind: 'starting'; ingress: 'publishing' | 'published'; cancellationRequested: string | null }
  | { kind: 'nested'; input: CanonicalLlmInvocationInput }
  | { kind: 'waiting_tool'; input: CanonicalLlmInvocationInput; outcome: Extract<LLMActorOutcome, { type: 'tool_call' }> }
  | { kind: 'confirmed_restart_preparing' }
  | { kind: 'confirmed_restart_publishing'; request: { kind: 'cancel'; reason: string } | { kind: 'dispose'; reason: unknown } | null }
  | { kind: 'confirmed_restart_published' }
  | { kind: 'confirmed_restart_scheduling' }
  | { kind: 'settling_llm'; completion: TerminalCompletion; noticeEntered: boolean };
type AnalystTurnOutcome =
  | { kind: 'pending' }
  | { kind: 'claiming_cancel'; reason: string; publication: 'pending' | 'published' }
  | { kind: 'completed'; response: AnalystResponse }
  | { kind: 'failed'; error: unknown };
type AnalystTurnOperation = {
  readonly input: AnalystTurnInput;
  readonly acceptedOperationId: string;
  restartConfirmation: RestartConfirmation | null;
  readonly caller: Deferred<AnalystTurnResult>;
  readonly abort: AbortController;
  readonly tracker: ActivationOperationTracker;
  outcome: AnalystTurnOutcome;
  step: AnalystTurnStep;
  readonly toolInvocations: AnalystToolInvocations;
  toolInFlight: string | null;
  newlyRequestedRestart: boolean;
};
type AnalystSessionPhase =
  | { kind: 'idle'; restartConfirmation: RestartConfirmation | null }
  | { kind: 'conversing'; operation: AnalystTurnOperation }
  | { kind: 'failed'; cause: unknown }
  | { kind: 'disposed'; reason: unknown; settling: AnalystTurnOperation | null };

class RecoverablePreparationError extends Error {
  constructor(readonly causeValue: unknown) { super('Analyst pure preparation failed.', { cause: causeValue }); }
}

export class AnalystSession {
  readonly #projectRoot: string;
  readonly #sessionId: AnalystConversationSessionId;
  readonly #config: SaivageConfig;
  readonly #promptTemplates: PromptTemplateRegistry;
  readonly #restartServerAvailable: boolean;
  readonly #restartPort: RestartPort | undefined;
  readonly #conversations: ConversationFileContext;
  readonly #compactionPolicy: AutonomousCompactionPolicy;
  readonly #eventLogger: EventLog;
  readonly #cardStore: CardService;
  readonly #runtimeProjectionChanged: () => void;
  readonly #createInvocationSurface: () => InvocationSurface;
  readonly #shutdownProcesses: () => Promise<void>;
  readonly #llm: ConversationLLMActor;
  #phase: AnalystSessionPhase = { kind: 'idle', restartConfirmation: null };
  readonly #retiredOperationTrackers = new Set<ActivationOperationTracker>();

  constructor(input: {
    projectRoot: string;
    sessionId: AnalystConversationSessionId;
    config: SaivageConfig;
    promptTemplates: PromptTemplateRegistry;
    restartServerAvailable: boolean;
    restartPort?: RestartPort;
    provider: LLMProviderPort;
    conversations: ConversationFileContext;
    compactionPolicy: AutonomousCompactionPolicy;
    compactor: CompactorPort;
    summarizerProvider: SummarizerProviderPort;
    eventLogger: EventLog;
    cardStore: CardService;
    runtimeProjectionChanged(): void;
    createInvocationSurface(): InvocationSurface;
    shutdownProcesses(): Promise<void>;
  }) {
    this.#projectRoot = input.projectRoot;
    this.#sessionId = input.sessionId;
    this.#config = input.config;
    this.#promptTemplates = input.promptTemplates;
    this.#restartServerAvailable = input.restartServerAvailable;
    this.#restartPort = input.restartPort;
    this.#conversations = input.conversations;
    this.#compactionPolicy = input.compactionPolicy;
    this.#eventLogger = input.eventLogger;
    this.#cardStore = input.cardStore;
    this.#runtimeProjectionChanged = input.runtimeProjectionChanged;
    this.#createInvocationSurface = input.createInvocationSurface;
    this.#shutdownProcesses = input.shutdownProcesses;
    this.#llm = new ConversationLLMActor({ agentId: input.sessionId, provider: input.provider, conversations: input.conversations, compactor: input.compactor, summarizerProvider: input.summarizerProvider, runtimeProjectionChanged: input.runtimeProjectionChanged });
  }

  submit(input: AnalystTurnInput): Promise<AnalystTurnResult> {
    if (this.#phase.kind === 'failed') return Promise.reject(this.#phase.cause);
    if (this.#phase.kind === 'disposed') return Promise.reject(this.#phase.reason);
    if (this.#phase.kind !== 'idle') return Promise.reject(new Error(`Analyst session '${this.#sessionId}' already has an active turn.`));
    if (!input.userContent.trim()) return Promise.reject(new Error('Analyst turn content must not be empty.'));
    const caller = deferred<AnalystTurnResult>(); void caller.promise.catch(() => undefined);
    const operation: AnalystTurnOperation = {
      input, acceptedOperationId: randomUUID(), restartConfirmation: this.#phase.restartConfirmation,
      caller, abort: new AbortController(), tracker: new ActivationOperationTracker(), outcome: { kind: 'pending' },
      step: this.#phase.restartConfirmation && input.userContent === 'RESTART SERVER' ? { kind: 'confirmed_restart_preparing' } : { kind: 'preparing' },
      toolInvocations: [], toolInFlight: null, newlyRequestedRestart: false,
    };
    this.#phase = { kind: 'conversing', operation };
    const wrapper = operation.tracker.run(operation.abort.signal, (signal) => this.runAnalystTurn(operation, signal));
    void operation.tracker.trackConsumer(() => this.consumeTurn(operation, wrapper));
    this.#runtimeProjectionChanged();
    return caller.promise;
  }

  cancel(reason: string): boolean {
    const operation = this.activePendingOperation(); if (!operation) return false;
    if (operation.step.kind === 'preparing') return this.claimStartupCancellation(operation, reason, false);
    if (operation.step.kind === 'starting') {
      if (operation.step.ingress === 'publishing') { operation.step.cancellationRequested ??= reason; return true; }
      return this.claimStartupCancellation(operation, reason, true);
    }
    if (operation.step.kind === 'confirmed_restart_preparing') return this.claimRestartCancellation(operation, reason, false);
    if (operation.step.kind === 'confirmed_restart_publishing') { operation.step.request ??= { kind: 'cancel', reason }; return true; }
    if (operation.step.kind === 'confirmed_restart_published') return this.claimRestartCancellation(operation, reason, true);
    if (operation.step.kind === 'confirmed_restart_scheduling' || operation.step.kind === 'settling_llm') return false;
    const claimed = this.#llm.requestCancellation(reason);
    if (claimed.kind !== 'claimed') return false;
    if (!claimed.publicationOwnedByLlm) {
      try {
        appendConversationBatch(this.#conversations, [buildLlmTurnMessage(claimed.input, `Cancelled: ${reason}`)]);
        this.markCancellationPublished(operation, reason);
        this.finishCancellationRevocation(operation, reason);
      } catch (error) {
        operation.outcome = { kind: 'failed', error };
        operation.tracker.revoke(error);
        if (!operation.abort.signal.aborted) operation.abort.abort(error);
      }
    }
    return true;
  }

  executingLlmSnapshot(): ExecutingLlmSnapshot | null {
    if (this.#phase.kind !== 'conversing') return null;
    return Object.freeze({ sessionId: this.#sessionId, agentId: this.#llm.agentId, role: 'analyst', cardId: null, activity: this.#llm.executingActivity() });
  }

  private async runAnalystTurn(operation: AnalystTurnOperation, signal: AbortSignal): Promise<AnalystResponse> {
    this.assertCurrent(operation, signal);
    if (operation.step.kind === 'confirmed_restart_preparing') return this.runConfirmedRestart(operation);
    let surface: InvocationSurface;
    try {
      surface = this.#createInvocationSurface();
    } catch (error) { throw new RecoverablePreparationError(error); }
    const preparedInput = this.prepareInvocationInput(surface);
    this.assertCurrent(operation, signal);
    operation.step = { kind: 'starting', ingress: 'publishing', cancellationRequested: null };
    appendConversationBatch(this.#conversations, buildAnalystIngressRows(operation.acceptedOperationId, buildWorkspaceContextNote(operation.input.workspaceContext), operation.input.userContent));
    if (operation.step.kind !== 'starting') throw new Error('Analyst ingress ownership changed during publication.');
    operation.step = { ...operation.step, ingress: 'published' };
    if (operation.step.cancellationRequested !== null) {
      this.claimStartupCancellation(operation, operation.step.cancellationRequested, true);
      throw operation.abort.signal.reason;
    }
    this.assertCurrent(operation, signal);
    const invocationInput: PreparedLlmInvocationInput = {
      ...preparedInput,
      providerConversation: providerConversationProjection(readConversation(this.#conversations.projectRoot, this.#sessionId)),
    };
    operation.step = { kind: 'nested', input: invocationInput };
    const terminal = this.terminalHandoff(operation);
    let outcome = await this.#llm.turn(invocationInput, signal, terminal, (input, reason) => this.claimNestedCancellation(operation, input, reason));
    for (;;) {
      this.assertCurrentOrSettling(operation, signal);
      if (outcome.type === 'error' || outcome.type === 'result') return this.settleTerminalCompletion(operation, outcome);
      operation.step = { kind: 'waiting_tool', input: this.#llm.waitingToolInput(outcome), outcome };
      const rawArguments = this.#llm.waitingToolArguments(outcome);
      const parsed = parseProtocolToolArgs(rawArguments);
      let params: Record<string, unknown>;
      let result: ToolResult;
      if (!surface.tools.has(outcome.toolName)) {
        params = parsed.kind === 'ok' ? parsed.args : {};
        result = { success: false, error: ANALYST_UNSUPPORTED_ACTION_TEMPLATE('Analyst', Array.from(surface.tools.keys())) };
      } else if (parsed.kind === 'violation') {
        params = {};
        const violation = buildAgentProtocolViolation({ session_id: this.#sessionId, role: 'analyst', tool_call_id: outcome.toolCallId, tool_name: outcome.toolName, violation: parsed.violation, raw: rawArguments });
        result = { success: false, error: JSON.stringify(violation) };
      } else {
        params = parsed.args;
        operation.toolInFlight = outcome.toolName;
        result = await invokeToolCall(surface, outcome.toolName, rawArguments, this.#llm.toolInvocationContext(outcome), signal);
        operation.toolInFlight = null; this.assertCurrent(operation, signal);
      }
      operation.toolInvocations.push({
        tool: outcome.toolName,
        params,
        result,
        sourceInputId: outcome.inputId,
        toolCallId: outcome.toolCallId,
      });
      if (outcome.toolName === 'restart_server' && result.success) {
        await this.#llm.settleToolResultWithoutContinuation(outcome.toolCallId, result);
        operation.newlyRequestedRestart = true;
        return this.response(operation, { status: 'confirmation_required', confirmationMessage: 'RESTART SERVER' });
      }
      outcome = await this.#llm.appendToolResult(outcome.toolCallId, result, signal);
    }
  }

  private runConfirmedRestart(operation: AnalystTurnOperation): AnalystResponse {
    if (!operation.restartConfirmation || !this.#restartServerAvailable || !this.#restartPort) throw new RecoverablePreparationError(new Error('Restart confirmation is unavailable without authenticated operator restart capability.'));
    operation.step = { kind: 'confirmed_restart_publishing', request: null };
    appendConversationBatch(this.#conversations, buildAnalystRestartRows(operation.acceptedOperationId, operation.input.userContent));
    if (operation.step.kind !== 'confirmed_restart_publishing') throw new Error('Restart publication ownership changed.');
    const request = operation.step.request; operation.step = { kind: 'confirmed_restart_published' };
    if (request?.kind === 'cancel') { this.claimRestartCancellation(operation, request.reason, true); throw operation.abort.signal.reason; }
    if (request?.kind === 'dispose') throw request.reason;
    operation.step = { kind: 'confirmed_restart_scheduling' };
    this.#restartPort.schedule(); operation.restartConfirmation = null;
    return this.response(operation, { status: 'scheduled' });
  }

  private terminalHandoff(operation: AnalystTurnOperation): LlmTerminalHandoff {
    return (completion) => {
      const ownsOperation = (this.#phase.kind === 'conversing' && this.#phase.operation === operation)
        || (this.#phase.kind === 'disposed' && this.#phase.settling === operation);
      if (!ownsOperation || operation.outcome.kind !== 'pending') throw new Error('Analyst terminal handoff lost outer ownership.');
      if (operation.step.kind !== 'nested' && operation.step.kind !== 'waiting_tool') throw new Error(`Analyst terminal handoff arrived from '${operation.step.kind}'.`);
      operation.step = { kind: 'settling_llm', completion, noticeEntered: false };
    };
  }

  private settleTerminalCompletion(operation: AnalystTurnOperation, outcome: Extract<LLMActorOutcome, { type: 'result' | 'error' }>): AnalystResponse {
    if (operation.step.kind !== 'settling_llm' || operation.step.completion.outcome !== outcome) throw new Error('Analyst terminal promise disagrees with synchronous handoff.');
    if (outcome.type === 'error') {
      operation.step.noticeEntered = true;
      appendConversationBatch(this.#conversations, [buildLlmTurnMessage(operation.step.completion.input, this.errorMessage(outcome.error))]);
    }
    return this.response(operation);
  }

  private claimNestedCancellation(operation: AnalystTurnOperation, input: CanonicalLlmInvocationInput, reason: string): AnalystCancellationPublication {
    if (this.#phase.kind !== 'conversing' || this.#phase.operation !== operation || operation.outcome.kind !== 'pending') throw new Error('Analyst nested cancellation lost outer ownership.');
    if (operation.step.kind === 'nested' && (operation.step.input.inputId !== input.inputId || operation.step.input.agentId !== input.agentId || operation.step.input.sessionId !== input.sessionId)) throw new Error('Analyst nested cancellation input changed.');
    if (operation.step.kind === 'waiting_tool' && operation.step.input !== input && operation.step.input.inputId === input.inputId) throw new Error('Analyst nested cancellation input identity changed.');
    operation.outcome = { kind: 'claiming_cancel', reason, publication: 'pending' };
    return Object.freeze({ markPublished: () => {
      if (operation.outcome.kind !== 'claiming_cancel') throw new Error('Analyst cancellation publication lost ownership.');
      operation.outcome = { ...operation.outcome, publication: 'published' };
      this.finishCancellationRevocation(operation, reason);
    } });
  }

  private claimStartupCancellation(operation: AnalystTurnOperation, reason: string, ingressPublished: boolean): boolean {
    if (!this.claimOuterCancellation(operation, reason)) return false;
    const rows = ingressPublished
      ? [buildLlmTurnMessage(this.acceptedInput(operation), `Cancelled: ${reason}`)]
      : [...buildAnalystIngressRows(operation.acceptedOperationId, buildWorkspaceContextNote(operation.input.workspaceContext), operation.input.userContent), buildLlmTurnMessage(this.acceptedInput(operation), `Cancelled: ${reason}`)];
    try { appendConversationBatch(this.#conversations, rows); this.markCancellationPublished(operation, reason); this.finishCancellationRevocation(operation, reason); }
    catch (error) { operation.outcome = { kind: 'failed', error }; operation.tracker.revoke(error); operation.abort.abort(error); }
    return true;
  }

  private claimRestartCancellation(operation: AnalystTurnOperation, reason: string, restartPublished: boolean): boolean {
    if (!this.claimOuterCancellation(operation, reason)) return false;
    const rows = restartPublished ? [buildLlmTurnMessage(this.acceptedInput(operation), `Cancelled: ${reason}`)] : [...buildAnalystRestartRows(operation.acceptedOperationId, operation.input.userContent), buildLlmTurnMessage(this.acceptedInput(operation), `Cancelled: ${reason}`)];
    try { appendConversationBatch(this.#conversations, rows); this.markCancellationPublished(operation, reason); this.finishCancellationRevocation(operation, reason); }
    catch (error) { operation.outcome = { kind: 'failed', error }; operation.tracker.revoke(error); operation.abort.abort(error); }
    return true;
  }

  private claimOuterCancellation(operation: AnalystTurnOperation, reason: string): boolean {
    if (this.#phase.kind !== 'conversing' || this.#phase.operation !== operation || operation.outcome.kind !== 'pending') return false;
    operation.outcome = { kind: 'claiming_cancel', reason, publication: 'pending' }; return true;
  }
  private markCancellationPublished(operation: AnalystTurnOperation, reason: string): void { if (operation.outcome.kind !== 'claiming_cancel' || operation.outcome.reason !== reason) throw new Error('Analyst cancellation publication identity changed.'); operation.outcome = { ...operation.outcome, publication: 'published' }; }
  private finishCancellationRevocation(operation: AnalystTurnOperation, reason: string): void { const interruption = new Error(reason); if (!operation.abort.signal.aborted) operation.abort.abort(interruption); operation.tracker.revoke(interruption); }

  private acceptedInput(operation: AnalystTurnOperation): CanonicalLlmInvocationInput {
    return { inputId: operation.acceptedOperationId, agentId: this.#llm.agentId, role: 'analyst', sessionId: this.#sessionId, systemPrompt: '', providerConversation: { sourceSessionId: this.#sessionId, messages: [] }, tools: [], terminalToolNames: [], modelParams: {}, preparedCompaction: prepareCompaction(this.#compactionPolicy, '', []), capabilityRequest: { requiresTools: false }, episodeContext: {} };
  }

  private prepareInvocationInput(surface: InvocationSurface): Omit<PreparedLlmInvocationInput, 'providerConversation'> {
    const tools = surfaceToolDefinitions(surface); const modelParams = getModelParamsForRole(this.#config, 'analyst');
    const systemPrompt = this.#promptTemplates.render('analyst', 'analyst', { toolList: formatPromptToolList(tools), vocabularySnippet: formatVocabularySnippet(), projectContext: this.buildProjectContext() });
    return { inputId: randomUUID(), agentId: this.#llm.agentId, role: 'analyst', sessionId: this.#sessionId, systemPrompt, tools, terminalToolNames: [], modelParams: { temperature: modelParams.temperature }, preparedCompaction: prepareCompaction(this.#compactionPolicy, systemPrompt, tools, modelParams.maxTokens), capabilityRequest: capabilityRequestForLlmOptions({ tools, stream: false }), episodeContext: { surface: 'web-chat' } };
  }

  private logBoundaryDiagnostic(phase: string, err: unknown): void {
    this.#eventLogger.appendEventPrepared(() => buildRuntimeDiagnosticEvent({ phase, error: err }), { operationError: err });
  }

  private errorMessage(err: unknown): string {
    const noHealthyMessage = `No healthy candidates available for role 'analyst'.`;
    const error = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
    return err instanceof AnalystOfflineError
      ? err.message
      : error === noHealthyMessage
        ? ANALYST_NO_MODEL_REPLY
        : `Analyst LLM unavailable: ${error}`;
  }

  private response(operation: AnalystTurnOperation, restart: RestartChatAcknowledgement | null = null): AnalystResponse {
    const acknowledgement = restart ?? (operation.restartConfirmation || operation.newlyRequestedRestart ? { status: 'confirmation_required' as const, confirmationMessage: 'RESTART SERVER' } : null);
    return { sessionId: this.#sessionId, restart: acknowledgement, toolInvocations: operation.toolInvocations.length > 0 ? operation.toolInvocations : undefined };
  }

  private buildProjectContext(): string {
    try {
      return JSON.stringify({ projectRoot: this.#projectRoot, cards: this.#cardStore.list().map((card) => ({ id: card.id, type: card.type, parent: this.#cardStore.getParent(card.id), status: card.lifecycle.status, title: card.title, priority: card.priority, tags: card.tags })) }, null, 2);
    } catch (err) {
      rethrowAppLogPublicationError(err);
      this.logBoundaryDiagnostic('analyst_project_context_build_failed', err);
      return `Project root: ${this.#projectRoot}`;
    }
  }

  private activePendingOperation(): AnalystTurnOperation | null { return this.#phase.kind === 'conversing' && this.#phase.operation.outcome.kind === 'pending' ? this.#phase.operation : null; }
  private assertCurrent(operation: AnalystTurnOperation, signal: AbortSignal): void { if (this.#phase.kind !== 'conversing' || this.#phase.operation !== operation || operation.outcome.kind !== 'pending') throw signal.aborted ? signal.reason : new Error('Analyst turn lost exact operation authority.'); signal.throwIfAborted(); }
  private assertCurrentOrSettling(operation: AnalystTurnOperation, signal: AbortSignal): void {
    const ownsOperation = (this.#phase.kind === 'conversing' && this.#phase.operation === operation)
      || (this.#phase.kind === 'disposed' && this.#phase.settling === operation && operation.step.kind === 'settling_llm');
    if (!ownsOperation || (operation.outcome.kind !== 'pending' && operation.outcome.kind !== 'claiming_cancel')) throw signal.aborted ? signal.reason : new Error('Analyst turn lost exact operation authority.');
    if (operation.outcome.kind === 'claiming_cancel') signal.throwIfAborted();
  }

  private async consumeTurn(operation: AnalystTurnOperation, wrapper: Promise<AnalystResponse>): Promise<void> {
    let response: AnalystResponse | null = null; let failure: unknown; let rejected = false;
    try { response = await wrapper; } catch (error) { rejected = true; failure = error; }
    operation.tracker.closeAdmission(new Error('Analyst turn settled.'));
    this.#retiredOperationTrackers.add(operation.tracker);
    if (failure instanceof AppLogPublicationError) {
      try { this.#llm.suppressContinuation(failure); } catch { /* publication failure remains authoritative */ }
      try { await this.#shutdownProcesses(); } catch { /* publication failure remains authoritative */ }
      this.#phase = { kind: 'failed', cause: failure };
      operation.caller.reject(failure);
      this.pruneRetiredTrackers();
      return;
    }
    let cleanupFailure: unknown;
    try {
      if (operation.step.kind === 'waiting_tool') this.#llm.abandonParkedTurn();
    } catch (error) { cleanupFailure = error; }
    const finalFailure = cleanupFailure ?? failure;
    const disposedPhase = this.#phase.kind === 'disposed' ? this.#phase : null;
    const disposed = disposedPhase !== null;
    if (operation.outcome.kind === 'claiming_cancel' && operation.outcome.publication === 'published' && !cleanupFailure) {
      const confirmation = operation.restartConfirmation ?? (operation.newlyRequestedRestart ? Object.freeze({ kind: 'restart_confirmation' as const }) : null);
      if (disposedPhase) disposedPhase.settling = null; else this.#phase = { kind: 'idle', restartConfirmation: confirmation };
      operation.caller.resolve({ ...this.response(operation), cancelled: true });
    } else if (!rejected && response && !cleanupFailure) {
      const confirmation = operation.restartConfirmation ?? (operation.newlyRequestedRestart ? Object.freeze({ kind: 'restart_confirmation' as const }) : null);
      if (disposedPhase) disposedPhase.settling = null; else this.#phase = { kind: 'idle', restartConfirmation: confirmation };
      operation.caller.resolve(response);
    } else if (finalFailure instanceof RecoverablePreparationError && !cleanupFailure && !disposed) {
      this.#phase = { kind: 'idle', restartConfirmation: operation.restartConfirmation };
      operation.caller.reject(asError(finalFailure.causeValue));
    } else {
      if (disposedPhase) disposedPhase.settling = null; else this.#phase = { kind: 'failed', cause: finalFailure };
      operation.caller.reject(asError(finalFailure));
    }
    this.pruneRetiredTrackers(); this.#runtimeProjectionChanged();
  }

  private pruneRetiredTrackers(): void { for (const tracker of this.#retiredOperationTrackers) void tracker.join().then((outcome) => { if (outcome.status === 'joined') this.#retiredOperationTrackers.delete(tracker); }, () => undefined); }

  async shutdownProcesses(): Promise<void> {
    await this.#shutdownProcesses();
  }

  disposeSession(reason: unknown): void {
    if (this.#phase.kind === 'disposed') return;
    if (this.#phase.kind === 'failed' || this.#phase.kind === 'idle') { this.#phase = { kind: 'disposed', reason, settling: null }; this.#llm.dispose(reason); return; }
    const operation = this.#phase.operation;
    this.#phase = { kind: 'disposed', reason, settling: operation };
    if (operation.step.kind === 'confirmed_restart_publishing') { operation.step.request ??= { kind: 'dispose', reason }; this.#llm.dispose(reason); return; }
    if (operation.step.kind === 'confirmed_restart_scheduling' || operation.step.kind === 'settling_llm') { this.#llm.dispose(reason); return; }
    const disposition = this.#llm.dispose(reason);
    if (disposition === 'revoked_before_owned_completion') { operation.tracker.revoke(reason); if (!operation.abort.signal.aborted) operation.abort.abort(reason); }
  }

  async joinSession(): Promise<readonly InvocationJoinOutcome[]> {
    const trackers = new Set(this.#retiredOperationTrackers);
    if (this.#phase.kind === 'conversing') trackers.add(this.#phase.operation.tracker);
    if (this.#phase.kind === 'disposed' && this.#phase.settling) trackers.add(this.#phase.settling.tracker);
    const joins = [...trackers].map((tracker) => tracker.join()); const llmJoin = this.#llm.join();
    const settled = await Promise.allSettled([...joins, llmJoin]);
    const failure = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected'); if (failure) throw failure.reason;
    return settled.map((entry) => (entry as PromiseFulfilledResult<InvocationJoinOutcome>).value);
  }
}

export class AnalystRuntime {
  #session: AnalystSession | null = null;
  #admissionOpen = true;
  readonly #createSession: (input: AnalystTurnInput) => AnalystSession;
  readonly #getAvailableToolNames: () => string[];
  readonly #terminateRoot: (reason: string) => Promise<import('../runtime/process-runner.js').ProcessStopReport>;

  constructor(input: {
    createSession(input: AnalystTurnInput): AnalystSession;
    getAvailableToolNames(): string[];
    terminateRoot(reason: string): Promise<import('../runtime/process-runner.js').ProcessStopReport>;
  }) {
    this.#createSession = input.createSession;
    this.#getAvailableToolNames = input.getAvailableToolNames;
    this.#terminateRoot = input.terminateRoot;
  }

  submit(input: AnalystTurnInput): Promise<AnalystTurnResult> {
    if (!this.#admissionOpen) return Promise.reject(new Error('Analyst admission is closed.'));
    return this.getOrCreateSession(input).submit(input);
  }

  cancel(reason: string): boolean {
    return this.#session?.cancel(reason) ?? false;
  }

  executingLlmSnapshot(): ExecutingLlmSnapshot | null {
    return this.#session?.executingLlmSnapshot() ?? null;
  }

  getAvailableToolNames(): string[] {
    return this.#getAvailableToolNames();
  }

  closeAdmission(): void {
    this.#admissionOpen = false;
    this.#session?.disposeSession(new Error('Application stopping.'));
  }

  async cleanupForApplicationStop(): Promise<void> {
    this.closeAdmission();
    const session = this.#session;
    let directContainment: Promise<void>;
    try { directContainment = session ? session.shutdownProcesses() : Promise.resolve(); }
    catch (error) { directContainment = Promise.reject(error); }
    let rootContainment: Promise<import('../runtime/process-runner.js').ProcessStopReport>;
    try { rootContainment = this.#terminateRoot('application stopping'); }
    catch (error) { rootContainment = Promise.reject(error); }
    let sessionJoin: Promise<readonly InvocationJoinOutcome[]>;
    try { sessionJoin = session ? session.joinSession() : Promise.resolve([]); }
    catch (error) { sessionJoin = Promise.reject(error); }
    const [directSettlement, rootSettlement, joinSettlement] = await Promise.allSettled([directContainment, rootContainment, sessionJoin]);
    if (rootSettlement.status === 'rejected') throw rootSettlement.reason;
    if (rootSettlement.value.failed.length !== 0 || directSettlement.status === 'rejected' || joinSettlement.status === 'rejected') throw new Error('Analyst application cleanup failed.');
  }

  private getOrCreateSession(input: AnalystTurnInput): AnalystSession {
    if (!this.#session) this.#session = this.#createSession(input);
    return this.#session;
  }
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
