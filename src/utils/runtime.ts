import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import { existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import type {
  FreezeManifest,
  CardRecord,
  RuntimeState,
  RuntimeStatus as RStatus,
  EventKind,
  LoggedEvent,
  HandoffSummary,
  FreezeProcessEntry,
  ReviewAssessment,
  PlannerDispatchRecord,
} from '../schemas/types.js';
import { CardStore } from './card-store.js';
import {
  initRuntimeState,
  readRuntimeState,
  saveRuntimeState,
  updateRuntimeState,
} from './runtime-state.js';
import {
  saveFreezeManifest,
  readFreezeManifest,
  clearFreezeManifest,
} from './freeze-manifest.js';
import { acquireLock, releaseLock } from './runtime-lock.js';
import { FakeAgentAdapter, type FakeAgentConfig } from './fake-agent.js';
import type { AgentRuntime } from '../agents/agent-runtime.js';
import type { PlannerResult, ReviewerResult } from '../agents/result-parser.js';
import {
  buildPlannerPrompt,
  buildExecutorPrompt,
  buildReviewerPrompt,
} from '../agents/system-prompt.js';
import { SkillsEngine } from '../agents/skills-engine.js';
import {
  killAllRunning,
  listProcesses,
  type ProcessListFilter,
} from './process-runner.js';
import { cleanAll, cleanStaleStash, cleanStalePreviews, cleanStaleUploads } from './cleanup.js';
import { registerArtifact, registerAttachment } from './artifacts.js';
import type { ProcessRecord } from '../schemas/types.js';
import { EventLogger } from './event-logger.js';
import { ErrorLogger } from './error-logger.js';
import { EventBus } from './event-bus.js';
import { PlannerControlService } from './planner-control.js';
import {
  StuckAgentSupervisor,
  DEFAULT_SUPERVISOR_CONFIG,
  type SupervisorConfig,
  type SupervisorDeps,
} from './stuck-agent-supervisor.js';

export type RuntimeStatus = RStatus;
export interface RuntimeConfig { projectRoot: string; fakeAgentConfig: FakeAgentConfig; skillsEngine?: SkillsEngine; eventLogger?: EventLogger; errorLogger?: ErrorLogger; maxGoalDepth?: number; supervisorConfig?: Partial<SupervisorConfig>; autoDispatchBacklog?: boolean; continuousImprovement?: boolean; }
const TERMINAL_TYPES: ReadonlySet<string> = new Set(['architecture', 'code', 'test', 'doc', 'data', 'research', 'ops']);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);
function isTerminal(card: CardRecord): boolean { return TERMINAL_TYPES.has(card.type); }
function buildReadyQueue(cards: CardRecord[]): CardRecord[] { return cards.filter((c) => { if (c.status !== 'backlog' && c.status !== 'active') return false; if (c.depends_on.length === 0) return true; return c.depends_on.every((depId) => { const dep = cards.find((cc) => cc.id === depId); return dep && dep.status === 'done'; }); }).sort((a, b) => { if (a.depends_on.length !== b.depends_on.length) return a.depends_on.length - b.depends_on.length; if (a.priority !== b.priority) return a.priority - b.priority; if (a.status !== b.status) return a.status === 'backlog' ? -1 : 1; return 0; }); }
function now(): string { return new Date().toISOString(); }
function buildImprovementDirective(completedGoals: CardRecord[]): string { const goalSummaries = completedGoals.map((g) => `- **${g.title}** (${g.id}): ${g.description || 'No description'}
  Status: ${g.status}
  Acceptance: ${g.acceptance || 'Not specified'}`).join('\n'); return ['## Continuous Improvement Directive', '', 'This is an automated improvement invocation. All current top-level goals have reached', 'terminal states (done, failed, or cancelled). The system is idle.', '', '### Completed Goals', '', goalSummaries, '', '### Instructions', '', '1. Review the completed goals above.', '2. Consider what improvements, new features, or bug fixes could enhance the project.', '3. Propose new goal cards for any worthwhile improvements you identify.', '4. You may also create cards to revisit failed goals with a revised approach.', '5. If no improvements are warranted, set declare_done to true to stay idle.', '6. Be incremental — propose 1-3 goals at most per invocation.', '', 'This is a depth-0 (project-level) planning session. The system will invoke this', 'improvement cycle again after all proposed goals complete.', ].join('\n'); }
function saivageWorkDir(projectRoot: string): string { return join(projectRoot, '.saivage-work'); }
function eventsLogPath(projectRoot: string): string { return join(projectRoot, '.saivage', 'runtime', 'events.jsonl'); }
function resolveEvidenceSourcePath(projectRoot: string, filePath: string): string { if (!filePath) return filePath; return existsSync(filePath) ? filePath : resolve(projectRoot, filePath); }
const TRACKED_EVENT_KINDS: ReadonlySet<string> = new Set(['started', 'shutdown', 'paused', 'resumed', 'frozen', 'resumed_from_freeze', 'goal_completed', 'goal_failed', 'escalation', 'card_failed', 'review_complete', 'review_failed', 'plan_updated', 'error', 'dispatch_blocked', 'dispatch_interrupted', 'session_started', 'model_selected', 'invocation_succeeded', 'invocation_failed', 'retry_attempted', 'compaction_triggered', 'self_check_triggered', 'stuck_supervisor_started', 'stuck_supervisor_stopped', 'stuck_verdict', 'abort_target_selected', 'force_cancel_sent', 'session_cancelled', 'session_force_cancelled', 'improvement_invoked']);

