import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AtomicJsonFile, ProjectLock } from '../../persistence/index.js';
import { readActorSnapshots, removeActorSnapshot } from './snapshots.js';
import type { ActorSnapshotRecord } from './snapshots.js';
import type { CardRecord } from '../../schemas/index.js';
import type { CardActiveReconstructionRecord, LlmActiveReconstructionRecord, ProcessorActiveReconstructionRecord } from './active-reconstruction.js';
import { readCardActiveReconstruction, readLlmActiveReconstruction, readProcessorActiveReconstruction } from './active-reconstruction.js';
import { parseCardActorId, parseLlmActorId, parseProcessorActorId } from './ids.js';
import { parseCardActorState, readSupervisorModeValue } from './actor-vocabulary.js';
import type { LlmActorRole } from './actor-vocabulary.js';
import { cardActivationOutcomePatch, type CardActivationOutcome } from './card-actor.js';
import type { LLMActorOutcome } from './llm-actor.js';
import { abandonStalePendingToolCalls, appendTerminalToolProjectedStatus, readLoggedToolCall } from './llm-delivery-log.js';
import { createPlannerContract, type PlannerTypedResult } from '../../contracts/planner-contract.js';
import { createExecutorContract } from '../../contracts/executor-contract.js';
import { createReviewerContract } from '../../contracts/reviewer-contract.js';
import { evaluateReviewerTerminalOutcome } from './reviewer-terminal-evaluation.js';
import { verifyTerminalToolOutcome } from './contract-terminal-tools.js';
import { closeOpenRecordSlot } from '../records/record-slots.js';

export interface ActorRecoveryCardReader {
  read(cardId: string): unknown | null;
  listChildren?(cardId: string): string[];
}

export interface ActorRecoveryOutcomeStore {
  read(cardId: string): CardRecord | null;
  listChildren?(cardId: string): string[];
  commitTerminalLifecyclePatch(cardId: string, changes: Partial<CardRecord>): CardRecord;
}

export interface ActorRecoveryOutcomeConversion {
  cardId: string;
  actorIds: string[];
  status: Exclude<CardActivationOutcome, { status: 'cancelled' }>['status'];
  reason: string;
}

export interface ActorRecoveryTerminalProjectionDeps {
  projectRoot: string;
  store: ActorRecoveryOutcomeStore;
  makePlanningProcessor(cardId: string): { recoverTerminalToolOutcome(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): Exclude<CardActivationOutcome, { status: 'cancelled' }> | null };
  makeTerminalProcessor(cardId: string): { recoverTerminalToolOutcome(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): Exclude<CardActivationOutcome, { status: 'cancelled' }> | null };
  generatedAt?: string;
}

export type { LlmActorRole as LlmRecoveryRole } from './actor-vocabulary.js';
type LlmRecoveryRole = LlmActorRole;

export interface CardActorRecoveryRecord {
  cardId: string;
  snapshot: ActorSnapshotRecord;
  active: boolean;
  activeReconstruction: CardActiveReconstructionRecord | null;
}

export interface LlmActorRecoveryRecord {
  actorId: string;
  role: LlmRecoveryRole;
  cardId: string | null;
  snapshot: ActorSnapshotRecord;
  active: boolean;
  activeReconstruction: LlmActiveReconstructionRecord | null;
}

export type LlmRecoveryDiagnosticAction = 'none' | 'abandon_provider_call' | 'block_tool_wait';

export interface ProcessorActorRecoveryRecord {
  actorId: string;
  cardId: string;
  snapshot: ActorSnapshotRecord;
  active: boolean;
  activeReconstruction: ProcessorActiveReconstructionRecord | null;
}

