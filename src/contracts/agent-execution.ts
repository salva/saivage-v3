import type {
  RuntimeActivationRecord,
  RuntimeRunRecord,
  RuntimeState,
} from '../schemas/index.js';

export type PlannerStatus = 'done' | 'blocked' | 'failed';

export interface PlannerResult {
  status: PlannerStatus;
  summary: string;
}

export interface ExecutorResult {
  status: 'done' | 'failed' | 'blocked';
  summary: string;
}

export interface ReviewerResult {
  status: 'done' | 'rework' | 'blocked' | 'failed';
  summary: string;
}

export interface RuntimeActivationLedgerPort {
  readState(): RuntimeState | null;
  appendRun(input: Omit<RuntimeRunRecord, 'run_id' | 'started_at' | 'updated_at'> & Partial<Pick<RuntimeRunRecord, 'run_id' | 'started_at' | 'updated_at'>>): RuntimeRunRecord;
  upsertActivation(input: Omit<RuntimeActivationRecord, 'activation_id' | 'requested_at' | 'updated_at'> & Partial<Pick<RuntimeActivationRecord, 'activation_id' | 'requested_at' | 'updated_at'>>): RuntimeActivationRecord;
}
