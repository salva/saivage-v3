import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AtomicJsonFile, ProjectLock } from '../../persistence/index.js';
import { readActorSnapshots, removeActorSnapshot } from './snapshots.js';
import type { ActorSnapshotRecord } from './snapshots.js';
import type { CardRecord } from '../../schemas/index.js';
import type { CardActiveReconstructionRecord, LlmActiveReconstructionRecord, ProcessorActiveReconstructionRecord } from './active-reconstruction.js';
import { cardActivationOutcomePatch, type CardActivationInput, type CardActivationOutcome } from './card-actor.js';
import type { LLMActorOutcome } from './llm-actor.js';
import { appendTerminalToolProjectedStatus, readLoggedToolCall } from './llm-delivery-log.js';
import { createPlannerContract, type PlannerTypedResult } from '../../contracts/planner-contract.js';
import { createExecutorContract } from '../../contracts/executor-contract.js';
import { createReviewerContract } from '../../contracts/reviewer-contract.js';
import { evaluateReviewerTerminalOutcome } from './reviewer-terminal-evaluation.js';
import { verifyTerminalToolOutcome } from './contract-terminal-tools.js';

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
  makePlanningProcessor(cardId: string): { recoverTerminalToolOutcome(input: CardActivationInput, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): Exclude<CardActivationOutcome, { status: 'cancelled' }> | null };
  makeTerminalProcessor(cardId: string): { recoverTerminalToolOutcome(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): Exclude<CardActivationOutcome, { status: 'cancelled' }> };
  generatedAt?: string;
}

export type LlmRecoveryRole = 'planner' | 'reviewer' | 'executor';

export interface CardActorRecoveryRecord {
  cardId: string;
  snapshot: ActorSnapshotRecord;
  active: boolean;
  activeReconstruction: CardActiveReconstructionRecord | null;
}

export interface LlmActorRecoveryRecord {
  actorId: string;
  role: LlmRecoveryRole;
  cardId: string;
  snapshot: ActorSnapshotRecord;
  active: boolean;
  activeReconstruction: LlmActiveReconstructionRecord | null;
}

export type LlmActorRecoveryPlanRecord = LlmActorRecoveryRecord & { action: LlmRecoveryAction };

export interface ProcessActorRecoveryRecord {
  processId: string;
  snapshot: ActorSnapshotRecord;
  action: ProcessRecoveryAction;
}

export type ProcessRecoveryAction = 'none' | 'abandon_running_process';

export type LlmRecoveryAction = 'none' | 'abandon_provider_call' | 'resume_tool_wait';

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
  kind: 'active_card' | 'active_llm' | 'llm_recovery_action' | 'active_processor' | 'running_process' | 'discarded_supervisor';
  action: string;
  cardId?: string;
  processId?: string;
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
  llms: LlmActorRecoveryPlanRecord[];
  processors: ProcessorActorRecoveryRecord[];
  processes: ProcessActorRecoveryRecord[];
  diagnostics: ActorRecoveryDiagnostic[];
}

export function buildActorRecoveryPlan(projectRoot: string, cards?: ActorRecoveryCardReader): ActorRecoveryPlan {
  const snapshots = readActorSnapshots(projectRoot);
  const supervisor = snapshots.find((snapshot) => snapshot.actor_id === 'supervisor') ?? null;
  const cardSnapshots = snapshots.filter((snapshot) => snapshot.actor_kind === 'card');
  const knownCardIds = new Set<string>();
  const cardRecords = cardSnapshots.map((snapshot): CardActorRecoveryRecord => {
    const cardId = parseCardActorId(snapshot.actor_id);
    const activeReconstruction = readActiveReconstruction<CardActiveReconstructionRecord>(snapshot);
    knownCardIds.add(cardId);
    return { cardId, snapshot, active: activeReconstruction !== null, activeReconstruction };
  });
  const llms = snapshots
    .filter((snapshot) => snapshot.actor_kind === 'llm')
    .map((snapshot): LlmActorRecoveryPlanRecord => {
      const parsed = parseLlmActorId(snapshot.actor_id);
      const activeReconstruction = readActiveReconstruction<LlmActiveReconstructionRecord>(snapshot);
      const active = activeReconstruction !== null;
      if (active && !knownCardIds.has(parsed.cardId) && !cards?.read(parsed.cardId)) {
        throw new Error(`Cannot recover active LLM actor '${snapshot.actor_id}': owner card '${parsed.cardId}' was not found.`);
      }
      return { actorId: snapshot.actor_id, role: parsed.role, cardId: parsed.cardId, snapshot, active, activeReconstruction, action: llmRecoveryAction(snapshot, active) };
    });
  const processors = snapshots
    .filter((snapshot) => snapshot.actor_kind === 'processor')
    .map((snapshot): ProcessorActorRecoveryRecord => {
      const activeReconstruction = readActiveReconstruction<ProcessorActiveReconstructionRecord>(snapshot);
      return {
        actorId: snapshot.actor_id,
        cardId: parseProcessorActorId(snapshot.actor_id),
        snapshot,
        active: activeReconstruction !== null,
        activeReconstruction,
      };
    });
  const processes = snapshots
    .filter((snapshot) => snapshot.actor_kind === 'process')
    .map((snapshot): ProcessActorRecoveryRecord => ({
      processId: parseProcessActorId(snapshot.actor_id),
      snapshot,
      action: processRecoveryAction(snapshot),
    }));
  return {
    supervisor,
    cards: cardRecords.sort((a, b) => a.cardId.localeCompare(b.cardId)),
    llms: llms.sort((a, b) => a.actorId.localeCompare(b.actorId)),
    processors: processors.sort((a, b) => a.actorId.localeCompare(b.actorId)),
    processes: processes.sort((a, b) => a.processId.localeCompare(b.processId)),
    diagnostics: recoveryDiagnostics(supervisor, cardRecords, llms, processors, processes, cards),
  };
}

