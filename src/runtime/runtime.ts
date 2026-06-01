import { EventEmitter } from 'node:events';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import type {
  FreezeManifest,
  CardRecord,
  CardStatus,
  RuntimeState,
  RuntimeStatus as RStatus,
  EventKind,
  HandoffSummary,
  ReviewAssessment,
  ProjectRunCompletedPayload,
  ActivationCompletionOutcome,
  ActionableErrorEnvelope,
  RuntimeCommandRecord,
  RuntimeRunRecord,
  RuntimeActivationRecord,
} from '../schemas/index.js';
import { createActivationCompletionEnvelope, parseActivationCompletionEnvelope } from '../schemas/index.js';
import { CardStore, PROJECT_CARD_ID } from '../cards/store-api.js';
import { STARTABLE_STATES, RESTARTABLE_STATES } from '../permissions/index.js';
import { consumeChangedCardActivation, injectQueuedSyntheticPlannerNotes, queueSyntheticPlannerNote, drainSyntheticPlannerNotes } from '../agents/analyst-stage6.js';
import { reconcileOrphanedAgentSessions } from '../agents/session-persistence.js';
import { parseToolCallMessage } from '../agents/persisted-tool-call.js';
import {
  initRuntimeState,
  readRuntimeState,
  saveRuntimeState,
  updateRuntimeState,
  appendRuntimeCommand,
  appendRuntimeRun,
  updateRuntimeRun,
  upsertRuntimeIntent,
  upsertRuntimeActivation,
} from './state.js';
import {
  saveFreezeManifest,
  readFreezeManifest,
  clearFreezeManifest,
} from './freeze-manifest.js';
import { acquireLock, releaseLock } from './lock.js';
import { createDefaultAgentExecution } from '../agents/default-agent-execution.js';
import type { AgentExecutionPort, PlannerResult, ReviewerResult, RuntimeActivationLedgerPort } from '../contracts/index.js';
import { createPlannerContract } from '../contracts/planner-contract.js';
import { createExecutorContract } from '../contracts/executor-contract.js';
import { createReviewerContract } from '../contracts/reviewer-contract.js';
import {
  buildPlannerPrompt,
  buildExecutorPrompt,
  buildReviewerPrompt,
} from '../agents/system-prompt.js';
import { SkillsEngine } from '../agents/skills-engine.js';
import { unwrapFailure } from '../agents/llm-errors.js';
import type { LlmTransportFailure } from '../agents/llm-errors.js';
import {
  disposeProcessRuntimeScope,
  listProcesses,
  reconcileProcessRecords,
  setProcessTerminalBuffering,
  type ProcessListFilter,
} from './process-runner.js';
import type { RuntimeDisposeReportEntry } from './lifecycle.js';
import { cleanAll, cleanStaleStash, cleanStalePreviews, cleanStaleUploads } from '../runtime/cleanup.js';
import { registerArtifact, registerAttachment } from '../cards/artifact-api.js';
import type { ProcessRecord } from '../schemas/index.js';
import { EventLogger } from '../observability/index.js';
import { ErrorLogger } from '../observability/index.js';
import { RuntimeStateMachine, type RuntimeScheduler, type RuntimeSchedulerHandle, type RuntimeCardAction } from './state-machine.js';
import type { RuntimeCardPort, RuntimeStatePort } from './ports.js';
import { EventBus } from '../events/index.js';
import { trackedEventKindValues, type EventPayload } from '../events/index.js';
import {
  appendActivateCardToolResultOnce,
  appendMessage,
  findPlannerSessionForCard,
  findUniqueUnresolvedActivateCardToolCall,
  listSessions,
  getSession,
  getSessionMessages,
} from '../agents/session-persistence.js';
import {
  StuckAgentSupervisor,
  DEFAULT_SUPERVISOR_CONFIG,
  type SupervisorConfig,
  type SupervisorDeps,
} from '../runtime/stuck-agent-supervisor.js';
import { NotificationCenter } from '../notifications/index.js';
import { ActiveRuntimeStampCounter, type ActiveRuntime, type ActiveRuntimeStampSource } from './active-runtime.js';

export type RuntimeStatus = RStatus;
export interface RuntimeConfig { projectRoot: string; fakeAgentConfig: { mapping: Record<string, string>; fixtureDir: string; saivageDir?: string; autoActivateCreatedCards?: boolean };  agentExecutionFactory?: (projectRoot: string, fakeAgentConfig: RuntimeConfig['fakeAgentConfig'], activationLedger: RuntimeActivationLedgerPort) => AgentExecutionPort; skillsEngine?: SkillsEngine; eventLogger?: EventLogger; errorLogger?: ErrorLogger; activeRuntime?: ActiveRuntime; maxGoalDepth?: number; supervisorConfig?: Partial<SupervisorConfig>; autoDispatchBacklog?: boolean; continuousImprovement?: boolean; }
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);
function now(): string { return new Date().toISOString(); }
function saivageWorkDir(projectRoot: string): string { return join(projectRoot, '.saivage-work'); }
function eventsLogPath(projectRoot: string): string { return join(projectRoot, '.saivage', 'runtime', 'events.jsonl'); }
function isTokenBudgetFailure(error: unknown): boolean {
  if (error && typeof error === 'object' && (error as { failure?: unknown }).failure) {
    const failure = (error as { failure: LlmTransportFailure }).failure;
    if (failure?.kind === 'token_budget_exceeded') return true;
  }
  const failure = unwrapFailure(error);
  if (failure.kind === 'token_budget_exceeded') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /context_length_exceeded|token budget exceeded|maximum context length/i.test(message);
}

const PLANNER_CONTEXT_STRING_LIMIT = 500;
const PLANNER_CONTEXT_ARRAY_LIMIT = 5;
const PLANNER_CONTEXT_OBJECT_KEY_LIMIT = 12;
const PLANNER_CONTEXT_MAX_DEPTH = 3;

function truncatePlannerContextString(value: string): string {
  if (value.length <= PLANNER_CONTEXT_STRING_LIMIT) return value;
  return `${value.slice(0, PLANNER_CONTEXT_STRING_LIMIT)}…[truncated ${value.length - PLANNER_CONTEXT_STRING_LIMIT} chars]`;
}

function summarizeForPlannerContext(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return truncatePlannerContextString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, PLANNER_CONTEXT_ARRAY_LIMIT).map((item) => summarizeForPlannerContext(item, depth + 1));
    return value.length > PLANNER_CONTEXT_ARRAY_LIMIT
      ? { items, omitted_count: value.length - PLANNER_CONTEXT_ARRAY_LIMIT }
      : items;
  }
  if (typeof value !== 'object') return String(value);
  const entries = Object.entries(value as Record<string, unknown>);
  if (depth >= PLANNER_CONTEXT_MAX_DEPTH) {
    return {
      kind: 'object_summary',
      keys: entries.slice(0, PLANNER_CONTEXT_OBJECT_KEY_LIMIT).map(([key]) => key),
      omitted_keys: Math.max(0, entries.length - PLANNER_CONTEXT_OBJECT_KEY_LIMIT),
    };
  }
  const summarized: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, PLANNER_CONTEXT_OBJECT_KEY_LIMIT)) summarized[key] = summarizeForPlannerContext(item, depth + 1);
  if (entries.length > PLANNER_CONTEXT_OBJECT_KEY_LIMIT) summarized.omitted_keys = entries.length - PLANNER_CONTEXT_OBJECT_KEY_LIMIT;
  return summarized;
}

function summarizeEvidenceRefsForPlannerContext(refs: unknown[] | undefined): Record<string, unknown> {
  const list = Array.isArray(refs) ? refs : [];
  return {
    count: list.length,
    items: list.slice(0, PLANNER_CONTEXT_ARRAY_LIMIT).map((ref) => summarizeForPlannerContext(ref, 1)),
    omitted_count: Math.max(0, list.length - PLANNER_CONTEXT_ARRAY_LIMIT),
  };
}
function resolveEvidenceSourcePath(projectRoot: string, filePath: string): string { if (!filePath) return filePath; return isAbsolute(filePath) ? resolve(filePath) : resolve(projectRoot, filePath); }
function pathIsInside(parentPath: string, candidatePath: string): boolean { const rel = relative(resolve(parentPath), resolve(candidatePath)); return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel)); }
function resolveRegisterableProcessMetadataSource(projectRoot: string, filePath: string): { sourceFile: string } | { ignored: string } {
  if (!filePath.trim()) return { ignored: 'Missing evidence source path; registered artifacts and attachments must point at Saivage process metadata under .saivage-work.' };
  const sourceFile = resolveEvidenceSourcePath(projectRoot, filePath);
  if (!pathIsInside(saivageWorkDir(projectRoot), sourceFile)) return { ignored: `Project files are not registered as artifacts or attachments: '${filePath}'. Record project changes in result/status_text; register only Saivage process metadata under .saivage-work.` };
  return { sourceFile };
}
const TRACKED_EVENT_KINDS: ReadonlySet<EventKind> = new Set(trackedEventKindValues);

export class Runtime extends EventEmitter {
  readonly projectRoot: string; readonly cardStore: CardStore; readonly agentRuntime: AgentExecutionPort; readonly eventBus: EventBus; readonly notificationCenter: NotificationCenter;
  private _paused = false; private _running = false; private _shuttingDown = false; private _skillsEngine: SkillsEngine | null = null; private _eventLogger: EventLogger; private _ownsEventLogger: boolean; private _errorLogger: ErrorLogger; private _ownsErrorLogger: boolean; readonly runningProcesses: Set<string> = new Set(); private _supervisor: StuckAgentSupervisor; private _continuousImprovementReserved: boolean; private _autoDispatchBacklog: boolean; private _resumeHandoffContext: string | null = null; private _startupRepairPending = false; /* Goal-level re-entrancy guard for dispatchGoal(goalId); the global single-active-non-analyst-session invariant is enforced by assertNoActiveAgentSession in session persistence. */ private _dispatchInFlight = new Set<string>(); private _backgroundDispatches = new Set<Promise<void>>(); private _lastLifecycleDisposeReport: RuntimeDisposeReportEntry[] = []; private _stateMachine: RuntimeStateMachine; private readonly _activeRuntime: ActiveRuntimeStampSource;