export class Runtime extends EventEmitter {
  readonly projectRoot: string; readonly cardStore: CardStore; readonly agentRuntime: AgentRuntime; readonly eventBus: EventBus; readonly plannerControl: PlannerControlService;
  private _status: RuntimeStatus = 'idle'; private _paused = false; private _running = false; private _shuttingDown = false; private _skillsEngine: SkillsEngine | null = null; private _eventLogger: EventLogger; private _ownsEventLogger: boolean; private _errorLogger: ErrorLogger; private _ownsErrorLogger: boolean; readonly runningProcesses: Set<string> = new Set(); private _supervisor: StuckAgentSupervisor; private _continuousImprovement: boolean; private _autoDispatchBacklog: boolean; private _improvementDispatchInProgress = false; private _resumeHandoffContext: string | null = null;

  constructor(config: RuntimeConfig, agentRuntime?: AgentRuntime) {
    super(); this.projectRoot = config.projectRoot; this.cardStore = new CardStore(config.projectRoot, config.maxGoalDepth); this.agentRuntime = agentRuntime ?? new FakeAgentAdapter(config.fakeAgentConfig); this._skillsEngine = config.skillsEngine ?? new SkillsEngine({ projectRoot: config.projectRoot }); this.eventBus = new EventBus(); this.plannerControl = new PlannerControlService(config.projectRoot); this._continuousImprovement = config.continuousImprovement ?? false; this._autoDispatchBacklog = config.autoDispatchBacklog ?? false;
    if (config.eventLogger) { this._eventLogger = config.eventLogger; this._ownsEventLogger = false; } else { this._eventLogger = new EventLogger(join(config.projectRoot, '.saivage')); this._ownsEventLogger = true; }
    if (config.errorLogger) { this._errorLogger = config.errorLogger; this._ownsErrorLogger = false; } else { this._errorLogger = new ErrorLogger(join(config.projectRoot, '.saivage')); this._ownsErrorLogger = true; }
    const supervisorDeps: SupervisorDeps = { getRecentLogs: (maxLines: number) => { try { const logPath = eventsLogPath(this.projectRoot); if (!existsSync(logPath)) return ''; const raw = readFileSync(logPath, 'utf-8'); const allLines = raw.split('\n').filter(Boolean); return allLines.slice(-maxLines).join('\n'); } catch { return ''; } }, getActiveSessions: () => { try { const handoffs = this.agentRuntime.getActiveSessionHandoffs(); if (!(handoffs instanceof Promise)) { const active = handoffs.map((handoff) => ({ role: handoff.role, sessionId: handoff.session_id })); if (active.length > 0) return active; } } catch {} try { const state = readRuntimeState(this.projectRoot); if (state && state.current_agent_session_id) { const sessionId = state.current_agent_session_id; let role = 'executor'; if (sessionId.startsWith('planner-')) role = 'planner'; else if (sessionId.startsWith('reviewer-')) role = 'reviewer'; return [{ role, sessionId }]; } } catch {} return []; }, abortSession: (sessionId: string) => { void this.agentRuntime.cancelSession(sessionId); }, forceCancelSession: (sessionId: string) => { void this.agentRuntime.forceCancelSession(sessionId); }, emitEvent: (kind: string, data: Record<string, unknown>) => { this.emit(kind, data); this._eventLogger.appendEvent({ kind: kind as never, ...data } as never); }, isShuttingDown: () => this._shuttingDown };
    const mergedSupervisorConfig: SupervisorConfig = { ...DEFAULT_SUPERVISOR_CONFIG, ...config.supervisorConfig };
    this._supervisor = new StuckAgentSupervisor(mergedSupervisorConfig, supervisorDeps);
  }

  get status(): RuntimeStatus { return this._status; } get paused(): boolean { return this._paused; } get eventLogger(): EventLogger { return this._eventLogger; } get errorLogger(): ErrorLogger { return this._errorLogger; } get supervisor(): StuckAgentSupervisor { return this._supervisor; }
  emit(eventName: string, ...args: unknown[]): boolean { const emitted = super.emit(eventName, ...args); if (TRACKED_EVENT_KINDS.has(eventName)) { const data = args[0] && typeof args[0] === 'object' ? (args[0] as Record<string, unknown>) : { raw: args[0] }; this.eventBus.emit({ id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind: eventName as EventKind, timestamp: new Date().toISOString(), ...data } as unknown as LoggedEvent); } return emitted; }
  trackProcessStarted(procId: string): void { this.runningProcesses.add(procId); this._syncRunningProcesses(); }
  trackProcessStopped(procId: string): void { this.runningProcesses.delete(procId); this._syncRunningProcesses(); }
  listRunningProcesses(filter?: ProcessListFilter): ProcessRecord[] { return listProcesses(this.projectRoot, { ...filter, status: 'running' }); }
  private _syncRunningProcesses(): void { try { updateRuntimeState(this.projectRoot, { running_processes: Array.from(this.runningProcesses) }); } catch {} }
  registerArtifactOnCard(cardId: string, artifact: { type: 'model' | 'data' | 'config' | 'log' | 'report' | 'other'; description: string; retain: boolean }, sourceFile: string) { return registerArtifact(saivageWorkDir(this.projectRoot), this.cardStore, cardId, artifact, resolveEvidenceSourcePath(this.projectRoot, sourceFile)); }
  registerAttachmentOnCard(cardId: string, attachment: { mime: string; title: string; description?: string }, sourceFile: string) { return registerAttachment(saivageWorkDir(this.projectRoot), this.cardStore, cardId, attachment, resolveEvidenceSourcePath(this.projectRoot, sourceFile)); }

