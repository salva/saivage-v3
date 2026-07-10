import { createHash } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AtomicJsonFile, ProjectLock } from '../../persistence/index.js';
import { recoveryDiagnosticsFile as layoutRecoveryDiagnosticsFile, recoveryDiagnosticsLockFile } from '../../persistence/layout.js';
import { readActorSnapshots, removeActorSnapshot } from './snapshots.js';
import type { ActorSnapshotRecord } from './snapshots.js';
import { agentMessageSchema, type AgentMessage, type CardRecord, type CardStatus } from '../../schemas/index.js';
import type { CardActiveReconstructionRecord, LlmActiveReconstructionRecord, ProcessorActiveReconstructionRecord } from './active-reconstruction.js';
import { readCardActiveReconstruction, readLlmActiveReconstruction, readProcessorActiveReconstruction } from './active-reconstruction.js';
import { agentIdFromSessionId, cardIdFromSessionId, executorActorId, parseCardActorId, parseLlmActorId, parseProcessorActorId, plannerActorId } from './ids.js';
import type { LlmActorRole } from '../../schemas/actor-vocabulary.js';
import { cardActivationOutcomePatch, type CardActivationOutcome } from './card-actor.js';
import type { LLMActorOutcome } from './llm-actor.js';
import { abandonStalePendingToolCalls, appendTerminalProjectedToolResult, appendToolErrorSettlementResults, readLoggedToolCall } from './llm-delivery-log.js';
import { createPlannerContract, type PlannerTypedResult } from '../../contracts/planner-contract.js';
import { createExecutorContract } from '../../contracts/executor-contract.js';
import { createReviewerContract } from '../../contracts/reviewer-contract.js';
import { parseToolCallMessage } from '../../contracts/persisted-tool-call.js';
import { evaluateReviewerTerminalOutcome } from './reviewer-terminal-evaluation.js';
import { verifyTerminalToolOutcome } from './contract-terminal-tools.js';
import { closeOpenRecordSlot, ExpectedRecordSlotCloseError } from '../records/record-slots.js';
import { firstIncompleteDescendant, projectPlannerTerminalOutcome } from './planning-card-processor-actor.js';
import { projectTerminalExecutorOutcome } from './terminal-card-processor-actor.js';
import { nextReviewerAssessmentId, reviewerSessionId } from '../reviewer-session.js';
import { appendConversationMessage, listConversationSessionIds, readActiveVersionMessages } from './conversation-store.js';
import { classifyConversation, type ConversationImplicitState } from './conversation-recovery.js';
import { loggedToolCallIdentity, loggedToolCallKey, loggedToolErrorIdentity, loggedToolResultIdentity } from '../../schemas/message-identity.js';

export interface ActorRecoveryCardReader {
  read(cardId: string): unknown | null;
  listChildren?(cardId: string): string[];
}

export interface ActorRecoveryOutcomeStore {
  read(cardId: string): CardRecord | null;
  listChildren?(cardId: string): string[];
  setStatus(cardId: string, status: CardStatus): CardRecord;
  commitTerminalLifecyclePatch(cardId: string, changes: Partial<CardRecord>): CardRecord;
}

export interface ActorRecoveryOutcomeConversion {
  cardId: string;
  actorIds: string[];
  status: CardStatus;
  reason: string;
}

export interface ActorStartupRecoveryDeps {
  projectRoot: string;
  store: ActorRecoveryOutcomeStore;
  generatedAt?: string;
}

export type { LlmActorRole as LlmRecoveryRole } from '../../schemas/actor-vocabulary.js';
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

export type LlmRecoveryDiagnosticAction = 'none' | 'reissue_provider_call' | 'replay_tool_wait';

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
  kind: 'active_card' | 'active_llm' | 'llm_recovery_action' | 'active_processor';
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
  cards: CardActorRecoveryRecord[];
  llms: LlmActorRecoveryRecord[];
  processors: ProcessorActorRecoveryRecord[];
}

export interface ActorRecoveryProjection {
  diagnostics: ActorRecoveryDiagnostic[];
  actions: ActorRecoveryDiagnosticAction[];
}

interface LlmConversationRecoveryEntry {
  actorId: string;
  role: LlmRecoveryRole;
  cardId: string | null;
  sessionId: string;
  llm: LlmActorRecoveryRecord | null;
  conversation: ConversationImplicitState;
  terminalToolNames: ReadonlySet<string>;
  messages: readonly AgentMessage[];
}