  constructor(config: RuntimeConfig, agentRuntime?: AgentExecutionPort) {
    super();
    // EventEmitter promotes emit('error', ...) without a listener into a thrown
    // exception that escapes the local catch block. Several internal call sites
    // emit 'error' for diagnostics (e.g. artifact_registration failures inside
    // dispatchPendingActivations) and rely on continuing past it; without this guard the
    // dispatch pipeline aborts mid-flight and leaves active_card_run stale.
    this.projectRoot = config.projectRoot; this.eventBus = new EventBus(); this.cardStore = new CardStore(config.projectRoot, config.maxGoalDepth, undefined, this.eventBus); const activationLedger: RuntimeActivationLedgerPort = { readState: () => readRuntimeState(config.projectRoot), appendRun: (input) => appendRuntimeRun(config.projectRoot, input), upsertActivation: (input) => upsertRuntimeActivation(config.projectRoot, input) }; this._activeRuntime = config.activeRuntime ?? new ActiveRuntimeStampCounter(); this.agentRuntime = agentRuntime ?? (config.agentExecutionFactory ?? createDefaultAgentExecution)(config.projectRoot, { ...config.fakeAgentConfig, saivageDir: join(config.projectRoot, '.saivage'), activeRuntime: this._activeRuntime }, activationLedger); if (typeof (this.agentRuntime as { setSaivageDir?: (saivageDir: string) => void }).setSaivageDir === 'function') (this.agentRuntime as unknown as { setSaivageDir: (saivageDir: string) => void }).setSaivageDir(join(config.projectRoot, '.saivage')); if (typeof (this.agentRuntime as { setActivationLedger?: (activationLedger: RuntimeActivationLedgerPort) => void }).setActivationLedger === 'function') (this.agentRuntime as unknown as { setActivationLedger: (activationLedger: RuntimeActivationLedgerPort) => void }).setActivationLedger(activationLedger); if (typeof (this.agentRuntime as { setActiveRuntime?: (activeRuntime: ActiveRuntimeStampSource) => void }).setActiveRuntime === 'function') (this.agentRuntime as unknown as { setActiveRuntime: (activeRuntime: ActiveRuntimeStampSource) => void }).setActiveRuntime(this._activeRuntime); this.notificationCenter = new NotificationCenter(config.projectRoot, this.eventBus); this._skillsEngine = config.skillsEngine ?? new SkillsEngine({ projectRoot: config.projectRoot }); this._continuousImprovementReserved = config.continuousImprovement ?? false; this._autoDispatchBacklog = config.autoDispatchBacklog ?? false;
    if (config.eventLogger) { this._eventLogger = config.eventLogger; this._ownsEventLogger = false; } else { this._eventLogger = new EventLogger(join(config.projectRoot, '.saivage')); this._ownsEventLogger = true; }
    if (config.errorLogger) { this._errorLogger = config.errorLogger; this._ownsErrorLogger = false; } else { this._errorLogger = new ErrorLogger(join(config.projectRoot, '.saivage')); this._ownsErrorLogger = true; }
    const supervisorDeps: SupervisorDeps = { getRecentLogs: (maxLines: number) => { try { const logPath = eventsLogPath(this.projectRoot); if (!existsSync(logPath)) return ''; const raw = readFileSync(logPath, 'utf-8'); const allLines = raw.split('\n').filter(Boolean); return allLines.slice(-maxLines).join('\n'); } catch { return ''; } }, getActiveSessions: () => { try { const handoffs = this.agentRuntime.getActiveSessionHandoffs(); if (!(handoffs instanceof Promise)) { const active = handoffs.map((handoff) => ({ role: handoff.role, sessionId: handoff.session_id })); if (active.length > 0) return active; } } catch { void 0; } try { const state = readRuntimeState(this.projectRoot); if (state && state.current_agent_session_id) { const sessionId = state.current_agent_session_id; let role = 'executor'; if (sessionId.startsWith('planner-') || sessionId.startsWith('planner:')) role = 'planner'; else if (sessionId.startsWith('reviewer-') || sessionId.startsWith('reviewer:')) role = 'reviewer'; return [{ role, sessionId }]; } } catch { void 0; } return []; }, abortSession: (sessionId: string) => { void this.agentRuntime.cancelSession(sessionId); }, forceCancelSession: (sessionId: string) => { void this.agentRuntime.forceCancelSession(sessionId); }, emitEvent: (kind: string, data: Record<string, unknown>) => { this.emit(kind, data); if (TRACKED_EVENT_KINDS.has(kind as EventKind)) this._eventLogger.appendEvent({ kind: kind as EventKind, ...data }); }, isShuttingDown: () => this._shuttingDown };
    const mergedSupervisorConfig: SupervisorConfig = { ...DEFAULT_SUPERVISOR_CONFIG, ...config.supervisorConfig };
    this._supervisor = new StuckAgentSupervisor(mergedSupervisorConfig, supervisorDeps);
    const scheduler: RuntimeScheduler = {
      setInterval: (handler, ms) => setInterval(handler, ms) as unknown as RuntimeSchedulerHandle,
      clearInterval: (handle) => clearInterval(handle as unknown as NodeJS.Timeout),
    };
    const runtimeCards: RuntimeCardPort = {
      readStatus: (cardId) => this.cardStore.read(cardId)?.status,
      canTransition: (from, to) => this.cardStore.canTransition(from, to),
      setStatus: (cardId, status) => { this.cardStore.setStatus(cardId, status); },
    };
    const runtimeState: RuntimeStatePort = {
      read: () => readRuntimeState(this.projectRoot),
      patch: (changes) => updateRuntimeState(this.projectRoot, changes),
    };
    this._stateMachine = new RuntimeStateMachine({
      cards: runtimeCards,
      state: runtimeState,
      errors: this._errorLogger,
      clock: { now: () => new Date() },
      scheduler,
      redispatch: { redispatch: (cardId) => { if (!this.cardHasBlockedPlanning(this.cardStore.read(cardId))) void this.dispatchGoal(cardId); } },
      projectCardId: PROJECT_CARD_ID,
    });
  }

  get status(): RuntimeStatus { return readRuntimeState(this.projectRoot)?.status ?? 'idle'; } get paused(): boolean { return this._paused; } get eventLogger(): EventLogger { return this._eventLogger; } get errorLogger(): ErrorLogger { return this._errorLogger; } get supervisor(): StuckAgentSupervisor { return this._supervisor; } get lastLifecycleDisposeReport(): RuntimeDisposeReportEntry[] { return [...this._lastLifecycleDisposeReport]; }
  emit(eventName: string, ...args: unknown[]): boolean {
    const emitted = eventName === 'error' ? false : super.emit(eventName, ...args);
    if (TRACKED_EVENT_KINDS.has(eventName as EventKind)) {
      const data = args[0] && typeof args[0] === 'object' ? (args[0] as Record<string, unknown>) : { raw: args[0] };
      this.eventBus.emit(eventName as EventKind, data as EventPayload<EventKind>);
    }
    return emitted;
  }
  trackProcessStarted(procId: string): void { this.runningProcesses.add(procId); }
  trackProcessStopped(procId: string): void { this.runningProcesses.delete(procId); }
  listRunningProcesses(filter?: ProcessListFilter): ProcessRecord[] { return listProcesses(this.projectRoot, { ...filter, status: 'running' }); }
  registerArtifactOnCard(cardId: string, artifact: { type: 'model' | 'data' | 'config' | 'log' | 'report' | 'other'; description: string; retain: boolean }, sourceFile: string) { const resolved = resolveRegisterableProcessMetadataSource(this.projectRoot, sourceFile); if ('ignored' in resolved) throw new Error(resolved.ignored); return registerArtifact(saivageWorkDir(this.projectRoot), this.cardStore, cardId, artifact, resolved.sourceFile); }
  registerAttachmentOnCard(cardId: string, attachment: { mime: string; title: string; description?: string }, sourceFile: string) { const resolved = resolveRegisterableProcessMetadataSource(this.projectRoot, sourceFile); if ('ignored' in resolved) throw new Error(resolved.ignored); return registerAttachment(saivageWorkDir(this.projectRoot), this.cardStore, cardId, attachment, resolved.sourceFile); }

  private diagnosticStamp(sessionId: string) {
    return this._activeRuntime.stampDiagnosticInCurrentRound(sessionId);
  }

  private userStamp(sessionId: string) {
    return this._activeRuntime.stampUserMessage(sessionId);
  }

  private buildGoalEvidenceContext(goalId: string): string {
    const reviewState = this.cardStore.read(goalId)?.result?.review as Record<string, unknown> | undefined;
    const children = this.cardStore.listChildren(goalId)
      .map((id) => this.cardStore.read(id))
      .filter((card): card is CardRecord => Boolean(card))
      .map((card) => ({
        id: card.id,
        type: card.type,
        status: card.status,
        status_text: card.status_text ? truncatePlannerContextString(card.status_text) : null,
        result_summary: summarizeForPlannerContext(card.result ?? null),
        error: card.error ? truncatePlannerContextString(card.error) : null,
        artifacts: summarizeEvidenceRefsForPlannerContext(card.artifacts),
        attachments: summarizeEvidenceRefsForPlannerContext(card.attachments),
      }));
    return JSON.stringify({
      goal_id: goalId,
      children,
      latest_review_summary: summarizeForPlannerContext(reviewState ?? null),
    }, null, 2);
  }

  private findCallerEdge(childCardId: string): { parentCardId: string; callerSessionId: string; callerToolCallId: string } | null {
    const parentCardId = this.cardStore.getParent(childCardId);
    if (!parentCardId) return null;
    const parentSession = findPlannerSessionForCard(join(this.projectRoot, '.saivage'), parentCardId);
    const callerSessionId = parentSession?.id ?? `planner:${parentCardId}`;
    const call = findUniqueUnresolvedActivateCardToolCall(join(this.projectRoot, '.saivage'), callerSessionId, childCardId);
    if (!call) return null;
    return { parentCardId, callerSessionId, callerToolCallId: call.tool_call_id };
  }

  private buildCardActivationOutcome(childCardId: string, outcome: ActivationCompletionOutcome, summary: string): string {
    const child = this.cardStore.read(childCardId);
    const failureKind = child?.result && typeof child.result === 'object' && typeof (child.result as { failure_kind?: unknown }).failure_kind === 'string'
      ? (child.result as { failure_kind: string }).failure_kind
      : undefined;
    return JSON.stringify(createActivationCompletionEnvelope({
      child_card_id: childCardId,
      outcome,
      summary,
      result: child?.result ?? null,
      review: (child?.result?.review as ReviewAssessment | null | undefined) ?? null,
      artifacts: child?.artifacts ?? [],
      attachments: child?.attachments ?? [],
      evidence_card_ids: child ? [child.id, ...this.cardStore.getDescendantIds(child.id)] : [childCardId],
      error: child?.error ?? null,
      failure_kind: failureKind,
    }));
  }


  private markActivationComplete(childCardId: string, outcome: ActivationCompletionOutcome): void {
    const state = readRuntimeState(this.projectRoot);
    if (!state?.runtime_activations?.length) return;
    const at = now();
    const terminalStatus = outcome === 'done' ? 'completed' : outcome;
    const runResult: RuntimeRunRecord['result'] = outcome === 'done' ? 'done' : outcome === 'blocked' ? 'blocked' : outcome === 'cancelled' ? 'cancelled' : outcome === 'needs_verification' ? 'needs_verification' : 'failed';
    const activations = state.runtime_activations.map((activation) => (activation.child_card_id === childCardId && ['pending', 'claimed', 'running'].includes(activation.status))
      ? { ...activation, status: terminalStatus as typeof activation.status, updated_at: at }
      : activation);
    const completedActivationIds = new Set(activations.filter((activation) => activation.child_card_id === childCardId && !['pending', 'claimed', 'running'].includes(activation.status)).map((activation) => activation.activation_id));
    const runs = (state.runtime_runs ?? []).map((run) => (run.card_id === childCardId && (!run.finished_at || completedActivationIds.has(run.activation_id ?? '')))
      ? { ...run, phase: terminalStatus as typeof run.phase, runtime_status: outcome === 'done' ? 'idle' as const : 'error' as const, finished_at: at, updated_at: at, result: runResult }
      : run);
    saveRuntimeState(this.projectRoot, { ...state, runtime_activations: activations, runtime_runs: runs, updated_at: at });
  }

  private appendChildUnwindToolResult(childCardId: string, outcome: ActivationCompletionOutcome, summary: string): void {
    this.markActivationComplete(childCardId, outcome);
    const edge = this.findCallerEdge(childCardId);
    if (!edge) return;
    appendActivateCardToolResultOnce(
      join(this.projectRoot, '.saivage'),
      edge.callerSessionId,
      edge.callerToolCallId,
      this.buildCardActivationOutcome(childCardId, outcome, summary),
      this.diagnosticStamp(edge.callerSessionId),
      this._activeRuntime,
    );
  }

