export type ExecutorPhaseOutcome =
  | { role: 'executor'; kind: 'succeeded'; card_id: string; goal_id: string; summary: string; status_text: string; result: Record<string, unknown>; accepted_at: string; session_id: string | null }
  | { role: 'executor'; kind: 'failed'; card_id: string; goal_id: string; summary: string; status_text: string; error: string; partial_result: Record<string, unknown> | null; accepted_at: string; session_id: string | null }
  | { role: 'executor'; kind: 'needs_verification'; card_id: string; goal_id: string; reason: string; preserved_result: Record<string, unknown>; fallback_reason: string | null; accepted_at: string; session_id: string | null };

export type ReviewerPhaseOutcome =
  | { role: 'reviewer'; kind: 'pass'; goal_id: string; assessment_id: string; review_summary: string }
  | { role: 'reviewer'; kind: 'needs_corrections'; goal_id: string; assessment_id: string; summary: string; issues: Array<Record<string, unknown>> };

export type PlannerPhaseOutcome =
  | { role: 'planner'; kind: 'done'; card_id: string; summary: string }
  | { role: 'planner'; kind: 'blocked'; card_id: string; blocked_reason: string; resume_reason: string };

export type PhaseOutcome = ExecutorPhaseOutcome | ReviewerPhaseOutcome | PlannerPhaseOutcome;