  private buildParentResumeContext(goalId: string, plannerFrameId: string): string {
    const dispatches = this.plannerControl.listDispatches({ parent_frame_id: plannerFrameId }).filter((dispatch) => dispatch.completion !== null);
    const reviewState = this.cardStore.read(goalId)?.result?.review as Record<string, unknown> | undefined;
    return JSON.stringify({ goal_id: goalId, child_dispatches: dispatches.map((dispatch) => ({ dispatch_id: dispatch.dispatch_id, target_card_id: dispatch.target_card_id, target_kind: dispatch.target_kind, status: dispatch.status, completion: dispatch.completion })), latest_review: reviewState ?? null }, null, 2);
  }

  private validateReviewerAssessment(goalId: string, assessment: ReviewerResult['assessment']): { valid: boolean; reason?: string } {
    if (assessment.evidence_card_ids.length === 0) return { valid: false, reason: 'Reviewer assessment must cite at least one evidence_card_id.' };
    for (const evidenceId of assessment.evidence_card_ids) {
      const card = this.cardStore.read(evidenceId);
      if (!card) return { valid: false, reason: `Reviewer cited missing evidence card '${evidenceId}'.` };
      if (card.status !== 'done') return { valid: false, reason: `Reviewer cited non-complete evidence card '${evidenceId}' with status '${card.status}'.` };
      if ((card.artifacts?.length ?? 0) === 0 && (card.attachments?.length ?? 0) === 0 && !card.result) return { valid: false, reason: `Reviewer cited card '${evidenceId}' without durable result, artifact, or attachment evidence.` };
    }
    return { valid: true };
  }

  private persistReviewState(goalId: string, assessment: ReviewAssessment): void {
    const goal = this.cardStore.read(goalId);
    this.cardStore.update(goalId, { result: { ...(goal?.result ?? {}), review: assessment } });
  }

  consumeResumeHandoffContext(): string | null { const ctx = this._resumeHandoffContext; this._resumeHandoffContext = null; return ctx; }
  emitAgentEvent(name: string, data: Record<string, unknown>): void { if (name === 'session_started' && typeof data.session_id === 'string') { try { updateRuntimeState(this.projectRoot, { current_agent_session_id: data.session_id }); } catch {} } this.emit(name, data); }