  private findUnresolvedActivateCards(sessionId: string): Array<{ session_id: string; tool_call_id: string; card_id: string }> {
    const messages = getSessionMessages(join(this.projectRoot, '.saivage'), sessionId);
    const activateCardToolCallIds = new Set<string>();
    const parsedCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    for (const message of messages) {
      if (message.role !== 'assistant' || message.kind !== 'tool_call') continue;
      let raw: unknown;
      try { raw = JSON.parse(message.content); } catch { continue; }
      const call = parseToolCallMessage(raw);
      parsedCalls.push(call);
      if (call.name === 'activate_card') activateCardToolCallIds.add(call.id);
    }
    const resolved = new Set(messages.filter((message) => {
      if (typeof message.tool_call_id !== 'string' || !activateCardToolCallIds.has(message.tool_call_id)) return false;
      if (message.kind === 'tool_error') return true;
      return message.kind === 'tool_result' && Boolean(parseActivationCompletionEnvelope(message.content));
    }).map((message) => message.tool_call_id as string));
    const calls: Array<{ session_id: string; tool_call_id: string; card_id: string }> = [];
    for (const call of parsedCalls) {
      if (call.name !== 'activate_card' || resolved.has(call.id)) continue;
      const cardId = call.args.cardId;
      if (typeof cardId === 'string') calls.push({ session_id: sessionId, tool_call_id: call.id, card_id: cardId });
    }
    return calls;
  }

  private synthesizeTerminalActivationResult(sessionId: string, toolCallId: string, childCardId: string): boolean {
    const child = this.cardStore.read(childCardId);
    if (!child || !TERMINAL_STATUSES.has(child.status)) return false;
    const outcome = child.status === 'done' ? 'done' : child.status === 'cancelled' ? 'cancelled' : 'failed';
    appendActivateCardToolResultOnce(join(this.projectRoot, '.saivage'), sessionId, toolCallId, this.buildCardActivationOutcome(childCardId, outcome, `Restart repair delivered terminal status '${child.status}' for card ${childCardId}.`), this.diagnosticStamp(sessionId), this._activeRuntime);
    return true;
  }

  private repairOrphanActivateCardToolCalls(): void {
    for (const sessionId of listSessions(join(this.projectRoot, '.saivage'))) {
      const session = getSession(join(this.projectRoot, '.saivage'), sessionId);
      if (!session || session.role !== 'planner') continue;
      for (const call of this.findUnresolvedActivateCards(sessionId)) this.synthesizeTerminalActivationResult(call.session_id, call.tool_call_id, call.card_id);
    }
  }

  private parentPlannerRunFor(childCardId: string): RuntimeState['active_card_run'] {
    const parentCardId = this.cardStore.getParent(childCardId);
    if (!parentCardId) return null;
    const parent = this.cardStore.read(parentCardId);
    if (!parent) return null;
    const stamp = now();
    return { card_id: parentCardId, card_type: parent.type, runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: `planner:${parentCardId}`, correction_attempts: 0, started_at: stamp, last_turn_at: stamp };
  }

  private async repairStartupActiveCardRun(previousState: RuntimeState | null): Promise<RuntimeState | null> {
    const run = previousState?.active_card_run ?? null;
    if (!run) { this.repairOrphanActivateCardToolCalls(); return previousState; }
    const card = this.cardStore.read(run.card_id);
    if (!card) { this.repairOrphanActivateCardToolCalls(); return previousState; }

    if (run.phase === 'reviewer') {
      const persistedReview = card.result && typeof card.result === 'object' ? (card.result as { review?: unknown }).review : undefined;
      if (!persistedReview) {
        await this._stateMachine.transitionCard(run.card_id, 'reviewer_repair_resume', { reason: 'reviewer_interrupted' });
        const plannerSessionId = run.planner_session_id ?? `planner:${run.card_id}`;
        const summary = `reviewer_interrupted: reviewer output for ${run.card_id} was discarded after service restart; interrupted_reviewer_session_id=${run.reviewer_session_id ?? 'unknown'}; resume_reason: reviewer_interrupted.`;
        queueSyntheticPlannerNote(this.projectRoot, { target_planner_session_id: plannerSessionId, target_goal_card_id: run.card_id, kind: 'reviewer_interrupted', affected_card_id: run.card_id, descendant_card_ids: [], summary });
        const nextRun = { ...run, phase: 'planner' as const, runtime_status: 'running' as const, reviewer_session_id: null, last_turn_at: now() };
        const repaired = saveRuntimeState(this.projectRoot, { ...previousState!, status: 'running', current_card_id: run.card_id, current_agent_session_id: plannerSessionId, active_card_run: nextRun, updated_at: now(), paused: false, paused_at: null });
        return repaired;
      }
    }

    if (run.phase === 'executor') {
      if (!TERMINAL_STATUSES.has(card.status)) {
        await this._stateMachine.transitionCard(run.card_id, 'fail', { reason: 'service_restart', error: 'Execution interrupted by service restart.' });
        await this.cardStore.update(run.card_id, { error: 'Execution interrupted by service restart.', result: { ...(card.result ?? {}), failure_kind: 'service_restart', error: 'Execution interrupted by service restart.' } });
      }
      this.appendChildUnwindToolResult(run.card_id, 'failed', `Terminal card ${run.card_id} failed because the service restarted before executor completion.`);
      const parentRun = this.parentPlannerRunFor(run.card_id);
      const repaired = saveRuntimeState(this.projectRoot, { ...previousState!, status: parentRun ? 'running' : 'idle', current_card_id: parentRun?.card_id ?? null, current_agent_session_id: parentRun?.planner_session_id ?? null, active_card_run: parentRun, updated_at: now(), paused: false, paused_at: null });
      return repaired;
    }

    if (TERMINAL_STATUSES.has(card.status)) {
      const edge = this.findCallerEdge(run.card_id);
      if (edge) this.synthesizeTerminalActivationResult(edge.callerSessionId, edge.callerToolCallId, run.card_id);
      const parentRun = this.parentPlannerRunFor(run.card_id);
      const repaired = saveRuntimeState(this.projectRoot, { ...previousState!, status: parentRun ? 'running' : 'idle', current_card_id: parentRun?.card_id ?? null, current_agent_session_id: parentRun?.planner_session_id ?? null, active_card_run: parentRun, updated_at: now(), paused: false, paused_at: null });
      return repaired;
    }

    if (run.phase === 'planner') {
      if (this.cardHasBlockedPlanning(card)) {
        this.finishOpenPlannerRun(run.card_id, 'blocked');
        const repaired = saveRuntimeState(this.projectRoot, { ...previousState!, status: 'idle', current_card_id: null, current_agent_session_id: null, active_card_run: null, updated_at: now(), paused: false, paused_at: null });
        return repaired;
      }
      const nextRun = { ...run, runtime_status: 'running' as const, last_turn_at: now() };
      const repaired = saveRuntimeState(this.projectRoot, { ...previousState!, status: 'running', current_card_id: run.card_id, current_agent_session_id: run.planner_session_id ?? `planner:${run.card_id}`, active_card_run: nextRun, updated_at: now(), paused: false, paused_at: null });
      return repaired;
    }

    this.repairOrphanActivateCardToolCalls();
    return null;
  }

  private emitProjectRunCompleted(card: CardRecord, assessment?: ReviewAssessment): void {
    const outcome = card.status === 'blocked' ? 'blocked' : card.status === 'failed' ? 'failed' : 'done';
    const summary = assessment?.summary ?? card.status_text ?? card.error ?? `project ${outcome}`;
    const payload: ProjectRunCompletedPayload = outcome === 'blocked'
      ? { project_card_id: card.id, result: outcome, summary, blocked_reason: card.error ?? undefined }
      : outcome === 'failed'
        ? { project_card_id: card.id, result: outcome, summary, failure_kind: card.error ?? undefined }
        : { project_card_id: card.id, result: outcome, summary };
    this.emit('project_run_completed', payload);
    this._eventLogger.appendEvent({ kind: 'project_run_completed', ...payload });
  }

  private buildGoalContextCardTree(cardId: string): Array<{ id: string; type: string; title: string; status: string; status_text: string | null; depends_on: string[]; child_card_tree?: unknown[] }> {
    return this.cardStore.listChildren(cardId)
      .map((id) => this.cardStore.read(id))
      .filter((card): card is CardRecord => Boolean(card))
      .map((card) => {
        const children = this.buildGoalContextCardTree(card.id);
        return {
          id: card.id,
          type: card.type,
          title: card.title,
          status: card.status,
          status_text: card.status_text ?? null,
          depends_on: card.depends_on,
          ...(children.length > 0 ? { child_card_tree: children } : {}),
        };
      });
  }

  private buildGoalContextNotes(goalId: string): Array<Record<string, unknown>> {
    return drainSyntheticPlannerNotes(this.projectRoot, `planner:${goalId}`).map((note) => ({ kind: note.kind, origin_card_id: note.affected_card_id, descendant_card_ids: note.descendant_card_ids, body: note.summary, at: note.created_at }));
  }

  private inferResumeReason(goalId: string, fallback: 'initial' | 'reviewer_correction' | 'analyst_directive' | 'subtree_changed' | 'service_restart' = 'initial'): 'initial' | 'reviewer_correction' | 'analyst_directive' | 'subtree_changed' | 'service_restart' {
    const state = readRuntimeState(this.projectRoot);
    const activeRun = state?.active_card_run;
    if (fallback === 'service_restart' && activeRun?.card_id === goalId && activeRun.phase === 'planner') return 'service_restart';
    const notes = this.buildGoalContextNotes(goalId);
    if (notes.some((note) => note.kind === 'reviewer_interrupted')) return 'service_restart';
    if (notes.some((note) => note.kind === 'pending_subtree_correction')) return 'analyst_directive';
    if (notes.some((note) => note.kind === 'subtree_changed')) return 'subtree_changed';
    return fallback;
  }

  private buildGoalContextPayload(goalId: string, resumeReason: 'initial' | 'reviewer_correction' | 'analyst_directive' | 'subtree_changed' | 'service_restart' = 'initial'): Record<string, unknown> | null {
    const goal = this.cardStore.read(goalId);
    if (!goal) return null;
    const review = goal.result && typeof goal.result === 'object' ? (goal.result as { review?: unknown }).review : null;
    const state = readRuntimeState(this.projectRoot);
    const activeRun = state?.active_card_run?.card_id === goalId ? state.active_card_run : null;
    return {
      id: goal.id,
      type: goal.type,
      parent_card_id: goal.parent,
      depth: goal.depth,
      title: goal.title,
      description: goal.description,
      acceptance: goal.acceptance ? [goal.acceptance] : [],
      tags: goal.tags,
      priority: goal.priority,
      depends_on: goal.depends_on,
      blocks: goal.blocks,
      status_text: goal.status_text ?? null,
      child_card_tree: this.buildGoalContextCardTree(goal.id),
      notes: this.buildGoalContextNotes(goal.id),
      latest_self_report: summarizeForPlannerContext(goal.latest_self_report ?? null),
      latest_review_result: summarizeForPlannerContext(review ?? null),
      correction_attempts: activeRun?.correction_attempts ?? 0,
      max_review_retries: 0,
      resume_reason: resumeReason,
    };
  }

  /** Build a canonical §9 goal-context block to attach to prompts and synthetic planner turns. */
  private buildGoalContextBlock(goalId: string, resumeReason: 'initial' | 'reviewer_correction' | 'analyst_directive' | 'subtree_changed' | 'service_restart' = 'initial'): string {
    const payload = this.buildGoalContextPayload(goalId, resumeReason);
    if (!payload) return `## Goal Context\n\nGoal card '${goalId}' not found.\nresume_reason: ${resumeReason}`;
    return `## Goal Context\n\n${JSON.stringify(payload, null, 2)}\n\nresume_reason: ${resumeReason}`;
  }

  private appendPlannerResumeContext(goalId: string, plannerSessionId: string, resumeReason: 'initial' | 'reviewer_correction' | 'analyst_directive' | 'subtree_changed' | 'service_restart'): void {
    appendMessage(join(this.projectRoot, '.saivage'), plannerSessionId, { role: 'user', kind: 'text', content: this.buildGoalContextBlock(goalId, resumeReason) }, this.userStamp(plannerSessionId), this._activeRuntime);
  }

