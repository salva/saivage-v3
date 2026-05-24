export type CardType =
  | 'project'
  | 'goal'
  | 'architecture'
  | 'code'
  | 'test'
  | 'doc'
  | 'data'
  | 'research'
  | 'ops';

export type CardStatus =
  | 'drafting'
  | 'backlog'
  | 'active'
  | 'running'
  | 'blocked'
  | 'changed'
  | 'done'
  | 'failed'
  | 'cancelled';


export type PlannerState = CardStatus;
export type CardAction = 'card.start' | 'card.cancel' | 'card.delete' | 'card.restart';
export type RuntimeIntentStatus = 'running' | 'stopped';
export type RuntimeCommandName = 'start_project' | 'stop_project';
export type RuntimeCommandStatus = 'accepted' | 'rejected' | 'completed';
export type RuntimeRunKind = 'root' | 'child';
export type RuntimeRunPhase = 'pending' | 'planner' | 'executor' | 'reviewer' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'stopped';
export type RuntimeActivationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';
export interface ActionableErrorEnvelope { code: string; message: string; acceptedValues?: string[]; currentState?: Record<string, unknown>; nextAction: string; docsRef?: string; runId?: string | null; sessionId?: string | null; cardId?: string | null; parentCardId?: string | null; childCardId?: string | null; }
export interface RuntimeIntent { status: RuntimeIntentStatus; updated_at: string; source_command_id: string | null; reason?: string | null; }
export interface RuntimeCommandRecord { command_id: string; command: RuntimeCommandName; status: RuntimeCommandStatus; requested_at: string; completed_at?: string | null; source: 'operator' | 'tool' | 'runtime'; error?: ActionableErrorEnvelope | null; }
export interface RuntimeRunRecord { run_id: string; kind: RuntimeRunKind; card_id: string; parent_run_id?: string | null; command_id?: string | null; activation_id?: string | null; phase: RuntimeRunPhase; runtime_status: RuntimeStatus | 'stopped' | 'cancelled'; session_id?: string | null; started_at: string; updated_at: string; finished_at?: string | null; result?: 'done' | 'failed' | 'blocked' | 'cancelled' | 'stopped' | null; }
export interface RuntimeActivationRecord { activation_id: string; idempotency_key: string; parent_card_id: string; parent_run_id: string; parent_session_id: string; parent_tool_call_id: string; child_card_id: string; status: RuntimeActivationStatus; requested_at: string; updated_at: string; precondition: 'accepted' | 'rejected'; runtime_run_id?: string | null; error?: ActionableErrorEnvelope | null; }

export type Urgency = 'low' | 'normal' | 'high' | 'critical';
export type CreatedBy = 'user' | 'analyst' | 'planner';
export type NoteAuthor = 'user' | 'analyst' | 'planner' | 'executor' | 'reviewer' | 'runtime';
export type ControlActionSurface = 'web-chat' | 'telegram' | 'rest' | 'cli' | 'runtime' | 'web-ui';

