import type {
  AgentMessage,
  RuntimeActivationRecord,
  HandoffSummary,
  RuntimeRunRecord,
  RuntimeState,
} from '../schemas/index.js';
import type { Contract } from './contract.js';
import type { PlannerEnvelope, PlannerTypedResult } from './planner-contract.js';
import type { ExecutorResultEnvelope } from './executor-envelope.js';
import type { ReviewerResultEnvelope } from './reviewer-envelope.js';

export type PlannerStatus = 'continue' | 'done' | 'blocked';

export interface PlannerResult {
  status: PlannerStatus;
  blocked_reason?: string;
  summary?: string;
}

export interface PlannerActivationBarrierRequest {
  activation: RuntimeActivationRecord;
}

export interface PlannerActivationBarrier {
  dispatch(input: PlannerActivationBarrierRequest): Promise<void> | void;
}

export interface ExecutorArtifactDef {
  type: 'model' | 'data' | 'config' | 'log' | 'report' | 'other';
  description: string;
  retain: boolean;
  sourceFile?: string;
  path?: string;
}

export interface ExecutorAttachmentDef {
  mime: string;
  title: string;
  description?: string;
  sourceFile?: string;
  path?: string;
}

export type ExecutorFallbackReason = 'tool_calls_envelope_recovery' | 'parse_failure';

export interface ExecutorResult {
  card_id: string;
  status: 'done' | 'failed';
  error?: string;
  result?: Record<string, unknown>;
  artifacts: ExecutorArtifactDef[];
  attachments: ExecutorAttachmentDef[];
  summary?: string;
  status_text: string;
  fallback_with_evidence: { reason: ExecutorFallbackReason } | null;
}

export interface ReviewerIssue {
  summary: string;
  severity: 'info' | 'warning' | 'blocker';
  evidence_card_id?: string;
  recommendation?: string;
}

export interface ReviewerResult {
  assessment: {
    result: 'pass' | 'needs_corrections';
    summary: string;
    achieved: string[];
    issues: ReviewerIssue[];
    evidence_card_ids: string[];
  };
}

export interface PlannerInvocationRequest {
  goalId: string;
  systemPrompt?: string;
  contextMessages?: AgentMessage[];
  contract: Contract<PlannerEnvelope, PlannerTypedResult>;
  activationBarrier?: PlannerActivationBarrier;
}

export interface ExecutorInvocationRequest {
  cardId: string;
  goalId: string;
  systemPrompt?: string;
  contextMessages?: AgentMessage[];
  contract: Contract<ExecutorResultEnvelope, ExecutorResult>;
}

export interface ReviewerInvocationRequest {
  goalId: string;
  systemPrompt?: string;
  contextMessages?: AgentMessage[];
  assessmentId: string;
  reviewerSessionId?: string;
  contract: Contract<ReviewerResultEnvelope, ReviewerResult>;
}

export interface SessionReinvokeRequest {
  sessionId: string;
  systemPrompt?: string;
  contextMessages?: AgentMessage[];
}

export interface AgentExecutionPort {
  invokePlanner(request: PlannerInvocationRequest): PlannerResult | Promise<PlannerResult>;
  invokeExecutor(request: ExecutorInvocationRequest): ExecutorResult | Promise<ExecutorResult>;
  invokeReviewer(request: ReviewerInvocationRequest): ReviewerResult | Promise<ReviewerResult>;
  reinvokeSession?(request: SessionReinvokeRequest): Promise<ExecutorResult | ReviewerResult> | ExecutorResult | ReviewerResult;
  cancelSession(sessionId: string): boolean | Promise<boolean>;
  forceCancelSession(sessionId: string): boolean | Promise<boolean>;
  getHandoffSummary(sessionId: string): HandoffSummary | null | Promise<HandoffSummary | null>;
  getActiveSessionHandoffs(): HandoffSummary[] | Promise<HandoffSummary[]>;
}

export interface RuntimeActivationLedgerPort {
  readState(): RuntimeState | null;
  appendRun(input: Omit<RuntimeRunRecord, 'run_id' | 'started_at' | 'updated_at'> & Partial<Pick<RuntimeRunRecord, 'run_id' | 'started_at' | 'updated_at'>>): RuntimeRunRecord;
  upsertActivation(input: Omit<RuntimeActivationRecord, 'activation_id' | 'requested_at' | 'updated_at'> & Partial<Pick<RuntimeActivationRecord, 'activation_id' | 'requested_at' | 'updated_at'>>): RuntimeActivationRecord;
}

export interface RuntimeStateSnapshotPort {
  readState(): RuntimeState | null;
}