  /** Build a card-context block (the card to execute + its parent goal) to attach to an executor prompt. */
  private buildCardContextBlock(cardId: string, goalId: string): string {
    const card = this.cardStore.read(cardId);
    const goal = this.cardStore.read(goalId);
    if (!card) return `## Card Context\n\nCard '${cardId}' not found.`;
    const payload = {
      card: {
        id: card.id, type: card.type, title: card.title, description: card.description,
        acceptance: card.acceptance, status: card.status, priority: card.priority,
        depends_on: card.depends_on, tags: card.tags, parent: card.parent,
        instructions_file: card.instructions_file ?? null,
      },
      goal: goal ? {
        id: goal.id, title: goal.title, description: goal.description, acceptance: goal.acceptance,
      } : null,
    };
    return `## Card Context\n\n${JSON.stringify(payload, null, 2)}`;
  }


  private nextReviewerAssessmentId(goalId: string): string {
    const escapedGoal = goalId.replace(/[^A-Za-z0-9_.:-]/g, '-');
    const existing = this.cardStore.read(goalId)?.result;
    const review = existing && typeof existing === 'object' ? (existing as { review?: { assessment_id?: unknown } }).review : undefined;
    const prior = typeof review?.assessment_id === 'string' ? review.assessment_id : '';
    const match = prior.match(new RegExp(`^assessment-${escapedGoal}-(\\d+)$`));
    const next = match ? Number(match[1]) + 1 : 1;
    return `assessment-${escapedGoal}-${next}`;
  }

  private reviewerSessionId(goalId: string, assessmentId: string): string {
    return `reviewer:${goalId}:${assessmentId}`;
  }

  private buildReviewAssessment(goalId: string, assessmentId: string, reviewerSessionId: string, result: ReviewerResult['assessment'], override?: Partial<Pick<ReviewAssessment, 'result' | 'summary' | 'achieved' | 'issues' | 'evidence_card_ids'>>): ReviewAssessment {
    const at = now();
    return {
      id: `review:${goalId}:${assessmentId}`,
      goal_card_id: goalId,
      reviewer_session_id: reviewerSessionId,
      assessment_id: assessmentId,
      at,
      result: override?.result ?? result.result,
      summary: override?.summary ?? result.summary,
      achieved: override?.achieved ?? result.achieved,
      issues: override?.issues ?? result.issues,
      evidence_card_ids: override?.evidence_card_ids ?? result.evidence_card_ids,
      created_at: at,
    };
  }

  private validateReviewerAssessment(goalId: string, assessment: ReviewerResult['assessment']): { valid: boolean; reason?: string } {
    if (assessment.evidence_card_ids.length === 0) return { valid: false, reason: 'Reviewer assessment must cite at least one evidence_card_id.' };
    for (const evidenceId of assessment.evidence_card_ids) {
      const card = this.cardStore.read(evidenceId);
      if (!card) return { valid: false, reason: `Reviewer cited missing evidence card '${evidenceId}'.` };
      if (evidenceId !== goalId && card.status !== 'done') return { valid: false, reason: `Reviewer cited non-complete evidence card '${evidenceId}' with status '${card.status}'.` };
      if ((card.artifacts?.length ?? 0) === 0 && (card.attachments?.length ?? 0) === 0 && !card.result) return { valid: false, reason: `Reviewer cited card '${evidenceId}' without durable result, artifact, or attachment evidence.` };
    }
    return { valid: true };
  }

  private async persistReviewState(goalId: string, assessment: ReviewAssessment): Promise<void> {
    const goal = this.cardStore.read(goalId);
    await this.cardStore.update(goalId, { result: { ...(goal?.result ?? {}), review: assessment } });
  }

  consumeResumeHandoffContext(): string | null { const ctx = this._resumeHandoffContext; this._resumeHandoffContext = null; return ctx; }
  emitAgentEvent(name: string, data: Record<string, unknown>): void { if (name === 'session_started' && typeof data.session_id === 'string') { try { updateRuntimeState(this.projectRoot, { current_agent_session_id: data.session_id }); } catch { void 0; } } this.emit(name, data); }


  private makeRuntimePreconditionError(code: string, message: string, nextAction: string, currentState?: Record<string, unknown>): ActionableErrorEnvelope {
    return { code, message, currentState, nextAction, docsRef: 'docs/operator-runbook.md' };
  }

  private emitRuntimeDiagnostic(input: { goal_id?: string; card_id?: string; phase?: string; error: unknown }): void { const error = input.error instanceof Error ? input.error : new Error(String(input.error)); this.emit('runtime_diagnostic', { goal_id: input.goal_id, card_id: input.card_id, phase: input.phase, error_message: error.message, error_name: error.name }); }

  private publishRuntimeLedgerEvent(kind: 'runtime_command', payload: { command: RuntimeCommandRecord }): void;
  private publishRuntimeLedgerEvent(kind: 'runtime_run', payload: { run: RuntimeRunRecord }): void;
  private publishRuntimeLedgerEvent(kind: 'runtime_activation', payload: { activation: RuntimeActivationRecord }): void;
  private publishRuntimeLedgerEvent(kind: 'runtime_actionable_error', payload: { actionable_error: ActionableErrorEnvelope }): void;
  private publishRuntimeLedgerEvent(kind: 'runtime_command' | 'runtime_run' | 'runtime_activation' | 'runtime_actionable_error', payload: Record<string, unknown>): void {
    const logged = this._eventLogger.appendEvent({ kind, ...payload });
    this.eventBus.emit(logged);
    super.emit(kind, payload);
  }

  private trackBackgroundDispatch(dispatch: Promise<void>): void { this._backgroundDispatches.add(dispatch); dispatch.finally(() => this._backgroundDispatches.delete(dispatch)).catch(() => undefined); }

  getBackgroundDispatchCount(): number { return this._backgroundDispatches.size; }

  private finishOpenPlannerRun(goalId: string, result: 'blocked' | 'failed'): void {
    const targetPhase = result === 'blocked' ? 'blocked' : 'failed';
    const targetRuntimeStatus = result === 'blocked' ? 'error' : 'error';
    const openRun = (readRuntimeState(this.projectRoot)?.runtime_runs ?? [])
      .filter((run) => run.card_id === goalId && run.phase === 'planner' && run.runtime_status === 'running' && !run.finished_at && (!run.session_id || run.session_id === `planner:${goalId}`))
      .sort((a, b) => (b.kind === 'root' ? 1 : 0) - (a.kind === 'root' ? 1 : 0))[0];
    if (!openRun) return;
    const updated = updateRuntimeRun(this.projectRoot, openRun.run_id, { phase: targetPhase, runtime_status: targetRuntimeStatus, finished_at: now(), result });
    if (updated) this.publishRuntimeLedgerEvent('runtime_run', { run: updated });
  }

  private bindPlannerSessionToOpenRun(goalId: string, plannerSessionId: string): void {
    const state = readRuntimeState(this.projectRoot);
    const openRun = (state?.runtime_runs ?? [])
      .filter((run) => run.card_id === goalId && ['pending', 'planner'].includes(run.phase) && run.runtime_status === 'running' && !run.finished_at && (!run.session_id || run.session_id === plannerSessionId))
      .sort((a, b) => {
        const phase = (b.phase === 'planner' ? 1 : 0) - (a.phase === 'planner' ? 1 : 0);
        if (phase !== 0) return phase;
        return (b.kind === 'root' ? 1 : 0) - (a.kind === 'root' ? 1 : 0);
      })[0];
    if (!openRun) return;
    const updates: Partial<RuntimeRunRecord> = {};
    if (openRun.phase !== 'planner') updates.phase = 'planner';
    if (openRun.session_id !== plannerSessionId) updates.session_id = plannerSessionId;
    if (Object.keys(updates).length === 0) return;
    const updated = updateRuntimeRun(this.projectRoot, openRun.run_id, updates);
    if (updated) this.publishRuntimeLedgerEvent('runtime_run', { run: updated });
  }

  async startProject(source: 'operator' | 'tool' | 'runtime' | 'analyst' = 'operator'): Promise<{ success: true; command: RuntimeCommandRecord; intent: RuntimeState['runtime_intent']; run: RuntimeRunRecord } | { success: false; command: RuntimeCommandRecord; error: ActionableErrorEnvelope }> {
    const command = appendRuntimeCommand(this.projectRoot, 'start_project', source);
    const state = readRuntimeState(this.projectRoot) ?? initRuntimeState(this.projectRoot);
    if (!this.cardStore.read(PROJECT_CARD_ID)) {
      const error = this.makeRuntimePreconditionError('runtime_start_project_card_missing', `Cannot start project runtime because project card '${PROJECT_CARD_ID}' does not exist.`, `Create or initialize the root project card with id '${PROJECT_CARD_ID}', then retry start_project.`, { projectCardId: PROJECT_CARD_ID });
      const rejectedAt = now();
      const rejectedCommand = { ...command, status: 'rejected' as const, completed_at: rejectedAt, error };
      saveRuntimeState(this.projectRoot, { ...state, runtime_commands: (state.runtime_commands ?? []).map((item) => item.command_id === command.command_id ? rejectedCommand : item), updated_at: rejectedAt });
      this.publishRuntimeLedgerEvent('runtime_command', { command: rejectedCommand });
      this.publishRuntimeLedgerEvent('runtime_actionable_error', { actionable_error: error });
      return { success: false, command: rejectedCommand, error };
    }
    if (this._paused || state.paused || (state.runtime_intent?.status ?? 'stopped') === 'running') {
      const error = this.makeRuntimePreconditionError('runtime_start_precondition_failed', 'Project runtime is already running or paused.', 'Use stop_project to stop current intent, or resume/unpause before starting again.', { intent: (state.runtime_intent?.status ?? 'stopped'), paused: state.paused, activeRunId: (state.runtime_runs ?? []).find((run) => run.kind === 'root' && !run.finished_at)?.run_id ?? null });
      const rejectedAt = now();
      const rejectedCommand = { ...command, status: 'rejected' as const, completed_at: rejectedAt, error };
      saveRuntimeState(this.projectRoot, { ...state, runtime_commands: (state.runtime_commands ?? []).map((item) => item.command_id === command.command_id ? rejectedCommand : item), updated_at: rejectedAt });
      this.publishRuntimeLedgerEvent('runtime_command', { command: rejectedCommand });
      this.publishRuntimeLedgerEvent('runtime_actionable_error', { actionable_error: error });
      return { success: false, command: rejectedCommand, error };
    }
    upsertRuntimeIntent(this.projectRoot, 'running', command.command_id, 'explicit start_project command');
    const run = appendRuntimeRun(this.projectRoot, { kind: 'root', card_id: PROJECT_CARD_ID, parent_run_id: null, command_id: command.command_id, activation_id: null, phase: 'planner', runtime_status: 'running', session_id: null, result: null });
    this.publishRuntimeLedgerEvent('runtime_run', { run });
    if (!this._paused) {
      this.trackBackgroundDispatch(this.dispatchGoal(PROJECT_CARD_ID)
        .then(() => {
          const currentState = readRuntimeState(this.projectRoot);
          const currentRun = (currentState?.runtime_runs ?? []).find((item) => item.run_id === run.run_id);
          const intentStopped = (currentState?.runtime_intent?.status ?? 'stopped') === 'stopped';
          const alreadyTerminal = Boolean(currentRun?.finished_at) || ['stopped', 'failed'].includes(currentRun?.phase ?? '') || ['stopped', 'error'].includes(currentRun?.runtime_status ?? '') || ['stopped', 'failed'].includes(currentRun?.result ?? '');
          if (intentStopped || alreadyTerminal) return;
          const updated = updateRuntimeRun(this.projectRoot, run.run_id, { phase: 'completed', runtime_status: 'idle', finished_at: now(), result: 'done' });
          if (updated) this.publishRuntimeLedgerEvent('runtime_run', { run: updated });
        })
        .catch(async () => {
          try { await this._stateMachine.transition('goal_exit', { goalId: PROJECT_CARD_ID, reason: 'dispatch_failed' }); } catch { void 0; }
          const currentRun = (readRuntimeState(this.projectRoot)?.runtime_runs ?? []).find((item) => item.run_id === run.run_id);
          if (currentRun?.finished_at || currentRun?.runtime_status === 'error' || currentRun?.runtime_status === 'stopped') return;
          const updated = updateRuntimeRun(this.projectRoot, run.run_id, { phase: 'failed', runtime_status: 'error', finished_at: now(), result: 'failed' });
          if (updated) this.publishRuntimeLedgerEvent('runtime_run', { run: updated });
        }));
    }
    const current = readRuntimeState(this.projectRoot) ?? state;
    const completedAt = now();
    const completedCommand = { ...command, status: 'completed' as const, completed_at: completedAt };
    saveRuntimeState(this.projectRoot, { ...current, runtime_commands: (current.runtime_commands ?? []).map((item) => item.command_id === command.command_id ? completedCommand : item), updated_at: completedAt });
    this.publishRuntimeLedgerEvent('runtime_command', { command: completedCommand });
    return { success: true, command: completedCommand, intent: (readRuntimeState(this.projectRoot) ?? current).runtime_intent, run: ((readRuntimeState(this.projectRoot) ?? current).runtime_runs ?? []).find((item) => item.run_id === run.run_id) ?? run };
  }

