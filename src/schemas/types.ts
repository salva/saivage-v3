export const cardTypeValues = ['project', 'goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'] as const;
export type CardType = typeof cardTypeValues[number];

export const cardStatusValues = ['drafting', 'backlog', 'active', 'running', 'blocked', 'changed', 'done', 'failed', 'cancelled', 'needs_verification'] as const;
export type CardStatus = typeof cardStatusValues[number];


export type PlannerState = CardStatus;
export const cardActionValues = ['card.start', 'card.cancel', 'card.delete', 'card.restart'] as const;
export type CardAction = typeof cardActionValues[number];
export type RuntimeIntentStatus = 'running' | 'stopped';
export type RuntimeCommandName = 'start_project' | 'stop_project';
export type RuntimeCommandStatus = 'accepted' | 'rejected' | 'completed';
export type RuntimeRunKind = 'root' | 'child';
export type RuntimeRunPhase = 'pending' | 'planner' | 'executor' | 'reviewer' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'stopped' | 'needs_verification';
export type RuntimeActivationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'needs_verification';
export type RuntimeDispatchOwnership =
  | { kind: 'direct'; source: 'project_root' | 'operator' | 'startup_repair' }
  | { kind: 'activation'; activation_id: string; parent_run_id: string; parent_card_id: string; parent_session_id: string; parent_tool_call_id: string };
export interface ActionableErrorEnvelope { code: string; message: string; acceptedValues?: string[]; currentState?: Record<string, unknown>; nextAction: string; docsRef?: string; runId?: string | null; sessionId?: string | null; cardId?: string | null; parentCardId?: string | null; childCardId?: string | null; }
export interface RuntimeIntent { status: RuntimeIntentStatus; updated_at: string; source_command_id: string | null; reason?: string | null; }
export interface RuntimeCommandRecord { command_id: string; command: RuntimeCommandName; status: RuntimeCommandStatus; requested_at: string; completed_at?: string | null; source: 'operator' | 'tool' | 'runtime' | 'analyst'; error?: ActionableErrorEnvelope | null; }
export type RuntimeLedgerActivationOutcome =
  | { kind: 'completed'; outcome: 'done'; card_id: string; completed_at: string }
  | { kind: 'completed'; outcome: 'failed'; card_id: string; error: string; completed_at: string }
  | { kind: 'completed'; outcome: 'cancelled'; card_id: string; completed_at: string | null }
  | { kind: 'completed'; outcome: 'timed_out'; card_id: string; error: string; completed_at: string }
  | { kind: 'paused'; reason: 'needs_verification'; card_id: string; detail: string }
  | { kind: 'blocked'; card_id: string; error: string };
export type RuntimeLedgerRunOutcome =
  | { kind: 'completed'; result: 'done'; finished_at: string }
  | { kind: 'completed'; result: 'failed'; error: string; finished_at: string }
  | { kind: 'completed'; result: 'cancelled'; finished_at: string | null }
  | { kind: 'completed'; result: 'stopped'; finished_at: string }
  | { kind: 'blocked'; error: string }
  | { kind: 'paused'; reason: 'needs_verification'; detail: string };
export interface RuntimeRunRecord { run_id: string; kind: RuntimeRunKind; card_id: string; ownership: RuntimeDispatchOwnership; parent_run_id?: string | null; command_id?: string | null; activation_id?: string | null; phase: RuntimeRunPhase; runtime_status: RuntimeStatus | 'stopped' | 'cancelled'; session_id?: string | null; started_at: string; updated_at: string; finished_at?: string | null; outcome?: RuntimeLedgerRunOutcome | null; }
export interface RuntimeActivationRecord { activation_id: string; idempotency_key: string; parent_card_id: string; parent_run_id: string; parent_session_id: string; parent_tool_call_id: string; child_card_id: string; status: RuntimeActivationStatus; requested_at: string; updated_at: string; precondition: 'accepted' | 'rejected'; runtime_run_id?: string | null; error?: ActionableErrorEnvelope | null; outcome?: RuntimeLedgerActivationOutcome | null; }

export const urgencyValues = ['low', 'normal', 'high', 'critical'] as const;
export type Urgency = typeof urgencyValues[number];
export type CreatedBy = 'user' | 'analyst' | 'planner';
export type NoteAuthor = 'user' | 'analyst' | 'planner' | 'executor' | 'reviewer' | 'runtime';
export type ControlActionSurface = 'web-chat' | 'telegram' | 'rest' | 'cli' | 'runtime' | 'web-ui';

