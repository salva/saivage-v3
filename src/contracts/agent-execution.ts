import type {
  RuntimeActivationRecord,
  RuntimeRunRecord,
  RuntimeState,
} from '../schemas/index.js';

export type PlannerStatus = 'continue' | 'done' | 'blocked';

export interface PlannerResult {
  status: PlannerStatus;
  blocked_reason?: string;
  summary?: string;
}

export type ExecutorFallbackReason = 'tool_calls_envelope_recovery' | 'parse_failure';

export interface ExecutorResult {
  card_id: string;
  status: 'done' | 'failed';
  error?: string;
  result?: Record<string, unknown>;
  warnings: string[];
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

export interface RuntimeActivationLedgerPort {
  readState(): RuntimeState | null;
  appendRun(input: Omit<RuntimeRunRecord, 'run_id' | 'started_at' | 'updated_at'> & Partial<Pick<RuntimeRunRecord, 'run_id' | 'started_at' | 'updated_at'>>): RuntimeRunRecord;
  upsertActivation(input: Omit<RuntimeActivationRecord, 'activation_id' | 'requested_at' | 'updated_at'> & Partial<Pick<RuntimeActivationRecord, 'activation_id' | 'requested_at' | 'updated_at'>>): RuntimeActivationRecord;
}