  async stopProject(source: 'operator' | 'tool' | 'runtime' | 'analyst' = 'operator'): Promise<{ success: true; command: RuntimeCommandRecord; intent: RuntimeState['runtime_intent']; run?: RuntimeRunRecord }> {
    const command = appendRuntimeCommand(this.projectRoot, 'stop_project', source);
    this._shuttingDown = true;
    const state = upsertRuntimeIntent(this.projectRoot, 'stopped', command.command_id, 'explicit stop_project command');
    for (const cardId of this._dispatchInFlight) void this.agentRuntime.forceCancelSession(`planner:${cardId}`);
    const openRuns = (state.runtime_runs ?? []).filter((run) => run.kind === 'root' && !run.finished_at);
    const stoppedRunIds = openRuns.map((run) => run.run_id);
    for (const run of openRuns) { const updated = updateRuntimeRun(this.projectRoot, run.run_id, { phase: 'stopped', runtime_status: 'stopped', finished_at: now(), result: 'stopped' }); if (updated) this.publishRuntimeLedgerEvent('runtime_run', { run: updated }); }
    const current = readRuntimeState(this.projectRoot) ?? state;
    const completedAt = now();
    const completedCommand = { ...command, status: 'completed' as const, completed_at: completedAt };
    saveRuntimeState(this.projectRoot, { ...current, runtime_commands: (current.runtime_commands ?? []).map((item) => item.command_id === command.command_id ? completedCommand : item), status: 'idle', active_card_run: null, current_card_id: null, current_agent_session_id: null, updated_at: completedAt });
    this.publishRuntimeLedgerEvent('runtime_command', { command: completedCommand });
    this._shuttingDown = false;
    const persisted = readRuntimeState(this.projectRoot) ?? current;
    const stoppedRun = stoppedRunIds.length > 0 ? (persisted.runtime_runs ?? []).find((item) => item.run_id === stoppedRunIds[0]) : undefined;
    return { success: true, command: completedCommand, intent: persisted.runtime_intent, ...(stoppedRun ? { run: stoppedRun } : {}) };
  }

  async start_project(): Promise<Awaited<ReturnType<Runtime['startProject']>>> { return this.startProject('operator'); }
  async stop_project(): Promise<Awaited<ReturnType<Runtime['stopProject']>>> { return this.stopProject('operator'); }

  private cardHasBlockedPlanning(card: CardRecord | null): boolean {
    const planning = card?.result && typeof card.result === 'object' ? (card.result as { planning?: unknown }).planning : null;
    return Boolean(planning && typeof planning === 'object' && (planning as { status?: unknown }).status === 'blocked');
  }

  private async alignBlockedPlanningCardStatuses(): Promise<void> {
    for (const card of this.cardStore.list()) {
      if (card.type !== 'project' && card.type !== 'goal') continue;
      if (card.status !== 'active' && card.status !== 'running') continue;
      const planning = card.result && typeof card.result === 'object' ? (card.result as { planning?: unknown }).planning : null;
      if (!planning || typeof planning !== 'object') continue;
      const blockedPlanning = planning as { status?: unknown; resume_reason?: unknown; failure_kind?: unknown; blocked_reason?: unknown };
      if (blockedPlanning.status !== 'blocked') continue;
      const blockedReason = typeof blockedPlanning.blocked_reason === 'string'
        ? blockedPlanning.blocked_reason
        : 'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
      await this._stateMachine.transitionCard(card.id, 'block', { blocked_reason: blockedReason });
      this.finishOpenPlannerRun(card.id, 'blocked');
      await this.cardStore.update(card.id, { status: 'blocked', error: card.error ?? blockedReason, status_text: card.status_text ?? blockedReason });
      const state = readRuntimeState(this.projectRoot);
      if (state?.current_card_id === card.id || state?.active_card_run?.card_id === card.id) {
        updateRuntimeState(this.projectRoot, { status: 'idle', current_card_id: null, current_agent_session_id: null, active_card_run: null });
      }
    }
  }