export interface ArtifactRef { id: string; card_id: string; path: string; type: 'model' | 'data' | 'config' | 'log' | 'report' | 'other'; description: string; retain: boolean; created_at: string; }
export interface AttachmentRef { id: string; card_id: string; path: string; mime: string; title: string; description?: string; created_at: string; }
export interface CardMetadata { max_review_retries?: number; [key: string]: unknown; }
import type { CardLifecycleState } from './lifecycle.js';

export interface CardRecord {
  id: string; type: CardType; parent: string | null; depth: number; position: number; title: string; description: string; status: CardStatus; planner_state?: PlannerState; plannerState?: PlannerState;
  subtype?: string | null; instructions_file?: string | null; tags: string[]; priority: number; urgency: Urgency; created_by: CreatedBy;
  created_at: string; updated_at: string; version_seq: number; assigned_to?: string | null; depends_on: string[]; related: string[];
  acceptance: string; lifecycle: CardLifecycleState; metrics?: Record<string, number | string | boolean | null> | null;
  artifacts: ArtifactRef[]; attachments: AttachmentRef[]; estimate?: string | null; started_at?: string | null;
  duration_ms?: number | null; status_text?: string | null; status_text_updated_at?: string | null;
  status_text_author_session_id?: string | null; latest_self_report?: Record<string, unknown> | null; metadata?: CardMetadata | null; allowedActions?: CardAction[]; retries: number;
}
export interface CardOperatorSummary {
  lifecycleStatus: CardStatus;
  terminal: boolean;
  needsVerification: boolean;
  blocked: boolean;
  hasError: boolean;
  error: string | null;
  completedAt: string | null;
  stale: boolean;
  actionCount: number;
}
export interface CardView extends CardRecord { display_path: string | null; operator_summary: CardOperatorSummary; }
export type CardHistoryKind = 'update' | 'status' | 'mutate' | 'depends' | 'delete' | 'archive';
export interface CardHistoryEntry { entry_id: string; kind: CardHistoryKind; card_id: string; version_seq: number; snapshot: CardRecord; changed_at: string; changed_by_actor: NoteAuthor; changed_by_surface: ControlActionSurface; change_reason: string | null; changed_fields: string[]; change_summary: string; }
export type CardHistoryHeader = Omit<CardHistoryEntry, 'snapshot'>;
export interface ControlActionAuditEntry { id: string; actor: NoteAuthor; surface: ControlActionSurface; action: string; target_kind: 'card' | 'note' | 'process' | 'runtime' | 'config' | 'session' | null; target_id: string | null; params_summary: string; safety_class?: 'read_only' | 'low' | 'high' | 'destructive' | 'deployment'; outcome: 'ok' | 'error' | 'denied'; outcome_summary: string; error?: string; created_at: string; }
export interface CardIndexEntry { id: string; type: CardType; parent: string | null; status: CardStatus; title: string; }
export interface CardIndex { cards: Record<string, CardIndexEntry>; }
export type CardChildrenIndex = string[];
export type CardDependencyIndex = Record<string, string[]>;
export type CardBlocksIndex = Record<string, string[]>;
export interface ProjectConfig { id: 'project'; name: string; context: string; goals_summary: string; constraints: string[]; max_goal_depth: number; planner_enabled: boolean; created_at: string; updated_at: string; }
export type DiaryKind = 'planner_invocation' | 'planner_decision' | 'card_mutation' | 'review_assessment' | 'failure_handling';
export interface DiaryEntry { id: string; goal_card_id: string; invocation_id: string; kind: DiaryKind; timestamp: string; input_summary?: string; decision?: string; rationale?: string; reviewed_cards?: string[]; assessment?: ReviewAssessment; raw?: Record<string, unknown>; }
export const analystIssueSeverityValues = ['info', 'warning', 'blocker'] as const;
export interface AnalystIssue { summary: string; severity?: typeof analystIssueSeverityValues[number]; evidence_path?: string; }
export interface ReviewerIssue { summary: string; severity: typeof analystIssueSeverityValues[number]; evidence_card_id?: string; recommendation?: string; }
export interface ReviewerResult { result: 'pass' | 'needs_corrections'; summary: string; achieved: string[]; issues: ReviewerIssue[]; evidence_card_ids: string[]; }
export interface ReviewAssessment extends ReviewerResult { assessment_id: string; at: string; reviewer_session_id?: string; goal_card_id?: string; id?: string; created_at?: string; }
export type ProcessStatus = 'running' | 'exited' | 'failed' | 'killed';
export interface ProcessRecord { id: string; card_id: string; command: string; command_hash: string; cwd: string; cwd_canonical: string; status: ProcessStatus; pid?: number | null; started_at: string; started_at_monotonic: number; completed_at?: string | null; exit_code?: number | null; signal?: string | null; terminal_reason?: 'exit' | 'signal' | 'spawn_error' | 'lost' | 'kill_unattached' | null; required_for_card_completion: boolean; output_dir: string; stdout_path: string; stderr_path: string; combined_log_path: string; agent_session_id?: string | null; goal_id?: string | null; launch_reason?: string | null; owner_kind?: 'agent' | 'operator' | 'runtime' | null; background_policy?: 'foreground' | null; process_group_id?: number | null; reattach_state?: 'attached' | 'reattached' | 'lost' | null; failure_classification?: 'lost' | 'spawn_error' | null; reattach_error?: string | null; }
export const agentRoleValues = ['analyst', 'planner', 'executor', 'reviewer', 'content_supervisor'] as const;
export const agentInvocationRoleValues = ['planner', 'executor', 'reviewer'] as const;
export const operationalAgentRoleValues = ['planner', 'executor', 'reviewer', 'analyst'] as const;
export type AgentRole = typeof agentRoleValues[number];
export type AgentInvocationRole = typeof agentInvocationRoleValues[number];
export type OperationalAgentRole = typeof operationalAgentRoleValues[number];
export type SessionStatus = 'active' | 'waiting' | 'inactive' | 'done' | 'blocked' | 'failed';
export interface AgentSession { id: string; role: AgentRole; goal_card_id?: string | null; card_id?: string | null; assessment_id?: string | null; status: SessionStatus; started_at: string; completed_at?: string | null; model?: string; }
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageKind = 'text' | 'activity' | 'tool_call' | 'tool_result' | 'tool_error' | 'model_issue' | 'model_repair' | 'context_compaction' | 'model_recovered';
export interface EntityLink { entity_type: 'card' | 'process' | 'artifact' | 'attachment' | 'quarantine'; entity_id: string; label?: string; }
export interface AgentMessage { id: string; session_id: string; role: MessageRole; kind: MessageKind; content: string; round_id: string; message_index: number; block_index: number; tool?: string; tool_call_id?: string; timestamp: string; links?: EntityLink[]; model_spec?: string; requested_model_spec?: string; }
export type ActivationCompletionOutcome = 'done' | 'failed' | 'blocked' | 'cancelled' | 'timed_out' | 'needs_verification';
export interface ActivationCompletionEnvelopeV1 { kind: 'activate_card_completion'; version: 1; child_card_id: string; outcome: ActivationCompletionOutcome; summary: string; result?: Record<string, unknown> | null; review?: ReviewAssessment | null; artifacts?: ArtifactRef[]; attachments?: AttachmentRef[]; evidence_card_ids?: string[]; error?: string | null; completed_by_session_id?: string | null; success: boolean; cardId: string; failure_kind?: string; }
export type RuntimeStatus = 'idle' | 'running' | 'paused' | 'error' | 'frozen';
export type ActiveCardRunRuntimeStatus = RuntimeStatus | 'stopped' | 'cancelled';
export type ActiveCardRunPhase = 'planner' | 'executor' | 'reviewer';
export interface ActiveCardRun { card_id: string; card_type: CardType; ownership: RuntimeDispatchOwnership; runtime_status: ActiveCardRunRuntimeStatus; phase: ActiveCardRunPhase; caller_session_id: string | null; caller_tool_call_id: string | null; planner_session_id?: string | null; executor_session_id?: string | null; reviewer_session_id?: string | null; correction_attempts: number; started_at: string; last_turn_at: string; }
export interface ProjectRunCompletedPayload { project_card_id: string; result: 'done' | 'failed' | 'blocked'; summary: string; failure_kind?: string; blocked_reason?: string; }
export interface HandoffSummary { session_id: string; role: AgentRole; last_action: string; next_action: string; context_summary: string; }
export interface FreezeManifest { freeze_id: string; reason: string; created_at: string; status: 'frozen'; project_id: 'project'; pid: number; started_at: string; active_card_run?: ActiveCardRun | null; queue: string[]; running_processes: string[]; handoff_summaries: HandoffSummary[]; schema_version: number; runtime_version: string; }
export interface RuntimeState { status: RuntimeStatus; project_id: 'project'; pid: number; started_at: string; active_card_run?: ActiveCardRun | null; paused: boolean; paused_at?: string | null; updated_at: string; last_tick_at?: string | null; frozen_reason?: string | null; runtime_intent?: RuntimeIntent; runtime_commands?: RuntimeCommandRecord[]; runtime_runs?: RuntimeRunRecord[]; runtime_activations?: RuntimeActivationRecord[]; }
export type SourceKind = 'command_output' | 'file' | 'download' | 'web' | 'api' | 'tool';
export type ReviewStatus = 'passed' | 'blocked' | 'sanitized';
export type RiskLevel = 'low' | 'medium' | 'high';
export interface ContentReview { id: string; source_kind: SourceKind; source_ref: string; status: ReviewStatus; summary: string; risk: RiskLevel; quarantine_id?: string | null; created_at: string; }
export interface QuarantineItem { id: string; review_id: string; source_ref: string; stored_path: string; reason: string; created_at: string; }
export interface DoctorCheck { name: string; passed: boolean; details?: string; }
export interface DoctorIssue { severity: 'error' | 'warning'; message: string; }
export interface DoctorResponse { status: 'ok' | 'issues_found'; checks: DoctorCheck[]; issues: DoctorIssue[]; }
export interface QuarantineSummaryEntry { quarantine_id: string; review_id: string; source_ref: string; risk: RiskLevel; created_at: string; }
export interface SupervisionStats { total: number; blocked: number; passed: number; sanitized: number; byRisk: Record<string, number>; bySourceKind: Record<string, number>; }
export interface SupervisionResponse { reviews: ContentReview[]; quarantine: QuarantineSummaryEntry[]; stats: SupervisionStats; }
export type TriggerType = 'keyword' | 'tool' | 'path' | 'tag';
export interface SkillTrigger { type: TriggerType; pattern: string; }
export interface SkillIndexEntry { name: string; file: string; target_agents: AgentRole[]; triggers: SkillTrigger[]; updated_at: string; }