  async startup(): Promise<void> { if (this._running) throw new Error('Runtime is already running.'); let state = readRuntimeState(this.projectRoot); if (!state) state = initRuntimeState(this.projectRoot); acquireLock(this.projectRoot); this.performCrashRecovery(); if (state.running_processes && state.running_processes.length > 0) { this.runningProcesses.clear(); this._syncRunningProcesses(); } initRuntimeState(this.projectRoot); this._status = 'idle'; this._paused = false; this._running = true; this._shuttingDown = false; this.emit('started', { projectRoot: this.projectRoot }); this._eventLogger.appendEvent({ kind: 'started', project_root: this.projectRoot }); this._supervisor.start(); if (this._autoDispatchBacklog) void this._autoDispatchFirstBacklogGoal(); void this._checkContinuousImprovement(); }
  async shutdown(): Promise<void> { if (!this._running) return; if (this._status === 'frozen') { try { releaseLock(this.projectRoot); } catch {} this._running = false; this._shuttingDown = false; this._status = 'idle'; this.emit('shutdown'); this._eventLogger.appendEvent({ kind: 'shutdown' }); if (this._ownsEventLogger) this._eventLogger.close(); if (this._ownsErrorLogger) this._errorLogger.close(); return; } this._shuttingDown = true; this._running = false; this._supervisor.stop(); try { const killedIds = await killAllRunning(this.projectRoot); for (const id of killedIds) this.runningProcesses.delete(id); } catch {} try { saveRuntimeState(this.projectRoot, { status: 'idle', project_id: 'project', pid: process.pid, started_at: now(), current_card_id: null, current_agent_session_id: null, paused: false, paused_at: null, queue: [], running_processes: [], updated_at: now() }); } catch {} try { releaseLock(this.projectRoot); } catch {} try { cleanAll(saivageWorkDir(this.projectRoot), this.cardStore); } catch {} this._status = 'idle'; this.emit('shutdown'); this._eventLogger.appendEvent({ kind: 'shutdown' }); if (this._ownsEventLogger) this._eventLogger.close(); if (this._ownsErrorLogger) this._errorLogger.close(); }
  pause(): void { this._paused = true; try { updateRuntimeState(this.projectRoot, { status: 'paused', paused: true, paused_at: now() }); } catch {} this.emit('paused'); this._eventLogger.appendEvent({ kind: 'paused' }); }
  resume(): void { this._paused = false; try { updateRuntimeState(this.projectRoot, { status: 'idle', paused: false, paused_at: null }); } catch {} this.emit('resumed'); this._eventLogger.appendEvent({ kind: 'resumed' }); }
  private buildFreezeProcessEntries(procIds: string[], defaultAction: 'kill' | 'reattach' | 'detach' = 'reattach'): FreezeProcessEntry[] { return procIds.map((id) => ({ id, action: defaultAction })); }
  freeze(reason?: string, defaultProcessAction: 'kill' | 'reattach' | 'detach' = 'reattach'): FreezeManifest { if (this._status === 'frozen') { const existing = readFreezeManifest(this.projectRoot); if (existing) return existing; } this._status = 'frozen'; this._paused = true; const state = readRuntimeState(this.projectRoot); const frozenAt = new Date(); const freezeId = `freeze-${frozenAt.toISOString().replace(/[:.]/g, '-')}`; let handoffSummaries: HandoffSummary[] = []; try { const raw = this.agentRuntime.getActiveSessionHandoffs(); handoffSummaries = raw instanceof Promise ? [] : raw; } catch {} const processIds = state?.running_processes ?? []; const runningProcesses = this.buildFreezeProcessEntries(processIds, defaultProcessAction); const manifest: FreezeManifest = { freeze_id: freezeId, reason: reason ?? 'operator requested freeze', created_at: frozenAt.toISOString(), status: 'frozen', project_id: 'project', pid: process.pid, started_at: state?.started_at ?? frozenAt.toISOString(), current_card_id: state?.current_card_id ?? null, current_agent_session_id: state?.current_agent_session_id ?? null, queue: state?.queue ?? [], running_processes: runningProcesses, handoff_summaries: handoffSummaries, schema_version: 1, runtime_version: '0.1.0' }; saveFreezeManifest(this.projectRoot, manifest); try { saveRuntimeState(this.projectRoot, { status: 'frozen', project_id: 'project', pid: process.pid, started_at: state?.started_at ?? frozenAt.toISOString(), current_card_id: state?.current_card_id ?? null, current_agent_session_id: state?.current_agent_session_id ?? null, paused: true, paused_at: frozenAt.toISOString(), queue: state?.queue ?? [], running_processes: processIds, updated_at: frozenAt.toISOString() }); } catch {} this.emit('frozen', { freeze_id: manifest.freeze_id, reason: manifest.reason }); this._eventLogger.appendEvent({ kind: 'frozen' as never }); return manifest; }
  resumeFromFreeze(): { freeze_id: string; restored_queue: string[]; restored_processes: string[]; restored_card_id: string | null } { const manifest = readFreezeManifest(this.projectRoot); if (!manifest) throw new Error('Cannot resume: no freeze manifest found. The runtime is not frozen.'); if (manifest.schema_version > 1) throw new Error(`Cannot resume: freeze manifest schema version ${manifest.schema_version} is newer than the supported version 1. Upgrade Saivage to resume this freeze.`); const currentVersion = '0.1.0'; if (manifest.runtime_version !== currentVersion) console.warn(`Resuming from freeze created by runtime version ${manifest.runtime_version} with current version ${currentVersion}. State may differ.`); this._status = 'idle'; this._paused = false; const processIds = manifest.running_processes.map((p) => p.id); try { saveRuntimeState(this.projectRoot, { status: 'idle', project_id: 'project', pid: process.pid, started_at: manifest.started_at, current_card_id: manifest.current_card_id, current_agent_session_id: manifest.current_agent_session_id, paused: false, paused_at: null, queue: manifest.queue, running_processes: processIds, updated_at: new Date().toISOString() }); } catch {} this.runningProcesses.clear(); for (const procId of processIds) this.runningProcesses.add(procId); const handoffSummaries = manifest.handoff_summaries ?? []; if (handoffSummaries.length > 0 && manifest.current_agent_session_id) { this._resumeHandoffContext = handoffSummaries.map((h) => `[Handoff] Session: ${h.session_id}, Role: ${h.role}, Last action: ${h.last_action}, Next action: ${h.next_action}, Context: ${h.context_summary}`).join('\n'); } clearFreezeManifest(this.projectRoot); this.emit('resumed_from_freeze', { freeze_id: manifest.freeze_id }); this._eventLogger.appendEvent({ kind: 'resumed_from_freeze' as never }); return { freeze_id: manifest.freeze_id, restored_queue: manifest.queue, restored_processes: processIds, restored_card_id: manifest.current_card_id }; }
  performCrashRecovery(): void { const allCards = this.cardStore.list(); for (const card of allCards) if (card.status === 'active' || card.status === 'running') this.cardStore.setStatus(card.id, 'backlog'); const tmpRuntimeDir = join(this.projectRoot, '.saivage-work', 'tmp', 'runtime'); if (existsSync(tmpRuntimeDir)) { try { const entries = readdirSync(tmpRuntimeDir); for (const entry of entries) { if (entry === 'runtime.lock') continue; if (entry.endsWith('.tmp') || entry.endsWith('.tmp.') || entry.includes('.tmp.')) { try { rmSync(join(tmpRuntimeDir, entry), { recursive: true, force: true }); } catch {} } } } catch {} } try { cleanStaleStash(saivageWorkDir(this.projectRoot), 24 * 60 * 60 * 1000); } catch {} try { cleanStalePreviews(saivageWorkDir(this.projectRoot), 24 * 60 * 60 * 1000); } catch {} try { cleanStaleUploads(saivageWorkDir(this.projectRoot), 24 * 60 * 60 * 1000); } catch {} }
  getReadyQueue(goalId: string): CardRecord[] { const allCards = this.cardStore.list(); const descendantIds = new Set(this.cardStore.getDescendantIds(goalId)); descendantIds.add(goalId); return buildReadyQueue(allCards.filter((c) => descendantIds.has(c.id) && isTerminal(c))); }