  async startup(): Promise<void> {
    if (this._running) throw new Error('Runtime is already running.');
    let state = readRuntimeState(this.projectRoot);
    if (!state) state = initRuntimeState(this.projectRoot);
    acquireLock(this.projectRoot);
    await this.alignBlockedPlanningCardStatuses();
    state = readRuntimeState(this.projectRoot) ?? state;
    await this.performCrashRecovery();
    reconcileProcessRecords(this.projectRoot);
    this._startupRepairPending = true;
    const repairedState = await this.repairStartupActiveCardRun(state);
    this._startupRepairPending = false;
    if (!repairedState) state = initRuntimeState(this.projectRoot); else state = repairedState;
    const swept = reconcileOrphanedAgentSessions(join(this.projectRoot, '.saivage'));
    if (swept.length > 0) {
      const sweptSessionIds = swept.map((session) => session.id);
      this.emit('startup_session_sweep', { swept_session_ids: sweptSessionIds });
      this._eventLogger.appendEvent({ kind: 'startup_session_sweep', swept_session_ids: sweptSessionIds });
      const sweptSet = new Set(sweptSessionIds);
      const postRepairState = readRuntimeState(this.projectRoot);
      if (postRepairState?.current_agent_session_id && sweptSet.has(postRepairState.current_agent_session_id)) {
        updateRuntimeState(this.projectRoot, { current_agent_session_id: null });
        state = readRuntimeState(this.projectRoot) ?? state;
      }
    }
    this._paused = state.paused; this._running = true; this._shuttingDown = false;
    this.emit('started', { projectRoot: this.projectRoot }); this._eventLogger.appendEvent({ kind: 'started', project_root: this.projectRoot }); this._supervisor.start(); this._stateMachine.start();
    const startupActiveRun = state.active_card_run;
    if (startupActiveRun?.phase === 'planner' && startupActiveRun.runtime_status === 'running') {
      const startupCard = this.cardStore.read(startupActiveRun.card_id);
      if (!this.cardHasBlockedPlanning(startupCard)) {
        this.trackBackgroundDispatch(this.dispatchGoal(startupActiveRun.card_id));
      }
    }
    setTimeout(() => { void this._stateMachine.requestImmediateTick(); }, 0);
  }
  async shutdown(): Promise<void> { if (this._dispatchInFlight.size > 0) { await Promise.allSettled(Array.from(this._dispatchInFlight).map((cardId) => this.agentRuntime.forceCancelSession(`planner:${cardId}`))); } if (!this._running) return; this._supervisor.stop(); this._stateMachine.stop(); if ((readRuntimeState(this.projectRoot)?.status ?? 'idle') === 'frozen') { try { this._lastLifecycleDisposeReport = await disposeProcessRuntimeScope(this.projectRoot); } catch (error) { this._lastLifecycleDisposeReport = [{ id: 'process-runtime-scope', kind: 'disposable', status: 'failed', error: error instanceof Error ? error.message : String(error) }]; } try { releaseLock(this.projectRoot); } catch { void 0; } this._running = false; this._shuttingDown = false; this.emit('shutdown'); this._eventLogger.appendEvent({ kind: 'shutdown' }); if (this._ownsEventLogger) this._eventLogger.close(); if (this._ownsErrorLogger) this._errorLogger.close(); return; } this._shuttingDown = true; this._running = false; try { this._lastLifecycleDisposeReport = await disposeProcessRuntimeScope(this.projectRoot); for (const id of this._lastLifecycleDisposeReport.filter((entry) => entry.kind === 'child_process').map((entry) => entry.id.replace(/^child:/, ''))) this.runningProcesses.delete(id); } catch (error) { this._lastLifecycleDisposeReport = [{ id: 'process-runtime-scope', kind: 'disposable', status: 'failed', error: error instanceof Error ? error.message : String(error) }]; } try { updateRuntimeState(this.projectRoot, { status: 'idle', current_card_id: null, current_agent_session_id: null, active_card_run: null, paused: false, paused_at: null }); } catch { void 0; } try { releaseLock(this.projectRoot); } catch { void 0; } try { cleanAll(saivageWorkDir(this.projectRoot), this.cardStore); } catch { void 0; } this.emit('shutdown'); this._eventLogger.appendEvent({ kind: 'shutdown' }); if (this._ownsEventLogger) this._eventLogger.close(); if (this._ownsErrorLogger) this._errorLogger.close(); }
  pause(): void { this._paused = true; setProcessTerminalBuffering(this.projectRoot, true); try { updateRuntimeState(this.projectRoot, { status: 'paused', paused: true, paused_at: now() }); } catch { void 0; } this.emit('paused'); this._eventLogger.appendEvent({ kind: 'paused' }); }
  resume(): void { this._paused = false; setProcessTerminalBuffering(this.projectRoot, false); try { const state = readRuntimeState(this.projectRoot); const plannerSessionId = state?.active_card_run?.planner_session_id ?? state?.current_agent_session_id; if (plannerSessionId && state?.active_card_run?.card_id) { this.appendPlannerResumeContext(state.active_card_run.card_id, plannerSessionId, this.inferResumeReason(state.active_card_run.card_id)); injectQueuedSyntheticPlannerNotes(this.projectRoot, plannerSessionId, { stampUserMessage: (id: string) => this.userStamp(id) }); } updateRuntimeState(this.projectRoot, { status: state?.active_card_run ? 'running' : 'idle', paused: false, paused_at: null }); } catch { void 0; } this.emit('resumed'); this._eventLogger.appendEvent({ kind: 'resumed' }); void this._stateMachine.requestImmediateTick(); }
  freeze(reason?: string): FreezeManifest { if ((readRuntimeState(this.projectRoot)?.status ?? 'idle') === 'frozen') { const existing = readFreezeManifest(this.projectRoot); if (existing) return existing; } this._paused = true; const state = readRuntimeState(this.projectRoot); const frozenAt = new Date(); const freezeId = `freeze-${frozenAt.toISOString().replace(/[:.]/g, '-')}`; let handoffSummaries: HandoffSummary[] = []; try { const raw = this.agentRuntime.getActiveSessionHandoffs(); handoffSummaries = raw instanceof Promise ? [] : raw; } catch { void 0; } const manifest: FreezeManifest = { freeze_id: freezeId, reason: reason ?? 'operator requested freeze', created_at: frozenAt.toISOString(), status: 'frozen', project_id: 'project', pid: process.pid, started_at: state?.started_at ?? frozenAt.toISOString(), current_card_id: state?.current_card_id ?? null, current_agent_session_id: state?.current_agent_session_id ?? null, queue: [], running_processes: [], handoff_summaries: handoffSummaries, schema_version: 1, runtime_version: '0.1.0' }; saveFreezeManifest(this.projectRoot, manifest); try { updateRuntimeState(this.projectRoot, { status: 'frozen', started_at: state?.started_at ?? frozenAt.toISOString(), current_card_id: state?.current_card_id ?? null, current_agent_session_id: state?.current_agent_session_id ?? null, paused: true, paused_at: frozenAt.toISOString() }); } catch { void 0; } this.emit('frozen', { freeze_id: manifest.freeze_id, reason: manifest.reason }); this._eventLogger.appendEvent({ kind: 'frozen', freeze_id: manifest.freeze_id, reason: manifest.reason }); return manifest; }
  resumeFromFreeze(): { freeze_id: string; restored_queue: string[]; restored_processes: string[]; restored_card_id: string | null } { const manifest = readFreezeManifest(this.projectRoot); if (!manifest) throw new Error('Cannot resume: no freeze manifest found. The runtime is not frozen.'); if (manifest.schema_version > 1) throw new Error(`Cannot resume: freeze manifest schema version ${manifest.schema_version} is newer than the supported version 1. Upgrade Saivage to resume this freeze.`); const currentVersion = '0.1.0'; if (manifest.runtime_version !== currentVersion) console.warn(`Resuming from freeze created by runtime version ${manifest.runtime_version} with current version ${currentVersion}. State may differ.`); this._paused = false; const processIds: string[] = []; try { updateRuntimeState(this.projectRoot, { status: 'idle', started_at: manifest.started_at, current_card_id: manifest.current_card_id, current_agent_session_id: manifest.current_agent_session_id, paused: false, paused_at: null }); } catch { void 0; } this.runningProcesses.clear(); const handoffSummaries = manifest.handoff_summaries ?? []; if (handoffSummaries.length > 0 && manifest.current_agent_session_id) { this._resumeHandoffContext = handoffSummaries.map((h) => `[Handoff] Session: ${h.session_id}, Role: ${h.role}, Last action: ${h.last_action}, Next action: ${h.next_action}, Context: ${h.context_summary}`).join('\n'); } clearFreezeManifest(this.projectRoot); this.emit('resumed_from_freeze', { freeze_id: manifest.freeze_id }); this._eventLogger.appendEvent({ kind: 'resumed_from_freeze', freeze_id: manifest.freeze_id }); return { freeze_id: manifest.freeze_id, restored_queue: manifest.queue, restored_processes: processIds, restored_card_id: manifest.current_card_id }; }
  async performCrashRecovery(): Promise<void> { const allCards = this.cardStore.list(); for (const card of allCards) if (card.status === 'active' || card.status === 'running') { await this._stateMachine.transitionCard(card.id, 'crash_recovery_drop_to_backlog'); } const tmpRuntimeDir = join(this.projectRoot, '.saivage-work', 'tmp', 'runtime'); if (existsSync(tmpRuntimeDir)) { try { const entries = readdirSync(tmpRuntimeDir); for (const entry of entries) { if (entry === 'runtime.lock') continue; if (entry.endsWith('.tmp') || entry.endsWith('.tmp.') || entry.includes('.tmp.')) { try { rmSync(join(tmpRuntimeDir, entry), { recursive: true, force: true }); } catch { void 0; } } } } catch { void 0; } } try { cleanStaleStash(saivageWorkDir(this.projectRoot), 24 * 60 * 60 * 1000); } catch { void 0; } try { cleanStalePreviews(saivageWorkDir(this.projectRoot), 24 * 60 * 60 * 1000); } catch { void 0; } try { cleanStaleUploads(saivageWorkDir(this.projectRoot), 24 * 60 * 60 * 1000); } catch { void 0; } }
  async dispatchGoal(goalId: string): Promise<void> {
    if (this._dispatchInFlight.has(goalId)) return;
    this._dispatchInFlight.add(goalId);
    try {
    if (this._paused) { this.emit('dispatch_blocked', { reason: 'paused', goal_id: goalId }); this._eventLogger.appendEvent({ kind: 'dispatch_blocked', reason: 'paused', goal_id: goalId }); return; }
    let planCard: CardRecord;
    try {
      consumeChangedCardActivation(this.projectRoot, goalId);
      const goalCard = this.cardStore.read(goalId);
      if (!goalCard) throw new Error(`Goal '${goalId}' not found.`);
      if (goalCard.type !== 'project' && goalCard.type !== 'goal') throw new Error(`dispatchGoal requires a project or goal card, got type '${goalCard.type}'.`);
      const currentStatus = goalCard.status;
      if (currentStatus !== 'active' && currentStatus !== 'running') {
        const action: 'start' | 'restart' = (STARTABLE_STATES as readonly CardStatus[]).includes(currentStatus)
          ? 'start'
          : (RESTARTABLE_STATES as readonly CardStatus[]).includes(currentStatus) ? 'restart' : (() => { throw new Error(`Goal '${goalId}' is in status '${currentStatus}' which is neither startable nor restartable.`); })();
        const transitioned = await this._stateMachine.transitionCard(goalId, action, { goalId });
        if (!transitioned) throw new Error(`Goal '${goalId}' could not be transitioned via ${action} from status '${currentStatus}'.`);
      }
      const refreshed = this.cardStore.read(goalId);
      if (!refreshed) throw new Error(`Goal '${goalId}' disappeared during activation.`);
      const existingResult = refreshed.result && typeof refreshed.result === 'object' ? (refreshed.result as Record<string, unknown>) : {};
      if (!existingResult.planning || typeof existingResult.planning !== 'object') {
        await this.cardStore.update(goalId, {
          result: {
            ...existingResult,
            planning: {
              status: 'continue',
              summary: null,
              blocked_reason: null,
              created_cards: [],
              updated_cards: [],
              updated_at: new Date().toISOString(),
            },
          } as CardRecord['result'],
        });
      }
      planCard = this.cardStore.read(goalId)!;
      const startedAt = now(); const plannerSessionId = `planner:${goalId}`; updateRuntimeState(this.projectRoot, { status: 'running', current_card_id: goalId, current_agent_session_id: plannerSessionId, active_card_run: { card_id: goalId, card_type: planCard.type, runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: plannerSessionId, correction_attempts: 0, started_at: startedAt, last_turn_at: startedAt } }); this.bindPlannerSessionToOpenRun(goalId, plannerSessionId);
    } catch (err) { const errorMessage = err instanceof Error ? err.message : String(err); this.emitRuntimeDiagnostic({ goal_id: goalId, phase: 'activate', error: err }); this._eventLogger.appendEvent({ kind: 'runtime_diagnostic', goal_id: goalId, phase: 'activate', error_message: errorMessage }); this._errorLogger.appendError({ message: errorMessage, goalId, phase: 'activate' }); return; }
    let plannerDone = false; const MAX_ITERATIONS = 50;
    for (let iter = 0; iter < MAX_ITERATIONS && !plannerDone && !this._shuttingDown; iter++) {
      if (this._paused) { this.emit('dispatch_blocked', { reason: 'paused', goal_id: goalId }); this._eventLogger.appendEvent({ kind: 'dispatch_blocked', reason: 'paused', goal_id: goalId }); updateRuntimeState(this.projectRoot, { status: 'paused' }); return; }
      let plannerResult: PlannerResult;
      try {
        const goalCardForDepth = this.cardStore.read(goalId); const currentDepth = goalCardForDepth?.depth; const maxDepth = this.cardStore.maxDepth; const plannerContract = createPlannerContract({ goalId, parentSessionId: '' }); let plannerPrompt = buildPlannerPrompt(plannerContract, undefined, currentDepth, maxDepth);
        const resumeContext = this.buildGoalEvidenceContext(goalId);
        const resumeReason = this.inferResumeReason(goalId, iter === 0 ? 'initial' : 'reviewer_correction');
        const goalContext = this.buildGoalContextBlock(goalId, resumeReason);
        plannerPrompt += `\n\n${goalContext}\n\n## Parent Resume Context\n${resumeContext}`;
        const handoff = this.consumeResumeHandoffContext(); if (handoff) plannerPrompt += `\n\n## Resume Handoff\n${handoff}`;
        try { const goalCard = this.cardStore.read(goalId); if (goalCard && this._skillsEngine) { const plannerInstr = goalCard.depth === 0 ? await this._skillsEngine.loadPlannerInstructions() : (goalCard.instructions_file && goalCard.instructions_file.trim()) ? await this._skillsEngine.loadPlannerInstructions(goalCard.instructions_file.trim()) : ''; const skillsContent = await this._skillsEngine.selectAndFormat({ goalDescription: goalCard.description, cardDescription: goalCard.description, tags: goalCard.tags, filePaths: [], availableTools: ['list_project_files', 'read_project_file', 'load_skill', 'mcp_tool_call'], targetRole: 'planner' }); const combinedSkills = [plannerInstr, skillsContent].filter(Boolean).join('\n\n'); if (combinedSkills) plannerPrompt = buildPlannerPrompt(plannerContract, combinedSkills, currentDepth, maxDepth) + `\n\n${goalContext}\n\n## Parent Resume Context\n${resumeContext}`; } } catch { void 0; }
        injectQueuedSyntheticPlannerNotes(this.projectRoot, `planner:${goalId}`, { stampUserMessage: (id: string) => this.userStamp(id) }); const result = this.agentRuntime.invokePlanner({ goalId, systemPrompt: plannerPrompt, contract: plannerContract }); plannerResult = result instanceof Promise ? await result : result;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.emitRuntimeDiagnostic({ goal_id: goalId, phase: 'planner', error: err });
        this._eventLogger.appendEvent({ kind: 'runtime_diagnostic', goal_id: goalId, phase: 'planner', error_message: errorMessage });
        this._errorLogger.appendError({ message: errorMessage, goalId, phase: 'planner' });
        const failedRun = (readRuntimeState(this.projectRoot)?.runtime_runs ?? []).filter((run) => run.card_id === goalId && run.phase === 'planner' && run.runtime_status === 'running' && !run.finished_at && (!run.session_id || run.session_id === `planner:${goalId}`)).sort((a, b) => (b.kind === 'root' ? 1 : 0) - (a.kind === 'root' ? 1 : 0))[0];
        if (isTokenBudgetFailure(err)) {
          const blockedReason = 'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
          await this._stateMachine.transitionCard(goalId, 'block', { blocked_reason: blockedReason });
          await this.cardStore.update(goalId, {
            status: 'blocked',
            error: blockedReason,
            status_text: blockedReason,
            result: {
              ...(this.cardStore.read(goalId)?.result ?? {}),
              planning: {
                status: 'blocked',
                blocked_reason: blockedReason,
                resume_reason: 'planner_context_length_exceeded',
                failure_kind: 'token_budget_exceeded',
                provider_status: (err as { failure?: { status?: number } }).failure?.status ?? null,
                created_cards: [],
                updated_cards: [],
                summary: 'Planner LLM invocation failed with a context-length/token-budget error before returning scheduler output.',
              },
            },
          });
          if (failedRun) {
            const updated = updateRuntimeRun(this.projectRoot, failedRun.run_id, { phase: 'blocked', runtime_status: 'error', finished_at: now(), result: 'blocked' });
            if (updated) this.publishRuntimeLedgerEvent('runtime_run', { run: updated });
          }
          await this._stateMachine.transition('card_terminated', { goalId, reason: 'planner_context_length_exceeded' });
          return;
        }
        await this._stateMachine.transitionCard(goalId, 'fail', { reason: 'planner_error', error: errorMessage });
        await this.cardStore.update(goalId, { error: errorMessage, status_text: `Planner failed: ${errorMessage}` });
        if (failedRun) { const updated = updateRuntimeRun(this.projectRoot, failedRun.run_id, { phase: 'failed', runtime_status: 'error', finished_at: now(), result: 'failed' }); if (updated) this.publishRuntimeLedgerEvent('runtime_run', { run: updated }); }
        await this._stateMachine.transition('goal_exit', { goalId, reason: 'planner_error' });
        throw err;
      }
      await this.applyPlannerResult(goalId, plannerResult);
      updateRuntimeState(this.projectRoot, { current_agent_session_id: `planner:${goalId}` });
      const execution = await this.dispatchPendingActivations(goalId);
      if (execution.failed) plannerDone = false;
      if (this._shuttingDown) break;
      if (this._paused) { this.emit('dispatch_blocked', { reason: 'paused', goal_id: goalId }); this._eventLogger.appendEvent({ kind: 'dispatch_blocked', reason: 'paused', goal_id: goalId }); return; }
      const hasUnfinishedChildWork = this.cardStore.list().some((card) => card.parent === goalId && card.status !== 'done' && card.status !== 'failed' && card.status !== 'cancelled');
      const hasGoalDispatch = execution.dispatchedGoal; const createdCardIds = (plannerResult.created_cards ?? []).map((card) => card.id).filter((id): id is string => Boolean(id));
      const updatedCardIds = (plannerResult.updated_cards ?? []).map((card) => card.id).filter((id): id is string => Boolean(id));
      if (plannerResult.status === 'blocked') {
        await this._stateMachine.transitionCard(goalId, 'block', { blocked_reason: plannerResult.blocked_reason ?? null });
        await this.cardStore.update(goalId, { status: 'blocked', ...(plannerResult.blocked_reason ? { error: plannerResult.blocked_reason, status_text: plannerResult.blocked_reason } : {}), result: { ...(this.cardStore.read(goalId)?.result ?? {}), planning: { status: 'blocked', blocked_reason: plannerResult.blocked_reason ?? null, resume_reason: 'planner_blocked', created_cards: createdCardIds, updated_cards: updatedCardIds } } });
        this.finishOpenPlannerRun(goalId, 'blocked');
        await this._stateMachine.transition('card_terminated', { goalId, reason: 'planner_blocked' });
        return;
      }
      const hasPlannerAction = createdCardIds.length > 0 || updatedCardIds.length > 0 || hasGoalDispatch || hasUnfinishedChildWork || execution.executedTerminal;
      if (plannerResult.status === 'continue' && !hasPlannerAction) {
        const blockedReason = 'Planner returned continue without creating/updating cards, activating child work, leaving unfinished child work, or declaring a blocker.';
        await this._stateMachine.transitionCard(goalId, 'block', { blocked_reason: blockedReason });
        await this.cardStore.update(goalId, {
          status: 'blocked',
          error: blockedReason,
          status_text: blockedReason,
          result: {
            ...(this.cardStore.read(goalId)?.result ?? {}),
            planning: {
              status: 'blocked',
              blocked_reason: blockedReason,
              planner_declared_done: false,
              has_unfinished_child_work: false,
              resume_reason: 'non_actionable_continue',
              created_cards: [],
              updated_cards: [],
              summary: plannerResult.summary ?? null,
            },
          },
        });
        this.finishOpenPlannerRun(goalId, 'blocked');
        await this._stateMachine.transition('card_terminated', { goalId, reason: 'planner_non_actionable_continue' });
        return;
      }
      if (plannerResult.status === 'done' && !hasGoalDispatch && !hasUnfinishedChildWork) plannerDone = true; else { plannerDone = false; await this.cardStore.update(goalId, { error: null, result: { ...(this.cardStore.read(goalId)?.result ?? {}), planning: { status: 'continue', planner_declared_done: plannerResult.status === 'done', has_unfinished_child_work: hasUnfinishedChildWork, resume_reason: hasGoalDispatch ? 'dispatch_completed' : 'review_completed', created_cards: createdCardIds, updated_cards: updatedCardIds } } }); if (plannerResult.status === 'done' && !hasGoalDispatch && hasUnfinishedChildWork) { await this._stateMachine.transition('goal_exit', { goalId, reason: 'planner_done_with_unfinished_child_work' }); return; } }
      if (plannerDone) {
        const assessmentId = this.nextReviewerAssessmentId(goalId);
        const reviewerSessionId = this.reviewerSessionId(goalId, assessmentId);
        let reviewResult: ReviewerResult;
        try {
          reviewResult = await this.invokeReviewer(goalId, planCard.id, assessmentId, reviewerSessionId);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          const blockedReason = `Reviewer invocation failed before assessment output could be produced: ${errorMessage}`;
          this.emitRuntimeDiagnostic({ goal_id: goalId, phase: 'reviewer', error: err });
          this._eventLogger.appendEvent({ kind: 'runtime_diagnostic', goal_id: goalId, phase: 'reviewer', error_message: errorMessage });
          this._errorLogger.appendError({ message: errorMessage, goalId, phase: 'reviewer' });
          await this._stateMachine.transitionCard(goalId, 'block', { blocked_reason: blockedReason });
          await this.cardStore.update(goalId, {
            status: 'blocked',
            error: blockedReason,
            status_text: blockedReason,
            result: {
              ...(this.cardStore.read(goalId)?.result ?? {}),
              planning: {
                status: 'blocked',
                blocked_reason: blockedReason,
                resume_reason: 'reviewer_unavailable',
                failure_kind: 'reviewer_invocation_failed',
                created_cards: [],
                updated_cards: [],
              },
            },
          });
          this.finishOpenPlannerRun(goalId, 'blocked');
          await this._stateMachine.transition('card_terminated', { goalId, reason: 'reviewer_invocation_failed' });
          return;
        }
        const validation = this.validateReviewerAssessment(goalId, reviewResult.assessment);
        if (reviewResult.assessment.result === 'pass' && !validation.valid) {
          const invalidAssessment = this.buildReviewAssessment(goalId, assessmentId, reviewerSessionId, reviewResult.assessment, { result: 'needs_corrections', summary: `Reviewer pass rejected: ${validation.reason}`, achieved: [], issues: [{ summary: validation.reason ?? 'Reviewer evidence validation failed.', severity: 'blocker' as const }] });
          await this.persistReviewState(goalId, invalidAssessment);
          this.emit('review_failed', { goal_id: goalId, assessment: invalidAssessment });
          this._eventLogger.appendEvent({ kind: 'review_failed', goal_id: goalId, assessment: invalidAssessment });
          plannerDone = false;
          continue;
        }
        if (reviewResult.assessment.result === 'pass') {
          if (this.cardStore.read(goalId)?.status !== 'done') { await this._stateMachine.transitionCard(goalId, 'complete', { assessment: reviewResult.assessment }); }
          const assessment = this.buildReviewAssessment(goalId, assessmentId, reviewerSessionId, reviewResult.assessment);
          await this.persistReviewState(goalId, assessment);
          await this.cardStore.update(goalId, { completed_at: this.cardStore.read(goalId)?.completed_at ?? now(), result: { ...(this.cardStore.read(goalId)?.result ?? {}), planning: { status: 'done', created_cards: [], review_summary: reviewResult.assessment.summary } } });
          this.appendChildUnwindToolResult(goalId, 'done', reviewResult.assessment.summary);
          await this._stateMachine.transition('reviewer_finished', { goalId, reason: 'review_pass' });
          this.emit('goal_completed', { goal_id: goalId, assessment }); this._eventLogger.appendEvent({ kind: 'goal_completed', goal_id: goalId, assessment });
          if (goalId === PROJECT_CARD_ID) { const projectCard = this.cardStore.read(goalId); if (projectCard) this.emitProjectRunCompleted(projectCard, assessment); }
          return;
        } else {
          plannerDone = false;
          const failedAssessment = this.buildReviewAssessment(goalId, assessmentId, reviewerSessionId, reviewResult.assessment);
          await this.persistReviewState(goalId, failedAssessment);
          this.emit('review_failed', { goal_id: goalId, assessment: failedAssessment }); this._eventLogger.appendEvent({ kind: 'review_failed', goal_id: goalId, assessment: failedAssessment });
        }
      }
    }
    if (this._shuttingDown) { this.emit('dispatch_interrupted', { goal_id: goalId, reason: 'shutdown' }); this._eventLogger.appendEvent({ kind: 'dispatch_interrupted', goal_id: goalId, reason: 'shutdown' }); }
    } finally {
      this._dispatchInFlight.delete(goalId);
    }
  }