import type { EventKind } from './event-catalog.js';
export { eventKindValues, runtimeEventKindValues, agentEventKindValues, type EventKind } from './event-catalog.js';
export type RuntimeEventKind = EventKind;
export type AgentEventKind = EventKind;
export interface BaseEvent { id: string; kind: EventKind; timestamp: string; session_id?: string; goal_id?: string; card_id?: string; }
export interface StartedEvent extends BaseEvent { kind: 'started'; project_root: string; }
export interface GoalCompletedEvent extends BaseEvent { kind: 'goal_completed'; goal_id: string; assessment?: ReviewAssessment; }
export interface GoalFailedEvent extends BaseEvent { kind: 'goal_failed'; goal_id: string; error_message?: string; }
export interface CardFailedEvent extends BaseEvent { kind: 'card_failed'; card_id: string; goal_id: string; }
export interface ReviewCompleteEvent extends BaseEvent { kind: 'review_complete'; goal_id: string; assessment?: ReviewAssessment; }
export interface ReviewFailedEvent extends BaseEvent { kind: 'review_failed'; goal_id: string; assessment?: ReviewAssessment; }
export interface DispatchBlockedEvent extends BaseEvent { kind: 'dispatch_blocked'; reason: string; goal_id: string; }
export interface DispatchInterruptedEvent extends BaseEvent { kind: 'dispatch_interrupted'; goal_id: string; reason: string; }
export interface EscalationEvent extends BaseEvent { kind: 'escalation'; goal_id: string; reason?: string; message?: string; }
export interface PlanUpdatedEvent extends BaseEvent { kind: 'plan_updated'; goal_id: string; changes?: string[]; }
export interface PausedEvent extends BaseEvent { kind: 'paused'; }
export interface ResumedEvent extends BaseEvent { kind: 'resumed'; }
export interface ShutdownEvent extends BaseEvent { kind: 'shutdown'; }
export interface RuntimeDiagnosticEvent extends BaseEvent { kind: 'runtime_diagnostic'; goal_id?: string; card_id?: string; phase?: string; error_message: string; error_name?: string; }
export interface ProcessReconciledDeadEvent extends BaseEvent { kind: 'process_reconciled_dead'; process_id: string; card_id: string; goal_id?: string; session_id?: string; pid?: number | null; probe_status: 'not_running' | 'identity_mismatch' | 'clock_skew'; terminal_reason: 'lost'; failure_classification: 'lost'; detail: string; }
export interface ProcessReattachRejectedEvent extends BaseEvent { kind: 'process_reattach_rejected'; process_id: string; card_id: string; goal_id?: string; session_id?: string; pid?: number | null; terminal_reason: 'lost'; failure_classification: 'lost'; reattach_error: string; detail: string; }
export interface ProjectRunCompletedEvent extends BaseEvent, ProjectRunCompletedPayload { kind: 'project_run_completed'; }
export interface FrozenEvent extends BaseEvent { kind: 'frozen'; freeze_id: string; reason: string; }
export interface ResumedFromFreezeEvent extends BaseEvent { kind: 'resumed_from_freeze'; freeze_id: string; }
export interface RuntimeCommandEvent extends BaseEvent { kind: 'runtime_command'; command: RuntimeCommandRecord; }
export interface RuntimeRunEvent extends BaseEvent { kind: 'runtime_run'; run: RuntimeRunRecord; }
export interface RuntimeActivationEvent extends BaseEvent { kind: 'runtime_activation'; activation: RuntimeActivationRecord; }
export interface RuntimeActionableErrorEvent extends BaseEvent { kind: 'runtime_actionable_error'; actionable_error: ActionableErrorEnvelope; }
export interface RuntimeFatalErrorEvent extends BaseEvent { kind: 'runtime_fatal_error'; phase?: string; error_message: string; error_name?: string; }
export interface SubscriberErrorEvent extends BaseEvent { kind: 'subscriber_error'; subscription_id: string; source_kind: string; error_message: string; error_name?: string; timed_out?: boolean; }
export interface CardHistoryAppendedEvent extends BaseEvent { kind: 'card_history_appended'; entry_id: string; entry_kind: CardHistoryKind; card_id: string; version_seq: number; changed_fields: string[]; changed_at: string; }
export interface NotificationAddedEvent extends Omit<BaseEvent, 'session_id'> { kind: 'notification_added'; session_id: string | null; notification_kind: string; }
export interface ControlActionRecordedEvent extends BaseEvent { kind: 'control_action_recorded'; id: string; action: string; target_kind: string | null; target_id: string | null; outcome: string; created_at: string; actor?: string; surface?: string; }
export interface AnalystToolInvokedEvent extends BaseEvent { kind: 'analyst_tool_invoked'; sessionId: string; tool: string; success: boolean; summary: string; classified_as?: string; related_card_id?: string; related_note_id?: string; related_process_id?: string; }
export interface StuckSupervisorStartedEvent extends BaseEvent { kind: 'stuck_supervisor_started'; interval_ms: number; consecutive_threshold: number; }
export interface StuckSupervisorStoppedEvent extends BaseEvent { kind: 'stuck_supervisor_stopped'; checks_performed: number; }
export interface StuckVerdictEvent extends BaseEvent { kind: 'stuck_verdict'; verdict: boolean; confidence: number; reason: string; evidence: string[]; consecutive_count: number; threshold: number; }
export interface AbortTargetSelectedEvent extends BaseEvent { kind: 'abort_target_selected'; target_role: string; target_session_id: string; reason: string; consecutive_count: number; }
export interface ForceCancelSentEvent extends BaseEvent { kind: 'force_cancel_sent'; target_role: string; target_session_id: string; reason: string; }
export interface GoalReportRejectedEvent extends BaseEvent { kind: 'goal_report_rejected'; goal_id?: string; reason?: string; reviewer_summary?: string; missing?: string[]; }
export interface SessionStartedEvent extends BaseEvent { kind: 'session_started'; session_id: string; role: AgentRole; goal_id: string; card_id: string; }
export type LlmFailureClass = 'auth_permanent' | 'rate_limit' | 'server_transient' | 'timeout' | 'provider_protocol_error' | 'capability_mismatch' | 'token_budget_exceeded' | 'parse_error' | 'cancelled' | 'unknown';
export type LlmRecoveryAction = 'mark_succeeded' | 'cooldown_and_failover' | 'failover_without_cooldown' | 'retry_same_after_delay' | 'abort_without_retry' | 'fail_invocation';
export type LlmAttemptOutcome =
  | { kind: 'succeeded'; terminal_tool: 'emit_planner_result' | 'emit_executor_result' | 'emit_reviewer_result' }
  | { kind: 'failed'; failure_class: LlmFailureClass; recovery_action: LlmRecoveryAction; error_name: string; error_message: string; error_preview?: string; cooldown_ms?: number; retry_delay_ms?: number };