export interface ActorRecoveryDiagnostic {
  actorId: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface ActorRecoveryDiagnosticAction {
  actorId: string;
  kind: 'active_card' | 'active_llm' | 'llm_recovery_action' | 'active_processor' | 'discarded_supervisor';
  action: string;
  cardId?: string;
}

export interface ActorRecoveryDiagnosticsSnapshot {
  schema_version: 1;
  generated_at: string;
  diagnostics: ActorRecoveryDiagnostic[];
  actions: ActorRecoveryDiagnosticAction[];
}

export interface ActorRecoveryPlan {
  supervisor: ActorSnapshotRecord | null;
  cards: CardActorRecoveryRecord[];
  llms: LlmActorRecoveryRecord[];
  processors: ProcessorActorRecoveryRecord[];
}

export interface ActorRecoveryProjection {
  diagnostics: ActorRecoveryDiagnostic[];
  actions: ActorRecoveryDiagnosticAction[];
}

export interface ActorStartupRecoveryIncident {
  actorId: string;
  kind: ActorRecoveryDiagnosticAction['kind'] | 'converted_actor_snapshots' | 'stale_tool_call';
  action: string;
  message: string;
  cardId?: string;
}

export interface ActorStartupRecoveryReport {
  generated_at: string;
  incidents: ActorStartupRecoveryIncident[];
  outstanding: ActorRecoveryDiagnosticsSnapshot | null;
}

export function buildActorRecoveryPlan(projectRoot: string, cards?: ActorRecoveryCardReader): ActorRecoveryPlan {
  const snapshots = readActorSnapshots(projectRoot);
  const supervisor = snapshots.find((snapshot) => snapshot.actor_id === 'supervisor') ?? null;
  const cardSnapshots = snapshots.filter((snapshot) => snapshot.actor_kind === 'card');
  const knownCardIds = new Set<string>();
  const cardRecords = cardSnapshots.map((snapshot): CardActorRecoveryRecord => {
    const cardId = parseCardActorId(snapshot.actor_id);
    const activeReconstruction = readCardActiveReconstruction(snapshot);
    knownCardIds.add(cardId);
    return { cardId, snapshot, active: activeReconstruction !== null, activeReconstruction };
  });
  const llms = snapshots
    .filter((snapshot) => snapshot.actor_kind === 'llm')
    .map((snapshot): LlmActorRecoveryRecord => {
      const parsed = parseLlmActorId(snapshot.actor_id);
      const activeReconstruction = readLlmActiveReconstruction(snapshot);
      const active = activeReconstruction !== null;
      if (active && parsed.cardId !== null && !knownCardIds.has(parsed.cardId) && !cards?.read(parsed.cardId)) {
        throw new Error(`Cannot recover active LLM actor '${snapshot.actor_id}': owner card '${parsed.cardId}' was not found.`);
      }
      return { actorId: snapshot.actor_id, role: parsed.role, cardId: parsed.cardId, snapshot, active, activeReconstruction };
    });
  const processors = snapshots
    .filter((snapshot) => snapshot.actor_kind === 'processor')
    .map((snapshot): ProcessorActorRecoveryRecord => {
      const activeReconstruction = readProcessorActiveReconstruction(snapshot);
      return {
        actorId: snapshot.actor_id,
        cardId: parseProcessorActorId(snapshot.actor_id),
        snapshot,
        active: activeReconstruction !== null,
        activeReconstruction,
      };
    });
  return {
    supervisor,
    cards: cardRecords.sort((a, b) => a.cardId.localeCompare(b.cardId)),
    llms: llms.sort((a, b) => a.actorId.localeCompare(b.actorId)),
    processors: processors.sort((a, b) => a.actorId.localeCompare(b.actorId)),
  };
}

const recoveryDiagnosticSchema = z.object({
  actorId: z.string().min(1),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().min(1),
});

const recoveryDiagnosticActionSchema = z.object({
  actorId: z.string().min(1),
  kind: z.enum(['active_card', 'active_llm', 'llm_recovery_action', 'active_processor', 'discarded_supervisor']),
  action: z.string().min(1),
  cardId: z.string().optional(),
});

const recoveryDiagnosticsSnapshotSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.string().datetime(),
  diagnostics: z.array(recoveryDiagnosticSchema),
  actions: z.array(recoveryDiagnosticActionSchema),
});

export function recoveryDiagnosticsPath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'runtime', 'recovery-diagnostics.json');
}

export function readRecoveryDiagnostics(projectRoot: string): ActorRecoveryDiagnosticsSnapshot | null {
  const path = recoveryDiagnosticsPath(projectRoot);
  if (!existsSync(path)) return null;
  return recoveryDiagnosticsFile(projectRoot).read();
}