  async dispatchGoal(goalId: string): Promise<void> {
    if (this._paused) { this.emit('dispatch_blocked', { reason: 'paused', goalId }); this._eventLogger.appendEvent({ kind: 'dispatch_blocked', reason: 'paused', goal_id: goalId }); return; }
    let planCard: CardRecord;
    try { const result = this.cardStore.activateGoal(goalId); planCard = result.goal; updateRuntimeState(this.projectRoot, { status: 'running', current_card_id: goalId, queue: this.getReadyQueue(goalId).map((c) => c.id) }); } catch (err) { const errorMessage = err instanceof Error ? err.message : String(err); this.emit('error', { goalId, phase: 'activate', error: err }); this._eventLogger.appendEvent({ kind: 'error', goal_id: goalId, phase: 'activate', error_message: errorMessage }); this._errorLogger.appendError({ message: errorMessage, goalId, phase: 'activate' }); return; }
    const plannerScope = goalId === 'project' ? 'project' : 'goal'; let plannerFrame = this.plannerControl.ensureFrame(planCard.id, plannerScope); let plannerDone = false; const MAX_ITERATIONS = 50;
    for (let iter = 0; iter < MAX_ITERATIONS && !plannerDone && !this._shuttingDown; iter++) {
      if (this._paused) { this.emit('dispatch_blocked', { reason: 'paused', goalId }); this._eventLogger.appendEvent({ kind: 'dispatch_blocked', reason: 'paused', goal_id: goalId }); updateRuntimeState(this.projectRoot, { status: 'paused' }); return; }
      plannerFrame = this.plannerControl.updateFrame(plannerFrame.frame_id, { status: 'running' });
      let plannerResult: PlannerResult;
      try {
        const goalCardForDepth = this.cardStore.read(goalId); const currentDepth = goalCardForDepth?.depth; const maxDepth = this.cardStore.maxDepth; let plannerPrompt = buildPlannerPrompt(undefined, currentDepth, maxDepth);
        const resumeContext = this.buildParentResumeContext(goalId, plannerFrame.frame_id);
        plannerPrompt += `\n\n## Parent Resume Context\n${resumeContext}`;
        const handoff = this.consumeResumeHandoffContext(); if (handoff) plannerPrompt += `\n\n## Resume Handoff\n${handoff}`;
        try { const goalCard = this.cardStore.read(goalId); if (goalCard && this._skillsEngine) { const plannerInstr = goalCard.depth === 0 ? await this._skillsEngine.loadPlannerInstructions() : (goalCard.instructions_file && goalCard.instructions_file.trim()) ? await this._skillsEngine.loadPlannerInstructions(goalCard.instructions_file.trim()) : ''; const skillsContent = await this._skillsEngine.selectAndFormat({ goalDescription: goalCard.description, cardDescription: goalCard.description, tags: goalCard.tags, filePaths: [], availableTools: ['list_project_files', 'read_project_file', 'load_skill', 'mcp_tool_call'], targetRole: 'planner' }); const combinedSkills = [plannerInstr, skillsContent].filter(Boolean).join('\n\n'); if (combinedSkills) plannerPrompt = buildPlannerPrompt(combinedSkills, currentDepth, maxDepth) + `\n\n## Parent Resume Context\n${resumeContext}`; } } catch {}
        const result = this.agentRuntime.invokePlanner(goalId, plannerPrompt); plannerResult = result instanceof Promise ? await result : result;
      } catch (err) { const errorMessage = err instanceof Error ? err.message : String(err); this.plannerControl.updateFrame(plannerFrame.frame_id, { status: 'failed' }); this.emit('error', { goalId, phase: 'planner', error: err }); this._eventLogger.appendEvent({ kind: 'error', goal_id: goalId, phase: 'planner', error_message: errorMessage }); this._errorLogger.appendError({ message: errorMessage, goalId, phase: 'planner' }); break; }
      this.applyPlannerResult(goalId, plannerResult);
      updateRuntimeState(this.projectRoot, { current_agent_session_id: `planner-${goalId}-${iter}`, queue: this.getReadyQueue(goalId).map((c) => c.id), current_resume_context: this.buildParentResumeContext(goalId, plannerFrame.frame_id) } as Partial<RuntimeState> as never);
      const execution = await this.executeReadyCards(goalId, plannerFrame, plannerScope); plannerFrame = this.plannerControl.readFrame(plannerFrame.frame_id) ?? plannerFrame;
      if (execution.failed) plannerDone = false;
      if (this._shuttingDown) break;
      if (this._paused) { this.emit('dispatch_blocked', { reason: 'paused', goalId }); this._eventLogger.appendEvent({ kind: 'dispatch_blocked', reason: 'paused', goal_id: goalId }); return; }
      const hasUnfinishedChildWork = this.cardStore.list().some((card) => card.parent === goalId && card.status !== 'done' && card.status !== 'failed' && card.status !== 'cancelled');
      const hasGoalDispatch = execution.dispatchedGoal; const hasTerminalDispatchOnly = execution.executedTerminal && !execution.dispatchedGoal && !execution.failed; const createdCardIds = (plannerResult.created_cards ?? []).map((card) => card.id).filter((id): id is string => Boolean(id));
      if (plannerResult.status === 'blocked') { this.cardStore.setStatus(goalId, 'running'); this.cardStore.setStatus(goalId, 'blocked'); this.cardStore.update(goalId, { result: { ...(this.cardStore.read(goalId)?.result ?? {}), planning: { status: 'blocked', blocked_reason: plannerResult.blocked_reason ?? null, created_cards: createdCardIds } } }); this.plannerControl.updateFrame(plannerFrame.frame_id, { status: 'blocked' }); updateRuntimeState(this.projectRoot, { status: 'idle', current_card_id: null, current_agent_session_id: null, queue: [] }); return; }
      if (plannerResult.status === 'done' && !hasGoalDispatch && !hasUnfinishedChildWork) plannerDone = true; else { plannerDone = false; this.cardStore.update(goalId, { result: { ...(this.cardStore.read(goalId)?.result ?? {}), planning: { status: 'continue', planner_declared_done: plannerResult.status === 'done', has_unfinished_child_work: hasUnfinishedChildWork, resume_reason: hasGoalDispatch ? 'dispatch_completed' : 'review_completed', created_cards: createdCardIds }, parent_resume_context: this.buildParentResumeContext(goalId, plannerFrame.frame_id) } }); }
      if (plannerDone) {
        const reviewResult = await this.invokeReviewer(goalId, planCard.id);
        const validation = this.validateReviewerAssessment(goalId, reviewResult.assessment);
        if (reviewResult.assessment.result === 'pass' && !validation.valid) {
          const invalidAssessment: ReviewAssessment = { id: `review-${goalId}-${Date.now()}`, goal_card_id: goalId, reviewer_session_id: `reviewer-${goalId}`, result: 'fail', summary: `Reviewer pass rejected: ${validation.reason}`, achieved: [], missing: [validation.reason ?? 'Reviewer evidence validation failed.'], evidence_card_ids: reviewResult.assessment.evidence_card_ids, created_at: now() };
          this.persistReviewState(goalId, invalidAssessment);
          this.plannerControl.updateFrame(plannerFrame.frame_id, { status: 'resumable', resume_reason: 'review_completed' });
          this.emit('review_failed', { goalId, assessment: invalidAssessment });
          this._eventLogger.appendEvent({ kind: 'review_failed', goal_id: goalId, assessment: invalidAssessment });
          plannerDone = false;
          continue;
        }
        if (reviewResult.assessment.result === 'pass') {
          if (this.cardStore.read(goalId)?.status !== 'done') { this.cardStore.setStatus(goalId, 'running'); this.cardStore.setStatus(goalId, 'done'); }
          const assessment: ReviewAssessment = { id: `review-${goalId}-${Date.now()}`, goal_card_id: goalId, reviewer_session_id: `reviewer-${goalId}`, result: 'pass', summary: reviewResult.assessment.summary, achieved: reviewResult.assessment.achieved, missing: reviewResult.assessment.missing, evidence_card_ids: reviewResult.assessment.evidence_card_ids, created_at: now() };
          this.persistReviewState(goalId, assessment);
          this.cardStore.update(goalId, { result: { ...(this.cardStore.read(goalId)?.result ?? {}), planning: { status: 'done', created_cards: [], review_summary: reviewResult.assessment.summary } } });
          this.plannerControl.updateFrame(plannerFrame.frame_id, { status: 'completed', resume_reason: 'review_completed', waiting_on_dispatch_ids: [], last_resume_cursor: now() });
          updateRuntimeState(this.projectRoot, { status: 'idle', current_card_id: null, current_agent_session_id: null, queue: [], current_resume_context: null } as Partial<RuntimeState> as never);
          this.emit('goal_completed', { goalId, assessment }); this._eventLogger.appendEvent({ kind: 'goal_completed', goal_id: goalId, assessment }); await this._checkContinuousImprovement(); return;
        } else {
          plannerDone = false;
          const failedAssessment: ReviewAssessment = { id: `review-${goalId}-${Date.now()}`, goal_card_id: goalId, reviewer_session_id: `reviewer-${goalId}`, result: 'fail', summary: reviewResult.assessment.summary, achieved: reviewResult.assessment.achieved, missing: reviewResult.assessment.missing, evidence_card_ids: reviewResult.assessment.evidence_card_ids, created_at: now() };
          this.persistReviewState(goalId, failedAssessment);
          this.plannerControl.updateFrame(plannerFrame.frame_id, { status: 'resumable', resume_reason: 'review_completed' });
          this.emit('review_failed', { goalId, assessment: failedAssessment }); this._eventLogger.appendEvent({ kind: 'review_failed', goal_id: goalId, assessment: failedAssessment });
        }
      }
    }
    if (this._shuttingDown) { this.emit('dispatch_interrupted', { goalId, reason: 'shutdown' }); this._eventLogger.appendEvent({ kind: 'dispatch_interrupted', goal_id: goalId, reason: 'shutdown' }); }
  }