type RecoverableLlmState = 'idle_or_absent' | 'calling_provider' | 'waiting_tool';

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

export const recoveryDiagnosticActionSchema = z.object({
  actorId: z.string().min(1),
  kind: z.enum(['active_card', 'active_llm', 'llm_recovery_action', 'active_processor']),
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
  return layoutRecoveryDiagnosticsFile(projectRoot);
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

export function runActorStartupRecovery(plan: ActorRecoveryPlan, deps: ActorStartupRecoveryDeps): ActorStartupRecoveryReport {
  const generatedAt = deps.generatedAt ?? new Date().toISOString();
  const cancelledCleanup = cleanupCancelledCardSnapshots(deps.projectRoot, plan, deps.store);
  const effectivePlan = cancelledCleanup.length > 0 ? buildActorRecoveryPlan(deps.projectRoot, deps.store) : plan;
  const nestedIncidents = recoverNestedActorConsistency(effectivePlan, { ...deps, generatedAt });
  const recoveries = recoverActorStartupOutcomes(effectivePlan, { ...deps, generatedAt });
  cleanupRecoveredActorSnapshots(deps.projectRoot, recoveries);
  const toolErrorSettlements = appendToolErrorSettlementResults(deps.projectRoot);
  const abandonedToolCalls = abandonStalePendingToolCalls(deps.projectRoot, undefined, nestedIncidents.preservedToolCallKeys);
  const postCleanupPlan = buildActorRecoveryPlan(deps.projectRoot, deps.store);
  const outstanding = writeRecoveryDiagnostics(deps.projectRoot, postCleanupPlan, generatedAt);
  return {
    generated_at: generatedAt,
    incidents: [
      ...cancelledCleanup,
      ...nestedIncidents.incidents,
      ...recoveries.map((recovery) => ({ actorId: recovery.actorIds[0] ?? recovery.cardId, kind: 'converted_actor_snapshots' as const, action: 'project_or_convert_startup_outcome', cardId: recovery.cardId, message: recovery.reason })),
      ...toolErrorSettlements.map((record) => ({ actorId: record.agent_id, kind: 'stale_tool_call' as const, action: 'settle_recovery_tool_error', message: record.error, cardId: record.card_id ?? cardIdFromAgentId(record.agent_id) })),
      ...abandonedToolCalls.map((record) => ({ actorId: record.agent_id, kind: 'stale_tool_call' as const, action: 'abandon_stale_pending_tool_call', message: record.error, cardId: record.card_id ?? cardIdFromAgentId(record.agent_id) })),
    ].sort((a, b) => a.actorId.localeCompare(b.actorId) || a.action.localeCompare(b.action)),
    outstanding,
  };
}

function recoverNestedActorConsistency(plan: ActorRecoveryPlan, deps: ActorStartupRecoveryDeps & { generatedAt: string }): { incidents: ActorStartupRecoveryIncident[]; preservedToolCallKeys: Set<string> } {
  const incidents: ActorStartupRecoveryIncident[] = [];
  const preservedToolCallKeys = new Set<string>();
  const entries = buildLlmConversationRecoveryEntries(plan, deps.projectRoot);
  for (const processor of plan.processors) {
    const card = deps.store.read(processor.cardId);
    if (!processor.active || !card || card.status === 'running') continue;
    removeActorSnapshot(deps.projectRoot, processor.actorId);
    incidents.push({ actorId: processor.actorId, kind: 'converted_actor_snapshots', action: 'cleanup_non_running_card_processor_snapshot', cardId: processor.cardId, message: `Startup recovery removed active processor snapshot '${processor.actorId}' because card '${processor.cardId}' is '${card.status}'.` });
  }

  for (const entry of entries) {
    const card = entry.cardId ? deps.store.read(entry.cardId) : null;
    const processor = entry.cardId ? plan.processors.find((candidate) => candidate.cardId === entry.cardId) ?? null : null;
    if (card && card.status !== 'running') {
      if (entry.llm?.active) {
        removeActorSnapshot(deps.projectRoot, entry.actorId);
        incidents.push({ actorId: entry.actorId, kind: 'converted_actor_snapshots', action: 'cleanup_non_running_card_llm_snapshot', cardId: entry.cardId ?? undefined, message: `Startup recovery removed active LLM snapshot '${entry.actorId}' because card '${card.id}' is '${card.status}'.` });
      }
      continue;
    }
    applyLlmRecoveryMatrix(deps.projectRoot, entry, processor, card, incidents, deps.store, preservedToolCallKeys);
    if (entry.llm?.active && card?.status === 'running' && !processor?.active && (entry.llm.snapshot.state_value === 'calling_provider' || entry.llm.snapshot.state_value === 'waiting_tool')) {
      removeActorSnapshot(deps.projectRoot, entry.actorId);
      incidents.push({ actorId: entry.actorId, kind: 'converted_actor_snapshots', action: 'cleanup_llm_without_active_processor', cardId: entry.cardId ?? undefined, message: `Startup recovery removed active LLM snapshot '${entry.actorId}' because its card has no active processor snapshot.` });
    }
  }
  const relinkedActivationChildIds = new Set(entries.flatMap((entry) => {
    const key = danglingToolCallKey(entry);
    const childId = danglingActivateCardChildId(entry);
    return key && childId && preservedToolCallKeys.has(key) ? [childId] : [];
  }));
  for (const cardRecord of plan.cards) {
    const card = deps.store.read(cardRecord.cardId);
    if (cardRecord.activeReconstruction?.caller.kind !== 'parent') continue;
    if (!card || card.status !== 'running' || card.id === 'project' || relinkedActivationChildIds.has(card.id)) continue;
    incidents.push({ actorId: cardRecord.snapshot.actor_id, kind: 'active_card', action: 'promote_orphan_running_card', cardId: card.id, message: `Startup recovery found running card '${card.id}' without a relinked parent activate_card edge; it remains running as root-level recoverable work.` });
  }
  return { incidents, preservedToolCallKeys };
}

function applyLlmRecoveryMatrix(projectRoot: string, entry: LlmConversationRecoveryEntry, processor: ProcessorActorRecoveryRecord | null, card: CardRecord | null, incidents: ActorStartupRecoveryIncident[], store: ActorRecoveryOutcomeStore, preservedToolCallKeys: Set<string>): void {
  const llmState = entryLlmState(entry);
  switch (llmState) {
    case 'idle_or_absent':
      applyIdleOrAbsentEntry(projectRoot, entry, processor, card, incidents, store);
      return;
    case 'calling_provider':
      applyCallingProviderEntry(projectRoot, entry, incidents);
      return;
    case 'waiting_tool':
      applyWaitingToolEntry(projectRoot, entry, processor, card, incidents, store, preservedToolCallKeys);
      return;
  }
}

function applyIdleOrAbsentEntry(projectRoot: string, entry: LlmConversationRecoveryEntry, processor: ProcessorActorRecoveryRecord | null, card: CardRecord | null, incidents: ActorStartupRecoveryIncident[], store: ActorRecoveryOutcomeStore): void {
  switch (entry.conversation) {
    case 'empty':
    case 'system_prompt_only':
    case 'pending_provider':
    case 'settled_terminal':
      return;
    case 'awaiting_tool_result':
      reportDanglingAwaitingTool(entry, processor, card, incidents, store, new Set());
      return;
    case 'assistant_text_pending':
      appendPlainTextRecoveryRepair(projectRoot, entry);
      incidents.push({ actorId: entry.actorId, kind: 'stale_tool_call', action: 'repair_assistant_text_pending', cardId: entry.cardId ?? undefined, message: `Startup recovery appended a model repair directive for assistant text in session '${entry.sessionId}'.` });
      return;
  }
}

function applyCallingProviderEntry(projectRoot: string, entry: LlmConversationRecoveryEntry, incidents: ActorStartupRecoveryIncident[]): void {
  switch (entry.conversation) {
    case 'system_prompt_only':
    case 'pending_provider':
      if (conversationNeedsProviderVisibleToolErrorSettlement(entry)) removeIncompatibleLlmSnapshot(projectRoot, entry, incidents, 'cleanup_provider_snapshot_for_tool_error_settlement', `Startup recovery removed provider snapshot '${entry.actorId}' so provider reissue reloads synthetic tool_error settlement rows from the active conversation.`);
      return;
    case 'empty':
    case 'awaiting_tool_result':
    case 'settled_terminal':
      removeIncompatibleLlmSnapshot(projectRoot, entry, incidents, 'cleanup_incompatible_provider_snapshot', `Startup recovery removed provider snapshot '${entry.actorId}' for incompatible conversation state '${entry.conversation}'.`);
      return;
    case 'assistant_text_pending':
      appendPlainTextRecoveryRepair(projectRoot, entry);
      removeIncompatibleLlmSnapshot(projectRoot, entry, incidents, 'repair_assistant_text_pending_provider_snapshot', `Startup recovery appended a repair directive and removed stale provider snapshot '${entry.actorId}'.`);
      return;
  }
}

function applyWaitingToolEntry(projectRoot: string, entry: LlmConversationRecoveryEntry, processor: ProcessorActorRecoveryRecord | null, card: CardRecord | null, incidents: ActorStartupRecoveryIncident[], store: ActorRecoveryOutcomeStore, preservedToolCallKeys: Set<string>): void {
  switch (entry.conversation) {
    case 'awaiting_tool_result':
      reportDanglingAwaitingTool(entry, processor, card, incidents, store, preservedToolCallKeys);
      return;
    case 'empty':
    case 'system_prompt_only':
    case 'settled_terminal':
    case 'pending_provider':
      removeIncompatibleLlmSnapshot(projectRoot, entry, incidents, 'cleanup_incompatible_waiting_tool_snapshot', `Startup recovery removed waiting_tool snapshot '${entry.actorId}' for conversation state '${entry.conversation}'.`);
      return;
    case 'assistant_text_pending':
      appendPlainTextRecoveryRepair(projectRoot, entry);
      removeIncompatibleLlmSnapshot(projectRoot, entry, incidents, 'repair_assistant_text_pending_wait_snapshot', `Startup recovery appended a repair directive and removed stale waiting_tool snapshot '${entry.actorId}'.`);
      return;
  }
}

function entryLlmState(entry: LlmConversationRecoveryEntry): RecoverableLlmState {
  if (!entry.llm?.active) return 'idle_or_absent';
  if (entry.llm.snapshot.state_value === 'calling_provider') return 'calling_provider';
  if (entry.llm.snapshot.state_value === 'waiting_tool') return 'waiting_tool';
  return 'idle_or_absent';
}

function reportDanglingAwaitingTool(entry: LlmConversationRecoveryEntry, processor: ProcessorActorRecoveryRecord | null, card: CardRecord | null, incidents: ActorStartupRecoveryIncident[], store: ActorRecoveryOutcomeStore, preservedToolCallKeys: Set<string>): void {
  if (!danglingActivateCardCall(entry)) return;
  const childId = danglingActivateCardChildId(entry);
  const child = childId ? store.read(childId) : null;
  if (canPreserveExistingActivationWait(entry, processor, card, child)) {
    const key = danglingToolCallKey(entry);
    if (!key) throw new Error(`Cannot preserve activation wait for session '${entry.sessionId}': dangling activate_card call has malformed identity.`);
    preservedToolCallKeys.add(key);
    incidents.push({ actorId: entry.actorId, kind: 'stale_tool_call', action: 'relink_existing_activation_wait', cardId: entry.cardId ?? undefined, message: `Startup recovery preserved existing waiting_tool continuation for running child '${childId}'.` });
    return;
  }
  const reason = child?.status === 'running'
    ? `child '${childId}' is running, but startup recovery has no deterministic child-completion registration surface to relink the parent wait`
    : `child '${childId ?? 'unknown'}' is not a compatible running child`;
  incidents.push({ actorId: entry.actorId, kind: 'stale_tool_call', action: 'fail_unrelinked_activation_wait', cardId: entry.cardId ?? undefined, message: `Startup recovery could not reconstruct a concrete activate_card continuation for session '${entry.sessionId}' because ${reason}; the dangling call will receive an actionable failed tool result.` });
}

function canPreserveExistingActivationWait(entry: LlmConversationRecoveryEntry, processor: ProcessorActorRecoveryRecord | null, card: CardRecord | null, child: CardRecord | null): boolean {
  const waiting = entry.llm?.activeReconstruction?.waiting_tool_call;
  if (!waiting || entry.llm?.snapshot.state_value !== 'waiting_tool') return false;
  if (!processor?.active || !card || card.status !== 'running') return false;
  if (!child || child.status !== 'running') return false;
  const call = lastDanglingToolCall(entry);
  if (!call || call.tool !== 'activate_card') return false;
  const identity = safeToolCallIdentity(call);
  return identity !== null && identity.session_id === entry.sessionId && identity.source_input_id === waiting.sourceInputId && identity.tool_call_id === waiting.toolCallId;
}

function danglingToolCallKey(entry: LlmConversationRecoveryEntry): string | null {
  const call = lastDanglingToolCall(entry);
  const identity = call ? safeToolCallIdentity(call) : null;
  return identity ? loggedToolCallKey(identity) : null;
}

function removeIncompatibleLlmSnapshot(projectRoot: string, entry: LlmConversationRecoveryEntry, incidents: ActorStartupRecoveryIncident[], action: string, message: string): void {
  if (!entry.llm) return;
  removeActorSnapshot(projectRoot, entry.actorId);
  incidents.push({ actorId: entry.actorId, kind: 'converted_actor_snapshots', action, cardId: entry.cardId ?? undefined, message });
}

function buildLlmConversationRecoveryEntries(plan: ActorRecoveryPlan, projectRoot: string): LlmConversationRecoveryEntry[] {
  const bySession = new Map<string, LlmConversationRecoveryEntry>();
  for (const llm of plan.llms) {
    const sessionId = llm.activeReconstruction?.input.sessionId ?? llm.actorId;
    bySession.set(sessionId, buildLlmConversationRecoveryEntry(projectRoot, llm.actorId, llm.role, llm.cardId, sessionId, llm));
  }
  for (const sessionId of listConversationSessionIds(projectRoot)) {
    if (bySession.has(sessionId)) continue;
    const roleCard = roleCardFromSession(sessionId);
    bySession.set(sessionId, buildLlmConversationRecoveryEntry(projectRoot, agentIdFromSessionId(sessionId), roleCard.role, roleCard.cardId, sessionId, null));
  }
  for (const processor of plan.processors) {
    const role = processor.activeReconstruction?.processor_kind === 'terminal' ? 'executor' : 'planner';
    const actorId = role === 'executor' ? executorActorId(processor.cardId) : plannerActorId(processor.cardId);
    const sessionId = actorId;
    if (!bySession.has(sessionId)) bySession.set(sessionId, buildLlmConversationRecoveryEntry(projectRoot, actorId, role, processor.cardId, sessionId, null));
  }
  return [...bySession.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

function buildLlmConversationRecoveryEntry(projectRoot: string, actorId: string, role: LlmRecoveryRole, cardId: string | null, sessionId: string, llm: LlmActorRecoveryRecord | null): LlmConversationRecoveryEntry {
  const terminalToolNames = terminalToolNamesForRole(role);
  const messages = readActiveVersionMessages(projectRoot, sessionId);
  return { actorId, role, cardId, sessionId, llm, terminalToolNames, messages, conversation: classifyConversation(messages, terminalToolNames) };
}

function roleCardFromSession(sessionId: string): { role: LlmRecoveryRole; cardId: string | null } {
  const parsed = parseLlmActorId(agentIdFromSessionId(sessionId));
  return { role: parsed.role, cardId: cardIdFromSessionId(sessionId) ?? parsed.cardId };
}

function terminalToolNamesForRole(role: LlmRecoveryRole): ReadonlySet<string> {
  if (role === 'planner') return new Set(createPlannerContract().terminals.map((terminal) => terminal.name));
  if (role === 'reviewer') return new Set(createReviewerContract().terminals.map((terminal) => terminal.name));
  if (role === 'executor') return new Set(createExecutorContract().terminals.map((terminal) => terminal.name));
  return new Set();
}

function danglingActivateCardCall(entry: LlmConversationRecoveryEntry): boolean {
  if (entry.conversation !== 'awaiting_tool_result') return false;
  const lastCall = lastDanglingToolCall(entry);
  return lastCall?.tool === 'activate_card';
}

function danglingActivateCardChildId(entry: LlmConversationRecoveryEntry): string | null {
  if (!danglingActivateCardCall(entry)) return null;
  const lastCall = lastDanglingToolCall(entry);
  if (!lastCall) return null;
  try {
    const args = parseToolCallMessage(JSON.parse(lastCall.content)).args;
    const value = typeof args === 'object' && args !== null ? (args as { card_id?: unknown; child_card_id?: unknown }).card_id ?? (args as { child_card_id?: unknown }).child_card_id : null;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function lastDanglingToolCall(entry: LlmConversationRecoveryEntry): AgentMessage | null {
  return [...entry.messages].reverse().find((message) => message.kind === 'tool_call') ?? null;
}

function conversationNeedsProviderVisibleToolErrorSettlement(entry: LlmConversationRecoveryEntry): boolean {
  const resultKeys = new Set<string>();
  const errorKeys = new Set<string>();
  for (const message of entry.messages) {
    const resultIdentity = safeToolResultIdentity(message);
    if (resultIdentity) resultKeys.add(loggedToolCallKey(resultIdentity));
    const errorIdentity = safeToolErrorIdentity(message);
    if (errorIdentity) errorKeys.add(loggedToolCallKey(errorIdentity));
  }
  for (const key of errorKeys) if (!resultKeys.has(key)) return true;
  return false;
}

function safeToolResultIdentity(message: AgentMessage) {
  try { return loggedToolResultIdentity(message); } catch { return null; }
}

function safeToolCallIdentity(message: AgentMessage) {
  try { return loggedToolCallIdentity(message); } catch { return null; }
}

function safeToolErrorIdentity(message: AgentMessage) {
  try { return loggedToolErrorIdentity(message); } catch { return null; }
}

function appendPlainTextRecoveryRepair(projectRoot: string, entry: LlmConversationRecoveryEntry): void {
  const last = entry.messages.at(-1);
  const seed = last?.id ?? `${entry.sessionId}:recovery`;
  appendConversationMessage(projectRoot, agentMessageSchema.parse({
    id: `${seed}:startup-repair`,
    session_id: entry.sessionId,
    role: 'user',
    kind: 'model_repair',
    content: 'Startup recovery found an assistant plain-text response where a tool call or terminal action was required. Continue by using the available tools and repair the turn.',
    round_id: `r-user-${createHash('sha256').update(`${seed}:startup-repair`).digest('hex').slice(0, 32)}`,
    message_index: 3,
    block_index: 0,
    timestamp: new Date().toISOString(),
  }));
}

function cleanupRecoveredActorSnapshots(projectRoot: string, recoveries: ActorRecoveryOutcomeConversion[]): void {
  for (const recovery of recoveries) {
    for (const actorId of recovery.actorIds) removeActorSnapshot(projectRoot, actorId);
  }
}

export function cleanupCancelledCardSnapshots(projectRoot: string, plan: ActorRecoveryPlan, store: ActorRecoveryOutcomeStore): ActorStartupRecoveryIncident[] {
  const actorIds = new Map<string, Set<string>>();
  for (const card of plan.cards) addCardSnapshotActor(actorIds, card.cardId, card.snapshot.actor_id);
  for (const processor of plan.processors) addCardSnapshotActor(actorIds, processor.cardId, processor.actorId);
  for (const llm of plan.llms) if (llm.cardId !== null) addCardSnapshotActor(actorIds, llm.cardId, llm.actorId);

  const incidents: ActorStartupRecoveryIncident[] = [];
  for (const [cardId, ids] of actorIds) {
    if (store.read(cardId)?.status !== 'cancelled') continue;
    for (const actorId of ids) removeActorSnapshot(projectRoot, actorId);
    incidents.push({
      actorId: [...ids].sort()[0] ?? cardId,
      kind: 'converted_actor_snapshots',
      action: 'cleanup_cancelled_card_snapshots',
      cardId,
      message: `Startup recovery removed stale actor snapshots for cancelled card '${cardId}'.`,
    });
  }
  return incidents.sort((a, b) => a.actorId.localeCompare(b.actorId));
}

export function recoverActorStartupOutcomes(plan: ActorRecoveryPlan, deps: ActorStartupRecoveryDeps): ActorRecoveryOutcomeConversion[] {
  return recoverProjectedTerminalToolOutcomes(plan, deps);
}

export function recoverProjectedTerminalToolOutcomes(plan: ActorRecoveryPlan, deps: ActorStartupRecoveryDeps): ActorRecoveryOutcomeConversion[] {
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
    appendTerminalProjectedToolResult(deps.projectRoot, {
      sessionId: llm.activeReconstruction.input.sessionId,
      sourceInputId: waiting.sourceInputId,
      toolCallId: waiting.toolCallId,
      toolName: waiting.toolName,
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
  deps: ActorStartupRecoveryDeps,
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
  if (firstIncompleteDescendant(card.id, deps.store)) return null;
  const reviewer = plan.llms.find((candidate) => candidate.active && candidate.role === 'reviewer' && candidate.cardId === card.id && candidate.snapshot.state_value === 'waiting_tool' && candidate.activeReconstruction?.waiting_tool_call);
  if (!reviewer?.activeReconstruction?.waiting_tool_call) return null;
  const assessmentId = nextReviewerAssessmentId(card.id, card.lifecycle.result);
  const sessionId = reviewerSessionId(card.id, assessmentId);
  const reviewerWaiting = reviewer.activeReconstruction.waiting_tool_call;
  const reviewerLogged = readLoggedToolCall(deps.projectRoot, sessionId, reviewer.actorId, reviewerWaiting.sourceInputId, reviewerWaiting.toolCallId);
  if (reviewerLogged.tool_name !== reviewerWaiting.toolName || !createReviewerContract().isTerminalToolName(reviewerWaiting.toolName)) return null;
  const reviewerOutcome: Extract<LLMActorOutcome, { type: 'tool_call' }> = { type: 'tool_call', agentId: reviewer.actorId, inputId: reviewerWaiting.sourceInputId, toolCallId: reviewerWaiting.toolCallId, toolName: reviewerWaiting.toolName, args: reviewerLogged.args };
  const projected = evaluateReviewerTerminalOutcome({ outcome: reviewerOutcome });
  if (!closeRecoveredRecordSlot(deps.projectRoot, card.id, 'status.md', 'planner', card.version_seq)) return null;
  if (!closeRecoveredRecordSlot(deps.projectRoot, card.id, 'review.md', 'reviewer', card.version_seq)) return null;
  deps.store.commitTerminalLifecyclePatch(card.id, cardActivationOutcomePatch(projected, generatedAt));
  const plannerWaiting = planner.activeReconstruction!.waiting_tool_call!;
  appendTerminalProjectedToolResult(deps.projectRoot, { sessionId: planner.activeReconstruction!.input.sessionId, sourceInputId: plannerWaiting.sourceInputId, toolCallId: plannerWaiting.toolCallId, toolName: plannerWaiting.toolName });
  appendTerminalProjectedToolResult(deps.projectRoot, { sessionId, sourceInputId: reviewerWaiting.sourceInputId, toolCallId: reviewerWaiting.toolCallId, toolName: reviewerWaiting.toolName });
  return {
    cardId: card.id,
    actorIds: [cardSnapshot.snapshot.actor_id, processor.actorId, planner.actorId, reviewer.actorId].sort(),
    status: projected.status,
    reason: 'Startup recovery projected persisted planner and reviewer terminal tool call outcomes.',
  };
}

function projectTerminalRecoveryOutcome(
  deps: ActorStartupRecoveryDeps,
  processor: ProcessorActiveReconstructionRecord,
  card: CardRecord,
  _cardReconstruction: CardActiveReconstructionRecord,
  outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>,
): Exclude<CardActivationOutcome, { status: 'cancelled' }> | null {
  if (processor.processor_kind === 'planning') {
    if (!createPlannerContract().isTerminalToolName(outcome.toolName)) return null;
    const projected = projectPlannerTerminalOutcome(outcome);
    if (!projected) return null;
    if (!closeRecoveredRecordSlot(deps.projectRoot, card.id, 'status.md', 'planner', card.version_seq)) return null;
    return projected;
  }
  if (!createExecutorContract().isTerminalToolName(outcome.toolName)) return null;
  const projected = projectTerminalExecutorOutcome(outcome);
  if (!projected) return null;
  if (!closeRecoveredRecordSlot(deps.projectRoot, card.id, 'status.md', 'executor', card.version_seq)) return null;
  return projected;
}

function closeRecoveredRecordSlot(projectRoot: string, cardId: string, filename: 'status.md' | 'review.md', writer: 'planner' | 'executor' | 'reviewer', cardVersionSeq: number): boolean {
  try {
    closeOpenRecordSlot(projectRoot, { cardId, filename, writer, cardVersionSeq });
    return true;
  } catch (error) {
    if (error instanceof ExpectedRecordSlotCloseError) return false;
    throw error;
  }
}

function addCardSnapshotActor(actorsByCard: Map<string, Set<string>>, cardId: string, actorId: string): void {
  const actorIds = actorsByCard.get(cardId) ?? new Set<string>();
  actorIds.add(actorId);
  actorsByCard.set(cardId, actorIds);
}

function recoveryDiagnosticsLock(projectRoot: string): ProjectLock {
  return new ProjectLock(recoveryDiagnosticsLockFile(projectRoot), { staleLockAction: 'remove' });
}

function recoveryDiagnosticsFile(projectRoot: string, lock: ProjectLock = recoveryDiagnosticsLock(projectRoot)): AtomicJsonFile<ActorRecoveryDiagnosticsSnapshot> {
  return new AtomicJsonFile(recoveryDiagnosticsPath(projectRoot), recoveryDiagnosticsSnapshotSchema, lock, { version: null });
}

export function projectActorRecovery(plan: ActorRecoveryPlan, cardReader?: ActorRecoveryCardReader): ActorRecoveryProjection {
  const llmActions = new Map(plan.llms.map((llm) => [llm.actorId, llmRecoveryDiagnosticAction(llm.snapshot, llm.active)]));
  const actions: ActorRecoveryDiagnosticAction[] = [
    ...plan.cards.filter((card) => card.active).map((card) => ({ actorId: card.snapshot.actor_id, kind: 'active_card' as const, action: 'diagnose_active_card', cardId: card.cardId })),
    ...plan.llms.filter((llm) => llm.active).map((llm) => ({ actorId: llm.actorId, kind: 'active_llm' as const, action: 'diagnose_active_llm', cardId: llm.cardId ?? undefined })),
    ...plan.llms.filter((llm) => llmActions.get(llm.actorId) !== 'none').map((llm) => ({ actorId: llm.actorId, kind: 'llm_recovery_action' as const, action: llmActions.get(llm.actorId)!, cardId: llm.cardId ?? undefined })),
    ...plan.processors.filter((processor) => processor.active).map((processor) => ({ actorId: processor.actorId, kind: 'active_processor' as const, action: 'diagnose_active_processor', cardId: processor.cardId })),
  ].sort((a, b) => a.actorId.localeCompare(b.actorId) || a.kind.localeCompare(b.kind));
  return { diagnostics: recoveryDiagnostics(plan, llmActions, cardReader), actions };
}

function llmRecoveryDiagnosticAction(snapshot: ActorSnapshotRecord, active: boolean): LlmRecoveryDiagnosticAction {
  if (!active) return 'none';
  if (snapshot.state_value === 'calling_provider') return 'reissue_provider_call';
  if (snapshot.state_value === 'waiting_tool') return 'replay_tool_wait';
  return 'none';
}

function recoveryDiagnostics(
  plan: ActorRecoveryPlan,
  llmActions: Map<string, LlmRecoveryDiagnosticAction>,
  cardReader?: ActorRecoveryCardReader,
): ActorRecoveryDiagnostic[] {
  const { cards, llms, processors } = plan;
  return [
    ...cards.filter(hasUnknownCardActorLifecycleState).map((card) => ({ actorId: card.snapshot.actor_id, severity: 'warning' as const, message: `Card actor snapshot has unknown lifecycle state '${String(card.snapshot.state_value)}'.` })),
    ...cards.filter(isAmbiguousActiveCard).map((card) => ({ actorId: card.snapshot.actor_id, severity: 'warning' as const, message: `Active card snapshot has lifecycle state '${String(card.snapshot.state_value)}' and requires explicit recovery reconciliation.` })),
    ...cards.filter((card) => isStrandedActiveCard(card, cards, llms, processors, cardReader)).map((card) => ({ actorId: card.snapshot.actor_id, severity: 'warning' as const, message: 'Active card snapshot has no active processor, LLM, or active child evidence and cannot be safely reconstructed yet.' })),
    ...llms.filter((llm) => llmActions.get(llm.actorId) === 'reissue_provider_call').map((llm) => ({ actorId: llm.actorId, severity: 'warning' as const, message: 'In-flight provider call will be re-issued from the reconstructed LLM input when the runtime resumes.' })),
    ...llms.filter((llm) => llmActions.get(llm.actorId) === 'replay_tool_wait').map((llm) => ({ actorId: llm.actorId, severity: 'warning' as const, message: 'LLM actor is waiting for a persisted tool call; startup recovery will replay or redispatch it without changing card status.' })),
    ...llms.filter((llm) => llm.active && llmActions.get(llm.actorId) === 'none').map((llm) => ({ actorId: llm.actorId, severity: 'warning' as const, message: `Active LLM snapshot state '${String(llm.snapshot.state_value)}' has no concrete recovery action yet.` })),
    ...processors.filter((processor) => processor.active).map((processor) => ({ actorId: processor.actorId, severity: 'warning' as const, message: 'Active processor snapshot requires reconstruction of activation/tool waits before autonomous execution resumes.' })),
  ].sort((a, b) => a.actorId.localeCompare(b.actorId));
}

function cardIdFromAgentId(agentId: string): string | undefined {
  const separator = agentId.indexOf(':');
  return separator === -1 ? undefined : agentId.slice(separator + 1);
}

function isAmbiguousActiveCard(card: CardActorRecoveryRecord): boolean {
  return card.active && card.snapshot.state_value !== 'running';
}

function hasUnknownCardActorLifecycleState(card: CardActorRecoveryRecord): boolean {
  return !isKnownCardActorLifecycleState(card.snapshot.state_value);
}

function isKnownCardActorLifecycleState(state: unknown): boolean {
  return state === 'parked' || state === 'running' || state === 'cancelled';
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