export function writeRecoveryDiagnostics(projectRoot: string, plan: ActorRecoveryPlan, generatedAt = new Date().toISOString()): ActorRecoveryDiagnosticsSnapshot | null {
  const projection = projectActorRecovery(plan);
  if (projection.diagnostics.length === 0 && projection.actions.length === 0) {
    clearRecoveryDiagnostics(projectRoot);
    return null;
  }
  const snapshot: ActorRecoveryDiagnosticsSnapshot = {
    schema_version: 1,
    generated_at: generatedAt,
    diagnostics: projection.diagnostics,
    actions: projection.actions,
  };
  const lock = recoveryDiagnosticsLock(projectRoot);
  const file = recoveryDiagnosticsFile(projectRoot, lock);
  lock.withLockSync((handle) => file.writeSync(handle, snapshot));
  return snapshot;
}

export function clearRecoveryDiagnostics(projectRoot: string): void {
  const path = recoveryDiagnosticsPath(projectRoot);
  if (!existsSync(path)) return;
  const lock = recoveryDiagnosticsLock(projectRoot);
  lock.withLockSync(() => {
    if (existsSync(path)) unlinkSync(path);
  });
}

export function runActorStartupRecovery(plan: ActorRecoveryPlan, deps: ActorRecoveryTerminalProjectionDeps): ActorStartupRecoveryReport {
  const generatedAt = deps.generatedAt ?? new Date().toISOString();
  const preCleanupProjection = projectActorRecovery(plan);
  const recoveries = recoverActorStartupOutcomes(plan, { ...deps, generatedAt });
  cleanupConvertedRecoverySnapshots(deps.projectRoot, recoveries);
  const abandonedToolCalls = abandonStalePendingToolCalls(deps.projectRoot);
  const postCleanupPlan = buildActorRecoveryPlan(deps.projectRoot, deps.store);
  const outstanding = writeRecoveryDiagnostics(deps.projectRoot, postCleanupPlan, generatedAt);
  return {
    generated_at: generatedAt,
    incidents: [
      ...startupIncidentsFromProjection(preCleanupProjection),
      ...recoveries.map((recovery) => ({ actorId: recovery.actorIds[0] ?? recovery.cardId, kind: 'converted_actor_snapshots' as const, action: 'project_or_convert_startup_outcome', cardId: recovery.cardId, message: recovery.reason })),
      ...abandonedToolCalls.map((record) => ({ actorId: record.agent_id, kind: 'stale_tool_call' as const, action: 'abandon_stale_pending_tool_call', message: record.error ?? 'Startup recovery abandoned a stale pending tool call.', cardId: cardIdFromAgentId(record.agent_id) })),
    ].sort((a, b) => a.actorId.localeCompare(b.actorId) || a.action.localeCompare(b.action)),
    outstanding,
  };
}

export function convertActorRecoveryOutcomes(plan: ActorRecoveryPlan, store: ActorRecoveryOutcomeStore, generatedAt = new Date().toISOString()): ActorRecoveryOutcomeConversion[] {
  const candidates = recoveryOutcomeCandidates(plan);
  const conversions: ActorRecoveryOutcomeConversion[] = [];
  for (const [cardId, actorIds] of candidates) {
    const card = store.read(cardId);
    if (!card || card.status !== 'running') continue;
    const reason = 'Startup recovery blocked this card because its previous actor activation was interrupted and cannot be safely resumed.';
    store.commitTerminalLifecyclePatch(cardId, {
      status: 'blocked',
      lifecycle: { status: 'blocked', result: { kind: 'blocked', summary: reason, resume_reason: 'Inspect recovery diagnostics, then reactivate the card if the work should continue.', blocker_cause: 'generic' }, error: reason, completed_at: null },
      status_text: reason,
      status_text_updated_at: generatedAt,
    });
    conversions.push({ cardId, actorIds: [...actorIds].sort(), status: 'blocked', reason });
  }
  return conversions;
}

export function cleanupConvertedRecoverySnapshots(projectRoot: string, conversions: ActorRecoveryOutcomeConversion[]): void {
  for (const conversion of conversions) {
    for (const actorId of conversion.actorIds) removeActorSnapshot(projectRoot, actorId);
  }
}

export function recoverActorStartupOutcomes(plan: ActorRecoveryPlan, deps: ActorRecoveryTerminalProjectionDeps): ActorRecoveryOutcomeConversion[] {
  const projected = recoverProjectedTerminalToolOutcomes(plan, deps);
  const projectedCardIds = new Set(projected.map((recovery) => recovery.cardId));
  const converted = convertActorRecoveryOutcomes(omitRecoveredCards(plan, projectedCardIds), deps.store, deps.generatedAt ?? new Date().toISOString());
  return [...projected, ...converted];
}