export interface ArtifactRef { id: string; card_id: string; path: string; type: 'model' | 'data' | 'config' | 'log' | 'report' | 'other'; description: string; retain: boolean; created_at: string; }
export interface AttachmentRef { id: string; card_id: string; path: string; mime: string; title: string; description?: string; created_at: string; }
export interface CardMetadata { max_review_retries?: number; [key: string]: unknown; }
export interface CardRecord {
  id: string; type: CardType; parent: string | null; depth: number; title: string; description: string; status: CardStatus; planner_state?: PlannerState; plannerState?: PlannerState;
  subtype?: string | null; instructions_file?: string | null; tags: string[]; priority: number; urgency: Urgency; created_by: CreatedBy;
  created_at: string; updated_at: string; version_seq: number; assigned_to?: string | null; depends_on: string[]; blocks: string[]; related: string[];
  acceptance: string; result?: Record<string, unknown> | null; metrics?: Record<string, number | string | boolean | null> | null;
  artifacts: ArtifactRef[]; attachments: AttachmentRef[]; estimate?: string | null; started_at?: string | null; completed_at?: string | null;
  duration_ms?: number | null; error?: string | null; status_text?: string | null; status_text_updated_at?: string | null;
  status_text_author_session_id?: string | null; latest_self_report?: Record<string, unknown> | null; metadata?: CardMetadata | null; allowedActions?: CardAction[]; retries: number;
}
export type CardHistoryKind = 'update' | 'status' | 'mutate' | 'depends' | 'delete' | 'archive';
export interface CardHistoryEntry { entry_id: string; kind: CardHistoryKind; card_id: string; version_seq: number; snapshot: CardRecord; changed_at: string; changed_by_actor: NoteAuthor; changed_by_surface: ControlActionSurface; change_reason: string | null; changed_fields: string[]; change_summary: string; }
export type CardHistoryHeader = Omit<CardHistoryEntry, 'snapshot'>;
export interface NotificationRecord { id: string; session_id: string | null; kind: 'card_changed' | 'note_added' | 'process_state' | 'runtime_state' | 'config_changed'; severity: 'info' | 'warn' | 'block'; payload_summary: string; related_card_id?: string; related_note_id?: string; related_process_id?: string; related_version_seq?: number; source_actor: NoteAuthor; source_surface: ControlActionSurface; created_at: string; delivered_at: string | null; acknowledged_at: string | null; }
export interface ControlActionAuditEntry { id: string; actor: NoteAuthor; surface: ControlActionSurface; action: string; target_kind: 'card' | 'note' | 'process' | 'runtime' | 'config' | 'session' | null; target_id: string | null; params_summary: string; confirmed: boolean; outcome: 'ok' | 'error' | 'denied' | 'rejected' | 'preview'; outcome_summary: string; error?: string; created_at: string; }
export interface CardIndexEntry { id: string; type: CardType; parent: string | null; status: CardStatus; title: string; }
export interface CardIndex { cards: Record<string, CardIndexEntry>; }
export type CardChildrenIndex = string[];
export type CardDependencyIndex = Record<string, string[]>;
export type CardBlocksIndex = Record<string, string[]>;
export interface ProjectConfig { id: 'project'; name: string; context: string; goals_summary: string; constraints: string[]; max_goal_depth: number; planner_enabled: boolean; created_at: string; updated_at: string; }
export type DiaryKind = 'planner_invocation' | 'planner_decision' | 'card_mutation' | 'review_assessment' | 'failure_handling';
export interface DiaryEntry { id: string; goal_card_id: string; invocation_id: string; kind: DiaryKind; timestamp: string; input_summary?: string; decision?: string; rationale?: string; created_cards?: string[]; updated_cards?: string[]; reviewed_cards?: string[]; assessment?: ReviewAssessment; raw?: Record<string, unknown>; }
export interface AnalystIssue { summary: string; severity?: 'info' | 'warning' | 'blocker'; evidence_path?: string; }
export interface ReviewerIssue { summary: string; severity: 'info' | 'warning' | 'blocker'; evidence_card_id?: string; recommendation?: string; }
export interface ReviewerResult { result: 'pass' | 'needs_corrections'; summary: string; achieved: string[]; issues: ReviewerIssue[]; evidence_card_ids: string[]; }
export interface ReviewAssessment extends ReviewerResult { assessment_id: string; at: string; reviewer_session_id?: string; goal_card_id?: string; id?: string; created_at?: string; }
export type NoteKind = 'comment' | 'progress' | 'directive' | 'escalation';
export interface NoteRecord { id: string; card_id: string; author: NoteAuthor; timestamp: string; content: string; kind: NoteKind; handled: boolean; handled_at?: string | null; }
export interface NotesQueueEntry { card_id: string; note_id: string; timestamp: string; kind: NoteKind; }
export interface NotesQueue { next_note_sequence: number; entries: NotesQueueEntry[]; }
export interface NotesQueueResolvedEntry extends NotesQueueEntry { note: NoteRecord; }
export type ProcessStatus = 'running' | 'exited' | 'failed' | 'killed';
export interface ProcessRecord { id: string; card_id: string; command: string; command_hash: string; cwd: string; cwd_canonical: string; status: ProcessStatus; pid?: number | null; started_at: string; started_at_monotonic: number; completed_at?: string | null; exit_code?: number | null; signal?: string | null; terminal_reason?: 'exit' | 'signal' | 'spawn_error' | 'lost' | 'kill_unattached' | null; required_for_card_completion: boolean; output_dir: string; stdout_path: string; stderr_path: string; combined_log_path: string; agent_session_id?: string | null; goal_id?: string | null; launch_reason?: string | null; owner_kind?: 'agent' | 'operator' | 'runtime' | null; background_policy?: 'foreground' | null; process_group_id?: number | null; reattach_state?: 'attached' | 'reattached' | 'lost' | null; failure_classification?: 'lost' | 'spawn_error' | null; reattach_error?: string | null; }
export type AgentRole = 'analyst' | 'planner' | 'executor' | 'reviewer' | 'content_supervisor';
export type SessionStatus = 'active' | 'waiting' | 'inactive' | 'done' | 'blocked' | 'failed';
export interface AgentSession { id: string; role: AgentRole; goal_card_id?: string | null; card_id?: string | null; status: SessionStatus; started_at: string; completed_at?: string | null; model?: string; }
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageKind = 'text' | 'activity' | 'tool_call' | 'tool_result' | 'tool_error' | 'model_issue' | 'model_repair' | 'model_recovered';
export interface EntityLink { entity_type: 'card' | 'process' | 'artifact' | 'attachment' | 'quarantine'; entity_id: string; label?: string; }
export interface AgentMessage { id: string; session_id: string; role: MessageRole; kind: MessageKind; content: string; tool?: string; tool_call_id?: string; timestamp: string; links?: EntityLink[]; }
export interface DeferredActivationEnvelopeV1 { kind: 'deferred_activate_card'; version: 1; parent_card_id: string; child_card_id: string; planner_session_id: string; tool_call_id: string; requested_at: string; }
export type ActivationCompletionOutcome = 'done' | 'failed' | 'blocked' | 'cancelled' | 'timed_out';
export interface ActivationCompletionEnvelopeV1 { kind: 'activate_card_completion'; version: 1; child_card_id: string; outcome: ActivationCompletionOutcome; summary: string; result?: Record<string, unknown> | null; review?: ReviewAssessment | null; artifacts?: ArtifactRef[]; attachments?: AttachmentRef[]; evidence_card_ids?: string[]; error?: string | null; completed_by_session_id?: string | null; success: boolean; cardId: string; failure_kind?: string; }
export type RuntimeStatus = 'idle' | 'running' | 'paused' | 'error' | 'frozen';
export type ActiveCardRunRuntimeStatus = RuntimeStatus | 'stopped' | 'cancelled';
export type ActiveCardRunPhase = 'planner' | 'executor' | 'reviewer';
export interface ActiveCardRun { card_id: string; card_type: CardType; runtime_status: ActiveCardRunRuntimeStatus; phase: ActiveCardRunPhase; caller_session_id: string | null; caller_tool_call_id: string | null; planner_session_id?: string | null; executor_session_id?: string | null; reviewer_session_id?: string | null; correction_attempts: number; started_at: string; last_turn_at: string; }
export interface ProjectRunCompletedPayload { project_card_id: string; result: 'done' | 'failed' | 'blocked'; summary: string; failure_kind?: string; blocked_reason?: string; }
export interface HandoffSummary { session_id: string; role: AgentRole; last_action: string; next_action: string; context_summary: string; }
export interface FreezeManifest { freeze_id: string; reason: string; created_at: string; status: 'frozen'; project_id: 'project'; pid: number; started_at: string; current_card_id: string | null; current_agent_session_id: string | null; queue: string[]; running_processes: string[]; handoff_summaries: HandoffSummary[]; schema_version: number; runtime_version: string; }
export interface RuntimeState { status: RuntimeStatus; project_id: 'project'; started_at: string; current_card_id?: string | null; current_agent_session_id?: string | null; active_card_run?: ActiveCardRun | null; paused: boolean; paused_at?: string | null; queue: string[]; running_processes: string[]; updated_at: string; last_tick_at?: string | null; frozen_reason?: string | null; runtime_intent?: RuntimeIntent; runtime_commands?: RuntimeCommandRecord[]; runtime_runs?: RuntimeRunRecord[]; runtime_activations?: RuntimeActivationRecord[]; }
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