  private async executeReadyCards(goalId: string, plannerFrame?: { frame_id: string }, plannerScope?: 'project' | 'goal'): Promise<{ dispatchedGoal: boolean; executedTerminal: boolean; failed: boolean }> {
    const getReadyDispatchCards = (): CardRecord[] => { const allCards = this.cardStore.list(); const terminalReady = this.getReadyQueue(goalId); const directReadyGoals = this.cardStore.listChildren(goalId).map((id) => this.cardStore.read(id)).filter((card): card is CardRecord => { if (!card || card.type !== 'goal') return false; if (card.status !== 'backlog' && card.status !== 'active') return false; return card.depends_on.every((depId) => { const dep = allCards.find((candidate) => candidate.id === depId); return dep?.status === 'done'; }); }); return [...directReadyGoals, ...terminalReady].sort((a, b) => { if (a.depends_on.length !== b.depends_on.length) return a.depends_on.length - b.depends_on.length; if (a.priority !== b.priority) return a.priority - b.priority; return a.created_at.localeCompare(b.created_at); }); };
    let readyCards = getReadyDispatchCards(); const goalCard = this.cardStore.read(goalId); let dispatchedGoal = false; let executedTerminal = false; let failed = false;
    while (readyCards.length > 0 && !this._shuttingDown) {
      if (this._paused) return { dispatchedGoal, executedTerminal, failed };
      for (const card of readyCards) {
        if (this._shuttingDown || this._paused) return { dispatchedGoal, executedTerminal, failed };
        if (!plannerFrame || !plannerScope) throw new Error('Planner control frame is required to execute ready cards.');
        const dispatch = this.plannerControl.createDispatch({ parentFrameId: plannerFrame.frame_id, parentCardId: goalId, targetCardId: card.id, targetKind: card.type === 'goal' ? 'goal' : 'terminal_card', requestedByScope: plannerScope, idempotencyKey: `${goalId}:${card.id}:dispatch` });
        this.plannerControl.markDispatchRunning(dispatch.dispatch_id);
        if (card.type === 'goal') {
          await this.dispatchGoal(card.id);
          const completedCard = this.cardStore.read(card.id); const outcome = completedCard?.status === 'done' ? 'done' : completedCard?.status === 'blocked' ? 'blocked' : completedCard?.status === 'cancelled' ? 'cancelled' : 'failed';
          this.plannerControl.markDispatchCompleted(dispatch.dispatch_id, outcome === 'done' ? 'completed' : outcome, { outcome, summary: `Child goal ${card.id} finished with status ${completedCard?.status ?? 'unknown'}.`, child_result: completedCard?.result ?? null, review: (completedCard?.result?.review as ReviewAssessment | null | undefined) ?? null, artifacts: completedCard?.artifacts ?? [], attachments: completedCard?.attachments ?? [], evidence_card_ids: completedCard ? [card.id, ...this.cardStore.getDescendantIds(card.id)] : [card.id], error: completedCard?.error ?? null });
          dispatchedGoal = true; if (outcome !== 'done') return { dispatchedGoal, executedTerminal, failed }; continue;
        }
        if (card.status === 'backlog') this.cardStore.setStatus(card.id, 'active'); this.cardStore.setStatus(card.id, 'running'); updateRuntimeState(this.projectRoot, { current_card_id: card.id });
        let execResult;
        try {
          let executorPrompt = buildExecutorPrompt(card.type);
          try { if (this._skillsEngine) { const instructionContent = await this._skillsEngine.loadInstructions('executor'); const skillsContent = await this._skillsEngine.selectAndFormat({ goalDescription: goalCard?.description ?? '', cardDescription: card.description, tags: card.tags, filePaths: [], availableTools: ['list_project_files', 'read_project_file', 'write_project_file', 'run_project_command', 'load_skill', 'mcp_tool_call'], targetRole: 'executor' }); const combinedSkills = [instructionContent, skillsContent].filter(Boolean).join('\n\n'); if (combinedSkills) executorPrompt = buildExecutorPrompt(card.type, combinedSkills); } } catch {}
          const result = this.agentRuntime.invokeExecutor(card.id, goalId, executorPrompt); execResult = result instanceof Promise ? await result : result;
        } catch (err) { const errorMessage = err instanceof Error ? err.message : String(err); this.emit('error', { cardId: card.id, goalId, phase: 'executor', error: err }); this._eventLogger.appendEvent({ kind: 'error', card_id: card.id, goal_id: goalId, phase: 'executor', error_message: errorMessage }); this._errorLogger.appendError({ message: errorMessage, cardId: card.id, goalId, phase: 'executor' }); this.cardStore.setStatus(card.id, 'failed'); this.plannerControl.markDispatchCompleted(dispatch.dispatch_id, 'failed', { outcome: 'failed', summary: `Terminal card ${card.id} execution failed before producing a result.`, child_result: null, review: null, artifacts: [], attachments: [], evidence_card_ids: [card.id], error: errorMessage }); this.emit('card_failed', { cardId: card.id, goalId }); this._eventLogger.appendEvent({ kind: 'card_failed', card_id: card.id, goal_id: goalId }); failed = true; return { dispatchedGoal, executedTerminal, failed }; }
        this.cardStore.update(card.id, { status: execResult.status, result: execResult.result ?? null, error: execResult.error ?? null });
        const artifactRegistrationErrors: string[] = []; const attachmentRegistrationErrors: string[] = [];
        if (execResult.artifacts && execResult.artifacts.length > 0) for (const artDef of execResult.artifacts) try { this.registerArtifactOnCard(card.id, { type: artDef.type, description: artDef.description, retain: artDef.retain }, artDef.sourceFile ?? artDef.path ?? ''); } catch (err) { const errorMessage = err instanceof Error ? err.message : String(err); artifactRegistrationErrors.push(errorMessage); this.emit('error', { cardId: card.id, phase: 'artifact_registration', error: err }); this._eventLogger.appendEvent({ kind: 'error', card_id: card.id, phase: 'artifact_registration', error_message: errorMessage }); this._errorLogger.appendError({ message: errorMessage, cardId: card.id, goalId, phase: 'artifact_registration' }); }
        if (execResult.attachments && execResult.attachments.length > 0) for (const attDef of execResult.attachments) try { this.registerAttachmentOnCard(card.id, { mime: attDef.mime, title: attDef.title, description: attDef.description }, attDef.sourceFile ?? attDef.path ?? ''); } catch (err) { const errorMessage = err instanceof Error ? err.message : String(err); attachmentRegistrationErrors.push(errorMessage); this.emit('error', { cardId: card.id, phase: 'attachment_registration', error: err }); this._eventLogger.appendEvent({ kind: 'error', card_id: card.id, phase: 'attachment_registration', error_message: errorMessage }); this._errorLogger.appendError({ message: errorMessage, cardId: card.id, goalId, phase: 'attachment_registration' }); }
        if (execResult.status === 'done' && (artifactRegistrationErrors.length > 0 || attachmentRegistrationErrors.length > 0)) {
          const registrationError = `Completion blocked by evidence registration failure. Artifacts: ${artifactRegistrationErrors.join(' | ') || 'none'}. Attachments: ${attachmentRegistrationErrors.join(' | ') || 'none'}.`;
          this.cardStore.update(card.id, { status: 'failed', error: registrationError, result: { ...(this.cardStore.read(card.id)?.result ?? {}), evidence_registration_failures: { artifacts: artifactRegistrationErrors, attachments: attachmentRegistrationErrors } } });
          execResult.status = 'failed'; execResult.error = registrationError;
        }
        executedTerminal = true; const completedCard = this.cardStore.read(card.id); const outcome = execResult.status === 'done' ? 'done' : 'failed';
        this.plannerControl.markDispatchCompleted(dispatch.dispatch_id, outcome === 'done' ? 'completed' : outcome, { outcome, summary: `Terminal card ${card.id} finished with status ${execResult.status}.`, child_result: completedCard?.result ?? null, review: null, artifacts: completedCard?.artifacts ?? [], attachments: completedCard?.attachments ?? [], evidence_card_ids: [card.id], error: completedCard?.error ?? execResult.error ?? null });
        if (execResult.status === 'failed') { this.emit('card_failed', { cardId: card.id, goalId }); this._eventLogger.appendEvent({ kind: 'card_failed', card_id: card.id, goal_id: goalId }); failed = true; return { dispatchedGoal, executedTerminal, failed }; }
      }
      readyCards = getReadyDispatchCards();
    }
    return { dispatchedGoal, executedTerminal, failed };
  }