  private getPendingActivationCards(goalId: string): CardRecord[] {
    const state = readRuntimeState(this.projectRoot);
    const activations = (state?.runtime_activations ?? [])
      .filter((activation) => activation.parent_card_id === goalId && ['pending', 'claimed', 'running'].includes(activation.status))
      .sort((a, b) => a.requested_at.localeCompare(b.requested_at));
    return activations
      .map((activation) => this.cardStore.read(activation.child_card_id))
      .filter((card): card is CardRecord => Boolean(card));
  }

  private async dispatchPendingActivations(goalId: string): Promise<{ dispatchedGoal: boolean; executedTerminal: boolean; failed: boolean }> {
    let activationCards = this.getPendingActivationCards(goalId); const goalCard = this.cardStore.read(goalId); let dispatchedGoal = false; let executedTerminal = false; let failed = false;
    while (activationCards.length > 0 && !this._shuttingDown) {
      if (this._paused) return { dispatchedGoal, executedTerminal, failed };
      for (const card of activationCards) {
        if (this._shuttingDown || this._paused) return { dispatchedGoal, executedTerminal, failed };
        const callerEdge = this.findCallerEdge(card.id);
        if (card.type === 'goal') {
          await this.dispatchGoal(card.id);
          const completedCard = this.cardStore.read(card.id); const outcome = completedCard?.status === 'done' ? 'done' : completedCard?.status === 'blocked' ? 'blocked' : completedCard?.status === 'cancelled' ? 'cancelled' : 'failed';
          this.appendChildUnwindToolResult(card.id, outcome, `Child goal ${card.id} finished with status ${completedCard?.status ?? 'unknown'}.`);
          dispatchedGoal = true; if (outcome !== 'done') return { dispatchedGoal, executedTerminal, failed }; continue;
        }
        {
          const startAction: RuntimeCardAction | null = (STARTABLE_STATES as readonly CardStatus[]).includes(card.status)
            ? 'start'
            : (RESTARTABLE_STATES as readonly CardStatus[]).includes(card.status)
              ? 'restart'
              : card.status === 'active'
                ? 'reviewer_repair_resume'
                : card.status === 'running'
                  ? null
                  : 'restart';
          const transitioned = startAction === null
            ? true
            : await this._stateMachine.transitionCard(card.id, startAction, { goalId, reason: 'pending_activation_dispatch' });
          if (!transitioned) { failed = true; return { dispatchedGoal, executedTerminal, failed }; }
        }
        { const startedAt = now(); updateRuntimeState(this.projectRoot, { current_card_id: card.id, active_card_run: { card_id: card.id, card_type: card.type, runtime_status: 'running', phase: 'executor', caller_session_id: callerEdge?.callerSessionId ?? `planner:${goalId}`, caller_tool_call_id: callerEdge?.callerToolCallId ?? null, executor_session_id: `executor-${card.id}`, correction_attempts: 0, started_at: startedAt, last_turn_at: startedAt } }); }
        let execResult;
        try {
          const executorContract = createExecutorContract({ cardId: card.id, goalId });
          let executorPrompt = buildExecutorPrompt(executorContract, card.type);
          try { if (this._skillsEngine) { const instructionContent = await this._skillsEngine.loadInstructions('executor'); const skillsContent = await this._skillsEngine.selectAndFormat({ goalDescription: goalCard?.description ?? '', cardDescription: card.description, tags: card.tags, filePaths: [], availableTools: ['list_project_files', 'read_project_file', 'write_project_file', 'run_project_command', 'load_skill', 'mcp_tool_call'], targetRole: 'executor' }); const combinedSkills = [instructionContent, skillsContent].filter(Boolean).join('\\n\\n'); if (combinedSkills) executorPrompt = buildExecutorPrompt(executorContract, card.type, combinedSkills); } } catch { void 0; }
          executorPrompt += `\n\n${this.buildCardContextBlock(card.id, goalId)}`;
          const result = this.agentRuntime.invokeExecutor({ cardId: card.id, goalId, systemPrompt: executorPrompt, contract: executorContract }); execResult = result instanceof Promise ? await result : result;
        } catch (err) { const errorMessage = err instanceof Error ? err.message : String(err); this.emitRuntimeDiagnostic({ card_id: card.id, goal_id: goalId, phase: 'executor', error: err }); this._eventLogger.appendEvent({ kind: 'runtime_diagnostic', card_id: card.id, goal_id: goalId, phase: 'executor', error_message: errorMessage }); this._errorLogger.appendError({ message: errorMessage, cardId: card.id, goalId, phase: 'executor' }); await this._stateMachine.transitionCard(card.id, 'fail', { reason: 'executor_exception', error: errorMessage }); this.appendChildUnwindToolResult(card.id, 'failed', `Terminal card ${card.id} execution failed before producing a result.`); this.emit('card_failed', { card_id: card.id, goal_id: goalId }); this._eventLogger.appendEvent({ kind: 'card_failed', card_id: card.id, goal_id: goalId }); failed = true; return { dispatchedGoal, executedTerminal, failed }; }
        const acceptedAt = now();
        const lastSessionId = (this.agentRuntime as { getLastSessionId?: (role: 'executor', goalId: string, cardId: string) => string | null }).getLastSessionId?.('executor', goalId, card.id) ?? readRuntimeState(this.projectRoot)?.active_card_run?.executor_session_id ?? readRuntimeState(this.projectRoot)?.current_agent_session_id ?? null;
        const latestSelfReport = {
          result: execResult.status,
          outcome: execResult.status,
          summary: execResult.summary ?? execResult.error ?? execResult.status_text,
          status_text: execResult.status_text,
          at: acceptedAt,
        };
        const artifactRegistrationErrors: string[] = []; const attachmentRegistrationErrors: string[] = []; const ignoredArtifactRegistrations: string[] = []; const ignoredAttachmentRegistrations: string[] = [];
        if (execResult.artifacts && execResult.artifacts.length > 0) for (const artDef of execResult.artifacts) { const sourcePath = artDef.sourceFile ?? artDef.path ?? ''; const resolved = resolveRegisterableProcessMetadataSource(this.projectRoot, sourcePath); if ('ignored' in resolved) { ignoredArtifactRegistrations.push(resolved.ignored); continue; } try { this.registerArtifactOnCard(card.id, { type: artDef.type, description: artDef.description, retain: artDef.retain }, resolved.sourceFile); } catch (err) { const errorMessage = err instanceof Error ? err.message : String(err); artifactRegistrationErrors.push(errorMessage); this.emitRuntimeDiagnostic({ card_id: card.id, goal_id: goalId, phase: 'artifact_registration', error: err }); this._eventLogger.appendEvent({ kind: 'runtime_diagnostic', card_id: card.id, phase: 'artifact_registration', error_message: errorMessage }); this._errorLogger.appendError({ message: errorMessage, cardId: card.id, goalId, phase: 'artifact_registration' }); } }
        if (execResult.attachments && execResult.attachments.length > 0) for (const attDef of execResult.attachments) { const sourcePath = attDef.sourceFile ?? attDef.path ?? ''; const resolved = resolveRegisterableProcessMetadataSource(this.projectRoot, sourcePath); if ('ignored' in resolved) { ignoredAttachmentRegistrations.push(resolved.ignored); continue; } try { this.registerAttachmentOnCard(card.id, { mime: attDef.mime, title: attDef.title, description: attDef.description }, resolved.sourceFile); } catch (err) { const errorMessage = err instanceof Error ? err.message : String(err); attachmentRegistrationErrors.push(errorMessage); this.emitRuntimeDiagnostic({ card_id: card.id, goal_id: goalId, phase: 'attachment_registration', error: err }); this._eventLogger.appendEvent({ kind: 'runtime_diagnostic', card_id: card.id, phase: 'attachment_registration', error_message: errorMessage }); this._errorLogger.appendError({ message: errorMessage, cardId: card.id, goalId, phase: 'attachment_registration' }); } }
        if (ignoredArtifactRegistrations.length > 0 || ignoredAttachmentRegistrations.length > 0) await this.cardStore.update(card.id, { result: { ...(this.cardStore.read(card.id)?.result ?? {}), evidence_registration_ignored: { artifacts: ignoredArtifactRegistrations, attachments: ignoredAttachmentRegistrations } } });
        const registrationFailed = execResult.status === 'done' && (artifactRegistrationErrors.length > 0 || attachmentRegistrationErrors.length > 0);
        const registrationError = registrationFailed ? `Completion blocked by evidence registration failure. Artifacts: ${artifactRegistrationErrors.join(' | ') || 'none'}. Attachments: ${attachmentRegistrationErrors.join(' | ') || 'none'}.` : null;
        const parkedForVerification = !registrationFailed && execResult.fallback_with_evidence !== null;
        let outcome: ActivationCompletionOutcome;
        let transitioned: boolean;
        if (parkedForVerification) {
          outcome = 'needs_verification';
          transitioned = await this._stateMachine.transitionCard(card.id, 'executor_partial_finish', { goalId, reason: `fallback_with_evidence:${execResult.fallback_with_evidence!.reason}` });
        } else {
          const finalStatus: CardStatus = registrationFailed ? 'failed' : execResult.status;
          outcome = finalStatus === 'done' ? 'done' : 'failed';
          transitioned = await this._stateMachine.transitionCard(card.id, 'executor_finish', { goalId, finalStatus, reason: registrationFailed ? 'evidence_registration_failed' : undefined });
        }
        if (!transitioned) { failed = true; return { dispatchedGoal, executedTerminal, failed }; }
        const terminalCompletedAt = outcome === 'done' || outcome === 'failed' ? now() : null;
        await this.cardStore.update(card.id, {
          result: { ...(this.cardStore.read(card.id)?.result ?? {}), ...(execResult.result ?? {}), executor: execResult.result ?? null, latest_self_report: latestSelfReport, ...(registrationFailed ? { evidence_registration_failures: { artifacts: artifactRegistrationErrors, attachments: attachmentRegistrationErrors } } : {}), ...(parkedForVerification ? { fallback_with_evidence: execResult.fallback_with_evidence } : {}) },
          ...(terminalCompletedAt ? { completed_at: this.cardStore.read(card.id)?.completed_at ?? terminalCompletedAt } : {}),
          error: registrationError ?? execResult.error ?? null,
          status_text: execResult.status_text,
          status_text_updated_at: acceptedAt,
          status_text_author_session_id: lastSessionId,
          latest_self_report: latestSelfReport,
        });
        if (registrationFailed) { execResult.status = 'failed'; execResult.error = registrationError ?? execResult.error; }
        executedTerminal = true;
        this.appendChildUnwindToolResult(card.id, outcome, `Terminal card ${card.id} finished with outcome ${outcome}.`);
        if (outcome === 'failed') { this.emit('card_failed', { card_id: card.id, goal_id: goalId }); this._eventLogger.appendEvent({ kind: 'card_failed', card_id: card.id, goal_id: goalId }); failed = true; return { dispatchedGoal, executedTerminal, failed }; }
      }
      activationCards = this.getPendingActivationCards(goalId);
    }
    return { dispatchedGoal, executedTerminal, failed };
  }