const recoveryDiagnosticSchema = z.object({
  actorId: z.string().min(1),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().min(1),
});

const recoveryDiagnosticActionSchema = z.object({
  actorId: z.string().min(1),
  kind: z.enum(['active_card', 'active_llm', 'llm_recovery_action', 'active_processor', 'running_process', 'discarded_supervisor']),
  action: z.string().min(1),
  cardId: z.string().optional(),
  processId: z.string().optional(),
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
  const actions = recoveryDiagnosticActions(plan);
  if (plan.diagnostics.length === 0 && actions.length === 0) {
    clearRecoveryDiagnostics(projectRoot);
    return null;
  }
  const snapshot: ActorRecoveryDiagnosticsSnapshot = {
    schema_version: 1,
    generated_at: generatedAt,
    diagnostics: plan.diagnostics,
    actions,
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

export function cleanupHandledRecoverySnapshots(projectRoot: string, plan: ActorRecoveryPlan): void {
  for (const process of plan.processes) {
    if (process.action === 'abandon_running_process') removeActorSnapshot(projectRoot, process.snapshot.actor_id);
  }
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
      lifecycle: { status: 'blocked', result: { kind: 'planner_blocked', blocked_reason: reason, resume_reason: 'Inspect recovery diagnostics, then reactivate the card if the work should continue.', blocker_cause: 'generic' }, error: reason, completed_at: null },
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

export function recoverProjectedTerminalToolOutcomes(plan: ActorRecoveryPlan, deps: ActorRecoveryTerminalProjectionDeps): ActorRecoveryOutcomeConversion[] {
  const recovered: ActorRecoveryOutcomeConversion[] = [];
  const generatedAt = deps.generatedAt ?? new Date().toISOString();
  for (const llm of plan.llms) {
    if (!llm.active || llm.snapshot.state_value !== 'waiting_tool' || !llm.activeReconstruction?.waiting_tool_call) continue;
    const processor = plan.processors.find((candidate) => candidate.active && candidate.cardId === llm.cardId);
    const cardSnapshot = plan.cards.find((candidate) => candidate.active && candidate.cardId === llm.cardId);
    if (!processor?.activeReconstruction || !cardSnapshot?.activeReconstruction) continue;
    const card = deps.store.read(llm.cardId);
    if (!card || card.status !== 'running') continue;
    const waiting = llm.activeReconstruction.waiting_tool_call;
    const logged = readLoggedToolCall(deps.projectRoot, llm.actorId, waiting.sourceInputId, waiting.toolCallId);
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
  planner: LlmActorRecoveryPlanRecord,
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
  const reviewerLogged = readLoggedToolCall(deps.projectRoot, reviewer.actorId, reviewerWaiting.sourceInputId, reviewerWaiting.toolCallId);
  if (reviewerLogged.tool_name !== reviewerWaiting.toolName || !createReviewerContract().isTerminalToolName(reviewerWaiting.toolName)) return null;
  const reviewerOutcome: Extract<LLMActorOutcome, { type: 'tool_call' }> = { type: 'tool_call', agentId: reviewer.actorId, inputId: reviewerWaiting.sourceInputId, toolCallId: reviewerWaiting.toolCallId, toolName: reviewerWaiting.toolName, args: reviewerLogged.args };
  const projected = evaluateReviewerTerminalOutcome({
    card,
    candidatePlanning: { kind: 'planner_done', summary: plannerResult.result.summary ?? 'Planner completed.' },
    assessmentId,
    sessionId: reviewer.activeReconstruction.input.sessionId,
    outcome: reviewerOutcome,
    store: deps.store,
  });
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
    if (!llm.active || llm.action === 'resume_tool_wait') continue;
    addRecoveryOutcomeCandidate(candidates, llm.cardId, llm.actorId);
  }
  for (const processor of plan.processors) if (processor.active) addRecoveryOutcomeCandidate(candidates, processor.cardId, processor.actorId);
  return candidates;
}

function projectTerminalRecoveryOutcome(
  deps: ActorRecoveryTerminalProjectionDeps,
  processor: ProcessorActiveReconstructionRecord,
  card: CardRecord,
  cardReconstruction: CardActiveReconstructionRecord,
  outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>,
): Exclude<CardActivationOutcome, { status: 'cancelled' }> | null {
  const input: CardActivationInput = { card, caller: cardReconstruction.caller, notifications: [] };
  if (processor.processor_kind === 'planning') {
    if (!createPlannerContract().isTerminalToolName(outcome.toolName)) return null;
    return deps.makePlanningProcessor(card.id).recoverTerminalToolOutcome(input, outcome);
  }
  if (!createExecutorContract().isTerminalToolName(outcome.toolName)) return null;
  return deps.makeTerminalProcessor(card.id).recoverTerminalToolOutcome(outcome);
}

function descendantsAreComplete(cardId: string, store: ActorRecoveryOutcomeStore): boolean {
  if (!store.listChildren) return false;
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

function recoveryDiagnosticActions(plan: ActorRecoveryPlan): ActorRecoveryDiagnosticAction[] {
  return [
    ...(isNonIdleSupervisorSnapshot(plan.supervisor) ? [{ actorId: 'supervisor', kind: 'discarded_supervisor' as const, action: 'discard_stale_supervisor' }] : []),
    ...plan.cards.filter((card) => card.active).map((card) => ({ actorId: card.snapshot.actor_id, kind: 'active_card' as const, action: 'diagnose_active_card', cardId: card.cardId })),
    ...plan.llms.filter((llm) => llm.active).map((llm) => ({ actorId: llm.actorId, kind: 'active_llm' as const, action: 'diagnose_active_llm', cardId: llm.cardId })),
    ...plan.llms.filter((llm) => llm.action !== 'none').map((llm) => ({ actorId: llm.actorId, kind: 'llm_recovery_action' as const, action: llm.action, cardId: llm.cardId })),
    ...plan.processors.filter((processor) => processor.active).map((processor) => ({ actorId: processor.actorId, kind: 'active_processor' as const, action: 'diagnose_active_processor', cardId: processor.cardId })),
    ...plan.processes.filter((process) => process.action !== 'none').map((process) => ({ actorId: process.snapshot.actor_id, kind: 'running_process' as const, action: process.action, processId: process.processId })),
  ].sort((a, b) => a.actorId.localeCompare(b.actorId) || a.kind.localeCompare(b.kind));
}

function isNonIdleSupervisorSnapshot(snapshot: ActorSnapshotRecord | null): boolean {
  if (!snapshot) return false;
  const state = snapshot.state_value;
  if (typeof state !== 'object' || state === null || !('mode' in state)) return false;
  return (state as { mode?: unknown }).mode !== 'idle';
}

function llmRecoveryAction(snapshot: ActorSnapshotRecord, active: boolean): LlmRecoveryAction {
  if (!active) return 'none';
  if (snapshot.state_value === 'calling_provider') return 'abandon_provider_call';
  if (snapshot.state_value === 'waiting_tool') return 'resume_tool_wait';
  return 'none';
}

function readActiveReconstruction<T extends CardActiveReconstructionRecord | LlmActiveReconstructionRecord | ProcessorActiveReconstructionRecord>(snapshot: ActorSnapshotRecord): T | null {
  const record = snapshot.context.active_reconstruction;
  if (record === null || record === undefined) return null;
  if (typeof record !== 'object') throw new Error(`Actor snapshot '${snapshot.actor_id}' has invalid active_reconstruction.`);
  return record as T;
}

function processRecoveryAction(snapshot: ActorSnapshotRecord): ProcessRecoveryAction {
  if (snapshot.state_value === 'running' || snapshot.state_value === 'killing') return 'abandon_running_process';
  return 'none';
}

function parseCardActorId(actorId: string): string {
  if (!actorId.startsWith('card:')) throw new Error(`Expected card actor id, received '${actorId}'.`);
  return actorId.slice('card:'.length);
}

function parseLlmActorId(actorId: string): { role: LlmRecoveryRole; cardId: string } {
  for (const role of ['planner', 'reviewer', 'executor'] as const) {
    const prefix = `${role}:`;
    if (actorId.startsWith(prefix)) return { role, cardId: actorId.slice(prefix.length) };
  }
  throw new Error(`Expected LLM actor id, received '${actorId}'.`);
}

function parseProcessActorId(actorId: string): string {
  if (!actorId.startsWith('process:')) throw new Error(`Expected process actor id, received '${actorId}'.`);
  return actorId.slice('process:'.length);
}

function parseProcessorActorId(actorId: string): string {
  if (!actorId.startsWith('processor:')) throw new Error(`Expected processor actor id, received '${actorId}'.`);
  return actorId.slice('processor:'.length);
}

function recoveryDiagnostics(
  supervisor: ActorSnapshotRecord | null,
  cards: CardActorRecoveryRecord[],
  llms: LlmActorRecoveryPlanRecord[],
  processors: ProcessorActorRecoveryRecord[],
  processes: ProcessActorRecoveryRecord[],
  cardReader?: ActorRecoveryCardReader,
): ActorRecoveryDiagnostic[] {
  return [
    ...(isNonIdleSupervisorSnapshot(supervisor) ? [{ actorId: 'supervisor', severity: 'warning' as const, message: 'Non-idle supervisor snapshot is not resumed; startup creates a fresh supervisor and records this discard.' }] : []),
    ...cards.filter(isAmbiguousActiveCard).map((card) => ({ actorId: card.snapshot.actor_id, severity: 'warning' as const, message: `Active card snapshot has ambiguous state '${String(card.snapshot.state_value)}' and requires explicit recovery reconciliation.` })),
    ...cards.filter((card) => isStrandedActiveCard(card, cards, llms, processors, cardReader)).map((card) => ({ actorId: card.snapshot.actor_id, severity: 'warning' as const, message: 'Active card snapshot has no active processor, LLM, or active child evidence and cannot be safely reconstructed yet.' })),
    ...llms.filter((llm) => llm.action === 'abandon_provider_call').map((llm) => ({ actorId: llm.actorId, severity: 'warning' as const, message: 'In-flight provider call cannot be reattached and must be abandoned with a planner-visible diagnostic.' })),
    ...llms.filter((llm) => llm.action === 'resume_tool_wait').map((llm) => ({ actorId: llm.actorId, severity: 'info' as const, message: 'LLM actor is waiting for a persisted tool result and can resume delivery repair.' })),
    ...llms.filter((llm) => llm.active && llm.action === 'none').map((llm) => ({ actorId: llm.actorId, severity: 'warning' as const, message: `Active LLM snapshot state '${String(llm.snapshot.state_value)}' has no concrete recovery action yet.` })),
    ...processors.filter((processor) => processor.active).map((processor) => ({ actorId: processor.actorId, severity: 'warning' as const, message: 'Active processor snapshot requires reconstruction of activation/tool waits before autonomous execution resumes.' })),
    ...processes.filter((process) => process.action === 'abandon_running_process').map((process) => ({ actorId: process.snapshot.actor_id, severity: 'warning' as const, message: 'Running process snapshot is abandoned on startup because live process reattachment is not implemented; rerun the owning tool if the result is still needed.' })),
  ].sort((a, b) => a.actorId.localeCompare(b.actorId));
}

function isAmbiguousActiveCard(card: CardActorRecoveryRecord): boolean {
  return card.active && !isKnownCardActorState(card.snapshot.state_value);
}

function isKnownCardActorState(state: unknown): boolean {
  return state === 'backlog' || state === 'changed' || state === 'blocked' || state === 'failed' || state === 'done' || state === 'cancelled' || state === 'running';
}

function isStrandedActiveCard(
  card: CardActorRecoveryRecord,
  cards: CardActorRecoveryRecord[],
  llms: LlmActorRecoveryPlanRecord[],
  processors: ProcessorActorRecoveryRecord[],
  cardReader?: ActorRecoveryCardReader,
): boolean {
  if (!card.active) return false;
  if (processors.some((processor) => processor.active && processor.cardId === card.cardId)) return false;
  if (llms.some((llm) => llm.active && llm.cardId === card.cardId)) return false;
  const childIds = cardReader?.listChildren?.(card.cardId) ?? [];
  return !childIds.some((childId) => cards.some((candidate) => candidate.cardId === childId && candidate.active));
}
