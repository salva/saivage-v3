import type { RuntimeState, RuntimeStatus } from '../schemas/index.js';
import type { ActorRuntimeReadModel } from '../application/read-models/actor-runtime-read-model.js';
import type { CardNotification } from '../schemas/index.js';
import type { CardCancellationResult } from './actors/card-activation-owner.js';
import type { NotificationUrgency } from '../contracts/builtin-tool-inputs.js';

interface RuntimeControlStateResult {
  runtime: RuntimeState | null;
  status: RuntimeStatus;
  started: boolean;
  stopped: boolean;
  error?: string;
}
export type StartProjectResult = RuntimeControlStateResult;
export interface StopProjectResult { readonly status: 'stopped'; readonly contained: boolean }

export type NotifyCardResult =
  | { ok: true; notificationId: string }
  | { ok: false; reason: 'missing_card'; cardId: string }
  | { ok: false; reason: 'terminal_card'; cardId: string; status: 'done' | 'failed' | 'cancelled' }
  | { ok: false; reason: 'activation_closed'; cardId: string };

type NotificationInterruptionResult =
  | { status: 'not_requested' }
  | { status: 'not_applicable' }
  | { status: 'pending_tool_settlement' }
  | { status: 'interrupted'; stopped_card_ids: string[] }
  | { status: 'suppressed'; reason: 'cancelled' | 'runtime_ineligible' | 'stale_owner'; stopped_card_ids: string[] };

export type NotificationSubmissionResult =
  | { queued: false; reason: 'planning_ineligible'; cardId: string }
  | { queued: false; reason: 'missing_card'; cardId: string }
  | { queued: false; reason: 'terminal_card'; cardId: string; status: 'done' | 'failed' | 'cancelled' }
  | { queued: false; reason: 'activation_closed'; cardId: string }
  | { queued: true; cardId: string; notificationId: string; interruption: NotificationInterruptionResult };

export type NotificationSubmissionPort = (
  cardId: string,
  notification: CardNotification,
  urgency: NotificationUrgency,
  signal?: AbortSignal,
) => Promise<NotificationSubmissionResult>;

export interface RuntimeApi {
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stopProject(): Promise<StopProjectResult>;
  cancelCard(cardId: string, reason: string): Promise<CardCancellationResult>;
  notifyCard(cardId: string, notification: CardNotification): NotifyCardResult;
  submitNotification(cardId: string, notification: CardNotification, urgency: NotificationUrgency, signal?: AbortSignal): Promise<NotificationSubmissionResult>;
  startProject(): Promise<StartProjectResult>;
  getStatus(): {
    status: RuntimeStatus;
    currentCardId: string | null;
    pid: number;
    startedAt: string;
  };
  getRuntimeState(): RuntimeState | null;
  getActorRuntimeReadModel(): ActorRuntimeReadModel;
}
export { OversightSession } from './actors/oversight-session.js';
export type { OversightCheckOutcome } from './actors/oversight-session.js';
export { createSupervisorRuntimeApi } from './actors/supervisor-runtime-api.js';

// Explicit cross-package runtime surface. Runtime implementation imports remain local.
export type { PlannerChildControlPort } from './actors/card-activation-owner.js';
export { compact, shouldCompact } from './actors/compaction/compactor.js';
export type { AutonomousCompactionPolicy } from './actors/compaction/compactor.js';
export { SUMMARY_REFINE_INSTRUCTION } from './actors/compaction/refine-accumulator.js';
export { SUMMARY_COMPLETION_TOKENS, admitSummaryRequest, assertSummarizerCapabilities, buildSummaryRequestInput } from './actors/compaction/summarizer.js';
export type { SummarizerProviderPort, SummaryRequestSerialization } from './actors/compaction/summarizer.js';
export { currentCoveredRequiredFactRows } from './actors/context/composition-projector.js';
export { compileInvocationToolContract } from './actors/context/context-blocks.js';
export type { ExecutingLlmSnapshot, LlmToolInvocationContext } from './actors/executing-llm-snapshot.js';
export type { LLMProviderPort } from './actors/llm-actor.js';
export type { CompactorPort } from './actors/llm-actor.js';
export type { LlmInvocationInput } from './actors/llm-invocation.js';
export { isRuntimeStoppedInterruption } from './actors/runtime-stopped-interruption.js';
export { bindRuntimeWorkflows, compileProjectWorkflows, genericRecordDefinition, runtimeAgentBinding } from './card-process/card-process-config.js';
export type { CompiledCardTypeWorkflow, CompiledProjectWorkflows, CompiledRuntimeWorkflows, ProcessPosition, WorkflowCompileOptions } from './card-process/card-process-config.js';
export { projectCompiledGraphs } from './card-process/compiled-graphs-projection.js';
export { propagateAnalystRecordEdit, propagateChange } from './changed-propagation.js';
export { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, redactCommandForPolicy, sanitizedCommandEnv } from './command-policy.js';
export { acquireRuntimeLifecycleLock, bindRuntimeLifecycleLock, publishRuntimeControlEndpoint, readRuntimeLockStatus, releaseRuntimeLifecycleLock, runtimeProcessIdentity } from './lock.js';
export type { RuntimeControlEndpoint, RuntimeLifecycleLockHandle, RuntimeProcessIdentity } from './lock.js';
export { ManagedProcessGroupRegistry } from './managed-process-group-registry.js';
export type { ManagedProcessScope, ProcessStopReport } from './managed-process-group-registry.js';
export { ProcessRunner } from './process-runner.js';
export type { ProcessCategory, ProcessRecord, ProcessWaitResult } from './process-runner.js';
export { RuntimeGate } from './runtime-gate.js';
export { AnalystRuntime, AnalystSession, AnalystTurnBusyError, AnalystWorkspaceContextBudgetError } from './actors/analyst-session.js';
export type { AnalystTurnInput } from './actors/analyst-session.js';