  async invokeReviewer(goalId: string, _planCardId: string, assessmentId: string, reviewerSessionId: string): Promise<ReviewerResult> {
    const reviewerContract = createReviewerContract({ goalId, assessmentId });
    let reviewerPrompt = buildReviewerPrompt(reviewerContract);
    try { if (this._skillsEngine) { const goalCard = this.cardStore.read(goalId); const instructionContent = await this._skillsEngine.loadInstructions('reviewer'); const skillsContent = await this._skillsEngine.selectAndFormat({ goalDescription: goalCard?.description ?? '', cardDescription: goalCard?.description ?? '', tags: goalCard?.tags ?? [], filePaths: [], availableTools: ['list_project_files', 'read_project_file', 'load_skill', 'mcp_tool_call'], targetRole: 'reviewer' }); const combinedSkills = [instructionContent, skillsContent].filter(Boolean).join('\n\n'); if (combinedSkills) reviewerPrompt = buildReviewerPrompt(reviewerContract, combinedSkills); } } catch { void 0; }
    reviewerPrompt += `\n\n${this.buildGoalContextBlock(goalId)}\n\n## Goal Evidence Context\n${this.buildGoalEvidenceContext(goalId)}`;
    const startedAt = now();
    const goalCard = this.cardStore.read(goalId);
    await this._stateMachine.transition('reviewer_started', { goalId, reviewerSessionId, activeCardRun: { card_id: goalId, card_type: goalCard?.type ?? 'goal', runtime_status: 'running', phase: 'reviewer', caller_session_id: null, caller_tool_call_id: null, planner_session_id: `planner:${goalId}`, reviewer_session_id: reviewerSessionId, correction_attempts: 0, started_at: startedAt, last_turn_at: startedAt } });
    const result = await this.agentRuntime.invokeReviewer({ goalId, systemPrompt: reviewerPrompt, contextMessages: [], assessmentId, reviewerSessionId, contract: reviewerContract });
    this.emit('review_complete', { goal_id: goalId, assessment: result.assessment }); this._eventLogger.appendEvent({ kind: 'review_complete', goal_id: goalId, assessment: result.assessment }); return result;
  }

  async applyPlannerResult(goalId: string, plannerResult: PlannerResult): Promise<void> {
    if (plannerResult.created_cards) {
      for (const cardDef of plannerResult.created_cards) {
        if (this.cardStore.read(cardDef.id ?? '')) continue;
        this.cardStore.create({ id: cardDef.id, type: cardDef.type as CardRecord['type'], parent: goalId, title: cardDef.title, description: cardDef.description, status: cardDef.status as CardRecord['status'], depends_on: cardDef.depends_on, priority: cardDef.priority, tags: cardDef.tags ?? [], urgency: 'normal', created_by: 'planner', blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0, depth: 0 });
      }
    }
    if (plannerResult.updated_cards) {
      for (const update of plannerResult.updated_cards) {
        const trackedChanges: Partial<CardRecord> = {};
        if (update.title !== undefined) trackedChanges.title = update.title;
        if (update.description !== undefined) trackedChanges.description = update.description;
        if (update.acceptance !== undefined) trackedChanges.acceptance = update.acceptance;
        if (Object.keys(trackedChanges).length > 0) this.cardStore.mutateCard(update.id, trackedChanges, { actor: 'planner', surface: 'runtime', reason: 'planner updated card' });
        if (update.status !== undefined) {
          const requestedStatus = update.status as CardStatus;
          await this._stateMachine.transitionCard(update.id, 'planner_set_status', { requestedStatus });
        }
      }
    }
  }
  async simulateCrash(): Promise<void> { const allCards = this.cardStore.list(); for (const card of allCards) if (card.status === 'active' || card.status === 'running') { await this._stateMachine.transitionCard(card.id, 'crash_recovery_drop_to_backlog'); } this._running = false; }
  runCleanup(options?: { stashMaxAgeMs?: number; processMaxAgeMs?: number; previewsMaxAgeMs?: number; uploadsMaxAgeMs?: number; }) { return cleanAll(saivageWorkDir(this.projectRoot), this.cardStore, options); }
  getState(): RuntimeState | null { return readRuntimeState(this.projectRoot); }


}
