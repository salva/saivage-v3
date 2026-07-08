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