export interface LlmAttemptPayload { session_id: string; role: AgentRole; attempt: number; same_candidate_attempt: number; provider: string; model: string; account: string; started_at: string; duration_ms: number; outcome: LlmAttemptOutcome; capability_skip_reasons?: Array<{ provider: string; model: string; reasons: string[] }>; }
export interface LlmAttemptEvent extends Omit<BaseEvent, 'session_id'>, LlmAttemptPayload { kind: 'llm_attempt'; }
export interface LlmInvocationSummaryEvent extends BaseEvent { kind: 'llm_invocation_summary'; session_id: string; role: AgentRole; goal_id: string; card_id: string; contract_id: string; attempts_count: number; total_duration_ms: number; verdict: 'succeeded' | 'exhausted' | 'cancelled'; repair_attempts: number; contract_verdict?: 'satisfied'; final_provider?: string; final_model?: string; final_account?: string; final_terminal_tool?: 'emit_planner_result' | 'emit_executor_result' | 'emit_reviewer_result'; last_failure_class?: LlmFailureClass; }
export interface LlmVerifierRejectionEvent extends BaseEvent { kind: 'llm_verifier_rejection'; session_id: string; role: AgentRole; contract_id: string; attempt: number; repair_round: number; obligation_codes: string[]; proposed_present: boolean; }
export interface CompactionTriggeredEvent extends BaseEvent { kind: 'compaction_triggered'; session_id: string; role: AgentRole; tokens_before: number; tokens_after: number; }
export interface ModelIssueEvent extends BaseEvent { kind: 'model_issue'; session_id: string; role?: AgentRole; message: string; }
export interface SessionCancelledEvent extends BaseEvent { kind: 'session_cancelled'; session_id: string; }
export interface SessionForceCancelledEvent extends BaseEvent { kind: 'session_force_cancelled'; session_id: string; }
export interface McpToolInvocationEvent extends BaseEvent { kind: 'mcp_tool_invocation'; session_id: string; role: AgentRole; server_name: string; tool_name: string; success: boolean; error_message?: string; }
export type LoggedEvent = ProcessReconciledDeadEvent | ProcessReattachRejectedEvent | GoalReportRejectedEvent | StartedEvent | GoalCompletedEvent | GoalFailedEvent | CardFailedEvent | ReviewCompleteEvent | ReviewFailedEvent | DispatchBlockedEvent | DispatchInterruptedEvent | EscalationEvent | PlanUpdatedEvent | PausedEvent | ResumedEvent | ShutdownEvent | RuntimeDiagnosticEvent | ProjectRunCompletedEvent | FrozenEvent | ResumedFromFreezeEvent | RuntimeCommandEvent | RuntimeRunEvent | RuntimeActivationEvent | RuntimeActionableErrorEvent | RuntimeFatalErrorEvent | SubscriberErrorEvent | CardHistoryAppendedEvent | NotificationAddedEvent | ControlActionRecordedEvent | AnalystToolInvokedEvent | StuckSupervisorStartedEvent | StuckSupervisorStoppedEvent | StuckVerdictEvent | AbortTargetSelectedEvent | ForceCancelSentEvent | SessionStartedEvent | LlmAttemptEvent | LlmInvocationSummaryEvent | LlmVerifierRejectionEvent | CompactionTriggeredEvent | ModelIssueEvent | SessionCancelledEvent | SessionForceCancelledEvent | McpToolInvocationEvent;

export type LoggedEventByKind = { [K in EventKind]: Extract<LoggedEvent, { kind: K }> };
export type EventPayloadByKind = { [K in EventKind]: Omit<LoggedEventByKind[K], keyof BaseEvent | 'kind'> };