export function recoverProjectedTerminalToolOutcomes(plan: ActorRecoveryPlan, deps: ActorRecoveryTerminalProjectionDeps): ActorRecoveryOutcomeConversion[] {
  const recovered: ActorRecoveryOutcomeConversion[] = [];
  const generatedAt = deps.generatedAt ?? new Date().toISOString();
  for (const llm of plan.llms) {
    if (llm.cardId === null) continue;
    if (!llm.active || llm.snapshot.state_value !== 'waiting_tool' || !llm.activeReconstruction?.waiting_tool_call) continue;
    const processor = plan.processors.find((candidate) => candidate.active && candidate.cardId === llm.cardId);
    const cardSnapshot = plan.cards.find((candidate) => candidate.active && candidate.cardId === llm.cardId);
    if (!processor?.activeReconstruction || !cardSnapshot?.activeReconstruction) continue;
    const card = deps.store.read(llm.cardId);
    if (!card || card.status !== 'running') continue;
    const waiting = llm.activeReconstruction.waiting_tool_call;
    const logged = readLoggedToolCall(deps.projectRoot, llm.activeReconstruction.input.sessionId, llm.actorId, waiting.sourceInputId, waiting.toolCallId);
    if (logged.tool_name !== waiting.toolName) throw new Error(`Logged tool call '${waiting.toolCallId}' tool name changed from '${waiting.toolName}' to '${logged.tool_name}'.`);
    const outcome: Extract<LLMActorOutcome, { type: 'tool_call' }> = { type: 'tool_call', agentId: llm.actorId, inputId: waiting.sourceInputId, toolCallId: waiting.toolCallId, toolName: waiting.toolName, args: logged.args };
    const reviewerProjected = projectReviewerRecoveryOutcome(plan, deps, llm, processor, cardSnapshot, card, outcome, generatedAt);
    if (reviewerProjected) {
      recovered.push(reviewerProjected);
      continue;
    }
    const projected = projectTerminalRecoveryOutcome(deps, processor.activeReconstruction, card, cardSnapshot.activeReconstruction, outcome);
    if (!projected) continue;
    deps.store.commitTerminalLifecyclePatch(llm.cardId, cardActivationOutcomePatch(projected, generatedAt));
    appendTerminalToolProjectedStatus(deps.projectRoot, {
      agent_id: llm.actorId,
      source_input_id: waiting.sourceInputId,
      tool_call_id: waiting.toolCallId,
      tool_name: waiting.toolName,
    });
    recovered.push({
      cardId: llm.cardId,
      actorIds: [cardSnapshot.snapshot.actor_id, processor.actorId, llm.actorId].sort(),
      status: projected.status,
      reason: 'Startup recovery projected a persisted terminal tool call outcome.',
    });
  }
  return recovered;
}