  async invokeReviewer(goalId: string, _planCardId: string): Promise<ReviewerResult> {
    let reviewerPrompt = buildReviewerPrompt();
    try { if (this._skillsEngine) { const goalCard = this.cardStore.read(goalId); const instructionContent = await this._skillsEngine.loadInstructions('reviewer'); const skillsContent = await this._skillsEngine.selectAndFormat({ goalDescription: goalCard?.description ?? '', cardDescription: goalCard?.description ?? '', tags: goalCard?.tags ?? [], filePaths: [], availableTools: ['list_project_files', 'read_project_file', 'load_skill', 'mcp_tool_call'], targetRole: 'reviewer' }); const combinedSkills = [instructionContent, skillsContent].filter(Boolean).join('\n\n'); if (combinedSkills) reviewerPrompt = buildReviewerPrompt(combinedSkills); } } catch {}
    reviewerPrompt += `\n\n## Goal Evidence Context\n${this.buildParentResumeContext(goalId, this.plannerControl.ensureFrame(goalId, goalId === 'project' ? 'project' : 'goal').frame_id)}`;
    const result = await this.agentRuntime.invokeReviewer(goalId, reviewerPrompt);
    this.emit('review_complete', { goalId, assessment: result.assessment }); this._eventLogger.appendEvent({ kind: 'review_complete', goal_id: goalId, assessment: result.assessment }); return result;
  }