import { eventKindValues, runtimeEventKindValues, agentEventKindValues } from '../events/index.js';
import type { EventKind } from '../events/index.js';
export { eventKindValues, runtimeEventKindValues, agentEventKindValues, type EventKind };
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
export interface NotificationAddedEvent extends BaseEvent { kind: 'notification_added'; id: string; severity: string; related_card_id?: string; related_note_id?: string; related_process_id?: string; related_version_seq?: number; created_at: string; }
export interface NotificationAcknowledgedEvent extends BaseEvent { kind: 'notification_acknowledged'; id: string; related_card_id?: string; related_note_id?: string; related_process_id?: string; acknowledged_at: string; }
export interface ControlActionRecordedEvent extends BaseEvent { kind: 'control_action_recorded'; id: string; action: string; target_kind: string | null; target_id: string | null; outcome: string; created_at: string; actor?: string; surface?: string; }
export interface AnalystToolInvokedEvent extends BaseEvent { kind: 'analyst_tool_invoked'; sessionId: string; tool: string; success: boolean; summary: string; classified_as?: string; related_card_id?: string; related_note_id?: string; related_process_id?: string; }
export interface StuckSupervisorStartedEvent extends BaseEvent { kind: 'stuck_supervisor_started'; interval_ms: number; consecutive_threshold: number; }
export interface StuckSupervisorStoppedEvent extends BaseEvent { kind: 'stuck_supervisor_stopped'; checks_performed: number; }
export interface StuckVerdictEvent extends BaseEvent { kind: 'stuck_verdict'; verdict: boolean; confidence: number; reason: string; evidence: string[]; consecutive_count: number; threshold: number; }
export interface AbortTargetSelectedEvent extends BaseEvent { kind: 'abort_target_selected'; target_role: string; target_session_id: string; reason: string; consecutive_count: number; }
export interface ForceCancelSentEvent extends BaseEvent { kind: 'force_cancel_sent'; target_role: string; target_session_id: string; reason: string; }
export interface GoalReportRejectedEvent extends BaseEvent { kind: 'goal_report_rejected'; goal_id?: string; reason?: string; reviewer_summary?: string; missing?: string[]; }
export interface DispatchHeldForNotificationEvent extends BaseEvent { kind: 'dispatch_held_for_notification'; session_id: string; role: 'executor' | 'reviewer'; notification_ids: string[]; }
export interface SessionStartedEvent extends BaseEvent { kind: 'session_started'; session_id: string; role: AgentRole; goal_id: string; card_id: string; }
export interface ModelSelectedEvent extends BaseEvent { kind: 'model_selected'; session_id: string; provider: string; model: string; role: AgentRole; }
export interface InvocationSucceededEvent extends BaseEvent { kind: 'invocation_succeeded'; session_id: string; role: AgentRole; attempt: number; duration_ms: number; }
export interface InvocationFailedEvent extends BaseEvent { kind: 'invocation_failed'; session_id: string; role: AgentRole; attempt: number; error_message: string; }
export interface RetryAttemptedEvent extends BaseEvent { kind: 'retry_attempted'; session_id: string; role: AgentRole; attempt: number; directive?: string; }
export interface CompactionTriggeredEvent extends BaseEvent { kind: 'compaction_triggered'; session_id: string; role: AgentRole; tokens_before: number; tokens_after: number; }
export interface SelfCheckTriggeredEvent extends BaseEvent { kind: 'self_check_triggered'; session_id: string; role: AgentRole; rounds: number; threshold: number; response?: string | null; }
export interface ModelIssueEvent extends BaseEvent { kind: 'model_issue'; session_id: string; role?: AgentRole; message: string; }
export interface SessionCancelledEvent extends BaseEvent { kind: 'session_cancelled'; session_id: string; }
export interface SessionForceCancelledEvent extends BaseEvent { kind: 'session_force_cancelled'; session_id: string; }
export interface McpToolInvocationEvent extends BaseEvent { kind: 'mcp_tool_invocation'; session_id: string; role: AgentRole; server_name: string; tool_name: string; success: boolean; error_message?: string; }
export type LoggedEvent = ProcessReconciledDeadEvent | ProcessReattachRejectedEvent | GoalReportRejectedEvent | StartedEvent | GoalCompletedEvent | GoalFailedEvent | CardFailedEvent | ReviewCompleteEvent | ReviewFailedEvent | DispatchBlockedEvent | DispatchInterruptedEvent | DispatchHeldForNotificationEvent | EscalationEvent | PlanUpdatedEvent | PausedEvent | ResumedEvent | ShutdownEvent | RuntimeDiagnosticEvent | ProjectRunCompletedEvent | FrozenEvent | ResumedFromFreezeEvent | RuntimeCommandEvent | RuntimeRunEvent | RuntimeActivationEvent | RuntimeActionableErrorEvent | RuntimeFatalErrorEvent | SubscriberErrorEvent | CardHistoryAppendedEvent | NotificationAddedEvent | NotificationAcknowledgedEvent | ControlActionRecordedEvent | AnalystToolInvokedEvent | StuckSupervisorStartedEvent | StuckSupervisorStoppedEvent | StuckVerdictEvent | AbortTargetSelectedEvent | ForceCancelSentEvent | SessionStartedEvent | ModelSelectedEvent | InvocationSucceededEvent | InvocationFailedEvent | RetryAttemptedEvent | CompactionTriggeredEvent | SelfCheckTriggeredEvent | ModelIssueEvent | SessionCancelledEvent | SessionForceCancelledEvent | McpToolInvocationEvent;

export type LoggedEventByKind = { [K in EventKind]: Extract<LoggedEvent, { kind: K }> };
export type EventPayloadByKind = { [K in EventKind]: Omit<LoggedEventByKind[K], keyof BaseEvent | 'kind'> };