function projectReviewerRecoveryOutcome(
  plan: ActorRecoveryPlan,
  deps: ActorRecoveryTerminalProjectionDeps,
  planner: LlmActorRecoveryRecord,
  processor: ProcessorActorRecoveryRecord,
  cardSnapshot: CardActorRecoveryRecord,
  card: CardRecord,
  plannerOutcome: Extract<LLMActorOutcome, { type: 'tool_call' }>,
  generatedAt: string,
): ActorRecoveryOutcomeConversion | null {
  if (planner.role !== 'planner' || processor.activeReconstruction?.processor_kind !== 'planning') return null;
  if (!createPlannerContract().isTerminalToolName(plannerOutcome.toolName)) return null;
  let plannerResult: PlannerTypedResult;
  try {
    plannerResult = verifyTerminalToolOutcome(createPlannerContract(), plannerOutcome).result;
  } catch {
    return null;
  }
  if (plannerResult.kind !== 'result' || plannerResult.result.status !== 'done') return null;
  if (!descendantsAreComplete(card.id, deps.store)) return null;
  const reviewer = plan.llms.find((candidate) => candidate.active && candidate.role === 'reviewer' && candidate.cardId === card.id && candidate.snapshot.state_value === 'waiting_tool' && candidate.activeReconstruction?.waiting_tool_call);
  if (!reviewer?.activeReconstruction?.waiting_tool_call) return null;
  const assessmentId = reviewer.activeReconstruction.input.episodeContext.assessmentId;
  if (typeof assessmentId !== 'string' || assessmentId.length === 0) return null;
  const reviewerWaiting = reviewer.activeReconstruction.waiting_tool_call;
  const reviewerLogged = readLoggedToolCall(deps.projectRoot, reviewer.activeReconstruction.input.sessionId, reviewer.actorId, reviewerWaiting.sourceInputId, reviewerWaiting.toolCallId);
  if (reviewerLogged.tool_name !== reviewerWaiting.toolName || !createReviewerContract().isTerminalToolName(reviewerWaiting.toolName)) return null;
  const reviewerOutcome: Extract<LLMActorOutcome, { type: 'tool_call' }> = { type: 'tool_call', agentId: reviewer.actorId, inputId: reviewerWaiting.sourceInputId, toolCallId: reviewerWaiting.toolCallId, toolName: reviewerWaiting.toolName, args: reviewerLogged.args };
  const projected = evaluateReviewerTerminalOutcome({
    card,
    candidatePlanning: { kind: 'done', summary: plannerResult.result.summary ?? 'Planner completed.' },
    assessmentId,
    sessionId: reviewer.activeReconstruction.input.sessionId,
    outcome: reviewerOutcome,
    store: deps.store,
  });
  if (!closeRecoveredRecordSlot(deps.projectRoot, card.id, 'status.md', 'planner', card.version_seq)) return null;
  if (!closeRecoveredRecordSlot(deps.projectRoot, card.id, 'review.md', 'reviewer', card.version_seq)) return null;
  deps.store.commitTerminalLifecyclePatch(card.id, cardActivationOutcomePatch(projected, generatedAt));
  const plannerWaiting = planner.activeReconstruction!.waiting_tool_call!;
  appendTerminalToolProjectedStatus(deps.projectRoot, { agent_id: planner.actorId, source_input_id: plannerWaiting.sourceInputId, tool_call_id: plannerWaiting.toolCallId, tool_name: plannerWaiting.toolName });
  appendTerminalToolProjectedStatus(deps.projectRoot, { agent_id: reviewer.actorId, source_input_id: reviewerWaiting.sourceInputId, tool_call_id: reviewerWaiting.toolCallId, tool_name: reviewerWaiting.toolName });
  return {
    cardId: card.id,
    actorIds: [cardSnapshot.snapshot.actor_id, processor.actorId, planner.actorId, reviewer.actorId].sort(),
    status: projected.status,
    reason: 'Startup recovery projected persisted planner and reviewer terminal tool call outcomes.',
  };
}

function recoveryOutcomeCandidates(plan: ActorRecoveryPlan): Map<string, Set<string>> {
  const candidates = new Map<string, Set<string>>();
  for (const card of plan.cards) if (card.active) addRecoveryOutcomeCandidate(candidates, card.cardId, card.snapshot.actor_id);
  for (const llm of plan.llms) {
    if (!llm.active) continue;
    if (llm.cardId === null) continue;
    addRecoveryOutcomeCandidate(candidates, llm.cardId, llm.actorId);
  }
  for (const processor of plan.processors) if (processor.active) addRecoveryOutcomeCandidate(candidates, processor.cardId, processor.actorId);
  return candidates;
}

function omitRecoveredCards(plan: ActorRecoveryPlan, recoveredCardIds: Set<string>): ActorRecoveryPlan {
  if (recoveredCardIds.size === 0) return plan;
  return {
    ...plan,
    cards: plan.cards.filter((card) => !recoveredCardIds.has(card.cardId)),
    llms: plan.llms.filter((llm) => llm.cardId === null || !recoveredCardIds.has(llm.cardId)),
    processors: plan.processors.filter((processor) => !recoveredCardIds.has(processor.cardId)),
  };
}