  applyPlannerResult(goalId: string, plannerResult: PlannerResult): void { if (plannerResult.created_cards) for (const cardDef of plannerResult.created_cards) this.cardStore.create({ id: cardDef.id, type: cardDef.type as CardRecord['type'], parent: goalId, title: cardDef.title, description: cardDef.description, status: cardDef.status as CardRecord['status'], depends_on: cardDef.depends_on, priority: cardDef.priority, tags: cardDef.tags ?? [], urgency: 'normal', created_by: 'planner', blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0, depth: 0 }); if (plannerResult.updated_cards) for (const update of plannerResult.updated_cards) { const changes: Partial<CardRecord> = {}; if (update.status !== undefined) changes.status = update.status as CardRecord['status']; if (update.title !== undefined) changes.title = update.title; if (update.description !== undefined) changes.description = update.description; this.cardStore.update(update.id, changes); } }
  simulateCrash(): void { const allCards = this.cardStore.list(); for (const card of allCards) if (card.status === 'active' || card.status === 'running') this.cardStore.setStatus(card.id, 'backlog'); this._running = false; }
  runCleanup(options?: { stashMaxAgeMs?: number; processMaxAgeMs?: number; previewsMaxAgeMs?: number; uploadsMaxAgeMs?: number; }) { return cleanAll(saivageWorkDir(this.projectRoot), this.cardStore, options); }
  getState(): RuntimeState | null { return readRuntimeState(this.projectRoot); }
  private async _autoDispatchFirstBacklogGoal(): Promise<void> { const nextGoal = this.cardStore.list().filter((card) => card.type === 'goal' && card.parent === 'project' && card.status === 'backlog').sort((a, b) => a.priority - b.priority)[0]; if (!nextGoal || this._paused || this._shuttingDown) return; try { await this.dispatchGoal(nextGoal.id); } catch {} }
  private async _checkContinuousImprovement(): Promise<void> { if (!this._continuousImprovement || this._paused || this._shuttingDown || this._improvementDispatchInProgress) return; const allCards = this.cardStore.list(); const topLevelGoals = allCards.filter((c) => c.type === 'goal' && c.parent === 'project'); if (topLevelGoals.length === 0) return; const allTerminal = topLevelGoals.every((g) => TERMINAL_STATUSES.has(g.status)); if (!allTerminal) return; this._improvementDispatchInProgress = true; try { this.emit('improvement_invoked', { goalIds: topLevelGoals.map((g) => g.id) }); this._eventLogger.appendEvent({ kind: 'improvement_invoked' as never, goal_ids: topLevelGoals.map((g) => g.id) }); const improvementDirective = buildImprovementDirective(topLevelGoals); const projectGoal = this.cardStore.read('project'); const currentDepth = projectGoal?.depth ?? 0; const maxDepth = this.cardStore.maxDepth; let promptContent = improvementDirective; try { const plannerInstr = this._skillsEngine ? await this._skillsEngine.loadPlannerInstructions() : ''; if (plannerInstr) promptContent = improvementDirective + '\n\n' + plannerInstr; } catch {} const plannerPrompt = buildPlannerPrompt(promptContent, currentDepth, maxDepth); const planCardResult = this.cardStore.activateGoal('project'); const planCardId = planCardResult.goal.id; const result = this.agentRuntime.invokePlanner('project', plannerPrompt); const plannerResult = result instanceof Promise ? await result : result; this.applyPlannerResult('project', plannerResult); this.emit('plan_updated', { goalId: 'project', source: 'continuous-improvement' }); this._eventLogger.appendEvent({ kind: 'plan_updated' as never, goal_id: 'project', source: 'continuous-improvement' }); } catch (err) { const errorMessage = err instanceof Error ? err.message : String(err); this.emit('error', { goalId: 'project', phase: 'continuous-improvement', error: err }); this._eventLogger.appendEvent({ kind: 'error' as never, goal_id: 'project', phase: 'continuous-improvement', error_message: errorMessage }); this._errorLogger.appendError({ message: errorMessage, goalId: 'project', phase: 'continuous-improvement' }); } finally { this._improvementDispatchInProgress = false; } }
}