function projectTerminalRecoveryOutcome(
  deps: ActorRecoveryTerminalProjectionDeps,
  processor: ProcessorActiveReconstructionRecord,
  card: CardRecord,
  _cardReconstruction: CardActiveReconstructionRecord,
  outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>,
): Exclude<CardActivationOutcome, { status: 'cancelled' }> | null {
  if (processor.processor_kind === 'planning') {
    if (!createPlannerContract().isTerminalToolName(outcome.toolName)) return null;
    const projected = deps.makePlanningProcessor(card.id).recoverTerminalToolOutcome(outcome);
    if (!projected) return null;
    if (!closeRecoveredRecordSlot(deps.projectRoot, card.id, 'status.md', 'planner', card.version_seq)) return null;
    return projected;
  }
  if (!createExecutorContract().isTerminalToolName(outcome.toolName)) return null;
  const projected = deps.makeTerminalProcessor(card.id).recoverTerminalToolOutcome(outcome);
  if (!projected) return null;
  if (!closeRecoveredRecordSlot(deps.projectRoot, card.id, 'status.md', 'executor', card.version_seq)) return null;
  return projected;
}

function closeRecoveredRecordSlot(projectRoot: string, cardId: string, filename: 'status.md' | 'review.md', writer: 'planner' | 'executor' | 'reviewer', cardVersionSeq: number): boolean {
  try {
    closeOpenRecordSlot(projectRoot, { cardId, filename, writer, cardVersionSeq });
    return true;
  } catch {
    return false;
  }
}

function descendantsAreComplete(cardId: string, store: ActorRecoveryOutcomeStore): boolean {
  if (!store.listChildren) throw new Error(`Cannot project reviewer recovery for card '${cardId}': recovery outcome store must provide listChildren for descendant traversal.`);
  for (const childId of store.listChildren(cardId)) {
    const child = store.read(childId);
    if (!child || (child.status !== 'done' && child.status !== 'cancelled')) return false;
    if (!descendantsAreComplete(childId, store)) return false;
  }
  return true;
}

function addRecoveryOutcomeCandidate(candidates: Map<string, Set<string>>, cardId: string, actorId: string): void {
  const actorIds = candidates.get(cardId) ?? new Set<string>();
  actorIds.add(actorId);
  candidates.set(cardId, actorIds);
}

function recoveryDiagnosticsLock(projectRoot: string): ProjectLock {
  return new ProjectLock(join(projectRoot, '.saivage', '.lock'), { staleLockAction: 'remove' });
}

function recoveryDiagnosticsFile(projectRoot: string, lock: ProjectLock = recoveryDiagnosticsLock(projectRoot)): AtomicJsonFile<ActorRecoveryDiagnosticsSnapshot> {
  return new AtomicJsonFile(recoveryDiagnosticsPath(projectRoot), recoveryDiagnosticsSnapshotSchema, lock, { version: null });
}

export function projectActorRecovery(plan: ActorRecoveryPlan, cardReader?: ActorRecoveryCardReader): ActorRecoveryProjection {
  const llmActions = new Map(plan.llms.map((llm) => [llm.actorId, llmRecoveryDiagnosticAction(llm.snapshot, llm.active)]));
  const actions: ActorRecoveryDiagnosticAction[] = [
    ...(isNonIdleSupervisorSnapshot(plan.supervisor) ? [{ actorId: 'supervisor', kind: 'discarded_supervisor' as const, action: 'discard_stale_supervisor' }] : []),
    ...plan.cards.filter((card) => card.active).map((card) => ({ actorId: card.snapshot.actor_id, kind: 'active_card' as const, action: 'diagnose_active_card', cardId: card.cardId })),
    ...plan.llms.filter((llm) => llm.active).map((llm) => ({ actorId: llm.actorId, kind: 'active_llm' as const, action: 'diagnose_active_llm', cardId: llm.cardId ?? undefined })),
    ...plan.llms.filter((llm) => llmActions.get(llm.actorId) !== 'none').map((llm) => ({ actorId: llm.actorId, kind: 'llm_recovery_action' as const, action: llmActions.get(llm.actorId)!, cardId: llm.cardId ?? undefined })),
    ...plan.processors.filter((processor) => processor.active).map((processor) => ({ actorId: processor.actorId, kind: 'active_processor' as const, action: 'diagnose_active_processor', cardId: processor.cardId })),
  ].sort((a, b) => a.actorId.localeCompare(b.actorId) || a.kind.localeCompare(b.kind));
  return { diagnostics: recoveryDiagnostics(plan, llmActions, cardReader), actions };
}

function isNonIdleSupervisorSnapshot(snapshot: ActorSnapshotRecord | null): boolean {
  if (!snapshot) return false;
  const mode = readSupervisorModeValue(snapshot.state_value);
  return mode !== null && mode !== 'idle';
}

function llmRecoveryDiagnosticAction(snapshot: ActorSnapshotRecord, active: boolean): LlmRecoveryDiagnosticAction {
  if (!active) return 'none';
  if (snapshot.state_value === 'calling_provider') return 'abandon_provider_call';
  if (snapshot.state_value === 'waiting_tool') return 'block_tool_wait';
  return 'none';
}

function recoveryDiagnostics(
  plan: ActorRecoveryPlan,
  llmActions: Map<string, LlmRecoveryDiagnosticAction>,
  cardReader?: ActorRecoveryCardReader,
): ActorRecoveryDiagnostic[] {
  const { supervisor, cards, llms, processors } = plan;
  return [
    ...(isNonIdleSupervisorSnapshot(supervisor) ? [{ actorId: 'supervisor', severity: 'warning' as const, message: 'Non-idle supervisor snapshot is not resumed; startup creates a fresh supervisor and records this discard.' }] : []),
    ...cards.filter(isAmbiguousActiveCard).map((card) => ({ actorId: card.snapshot.actor_id, severity: 'warning' as const, message: `Active card snapshot has ambiguous state '${String(card.snapshot.state_value)}' and requires explicit recovery reconciliation.` })),
    ...cards.filter((card) => isStrandedActiveCard(card, cards, llms, processors, cardReader)).map((card) => ({ actorId: card.snapshot.actor_id, severity: 'warning' as const, message: 'Active card snapshot has no active processor, LLM, or active child evidence and cannot be safely reconstructed yet.' })),
    ...llms.filter((llm) => llmActions.get(llm.actorId) === 'abandon_provider_call').map((llm) => ({ actorId: llm.actorId, severity: 'warning' as const, message: 'In-flight provider call cannot be reattached and is recorded as an operator-visible startup recovery action.' })),
    ...llms.filter((llm) => llmActions.get(llm.actorId) === 'block_tool_wait').map((llm) => ({ actorId: llm.actorId, severity: 'warning' as const, message: 'LLM actor is waiting for a persisted tool call result that has not been projected to a terminal outcome.' })),
    ...llms.filter((llm) => llm.active && llmActions.get(llm.actorId) === 'none').map((llm) => ({ actorId: llm.actorId, severity: 'warning' as const, message: `Active LLM snapshot state '${String(llm.snapshot.state_value)}' has no concrete recovery action yet.` })),
    ...processors.filter((processor) => processor.active).map((processor) => ({ actorId: processor.actorId, severity: 'warning' as const, message: 'Active processor snapshot requires reconstruction of activation/tool waits before autonomous execution resumes.' })),
  ].sort((a, b) => a.actorId.localeCompare(b.actorId));
}

function startupIncidentsFromProjection(projection: ActorRecoveryProjection): ActorStartupRecoveryIncident[] {
  const diagnostics = new Map(projection.diagnostics.map((diagnostic) => [diagnostic.actorId, diagnostic.message]));
  return projection.actions
    .filter((action) => action.kind === 'discarded_supervisor')
    .map((action) => ({ ...action, message: diagnostics.get(action.actorId) ?? `Startup recovery handled ${action.action}.` }));
}

function cardIdFromAgentId(agentId: string): string | undefined {
  const separator = agentId.indexOf(':');
  return separator === -1 ? undefined : agentId.slice(separator + 1);
}

function isAmbiguousActiveCard(card: CardActorRecoveryRecord): boolean {
  return card.active && !isKnownCardActorState(card.snapshot.state_value);
}

function isKnownCardActorState(state: unknown): boolean {
  return parseCardActorState(state) !== null;
}

function isStrandedActiveCard(
  card: CardActorRecoveryRecord,
  cards: CardActorRecoveryRecord[],
  llms: LlmActorRecoveryRecord[],
  processors: ProcessorActorRecoveryRecord[],
  cardReader?: ActorRecoveryCardReader,
): boolean {
  if (!card.active) return false;
  if (processors.some((processor) => processor.active && processor.cardId === card.cardId)) return false;
  if (llms.some((llm) => llm.active && llm.cardId === card.cardId)) return false;
  const childIds = cardReader?.listChildren?.(card.cardId) ?? [];
  return !childIds.some((childId) => cards.some((candidate) => candidate.cardId === childId && candidate.active));
}
