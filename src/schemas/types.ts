// ── Card Types ────────────────────────────────────────────────

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
  | 'done'
  | 'failed'
  | 'cancelled';

export type Urgency = 'low' | 'normal' | 'high' | 'critical';

export type CreatedBy = 'user' | 'analyst' | 'planner';

export interface ArtifactRef {
  id: string;
  card_id: string;
  path: string;
  type: 'model' | 'data' | 'config' | 'log' | 'report' | 'other';
  description: string;
  retain: boolean;
  created_at: string;
}

export interface AttachmentRef {
  id: string;
  card_id: string;
  path: string;
  mime: string;
  title: string;
  description?: string;
  created_at: string;
}

export interface CardRecord {
  id: string;
  type: CardType;
  parent: string | null;
  depth: number;
  title: string;
  description: string;
  status: CardStatus;
  subtype?: string | null;
  instructions_file?: string | null;
  tags: string[];
  priority: number;
  urgency: Urgency;
  created_by: CreatedBy;
  created_at: string;
  updated_at: string;
  assigned_to?: string | null;
  depends_on: string[];
  blocks: string[];
  related: string[];
  acceptance: string;
  result?: Record<string, unknown> | null;
  metrics?: Record<string, number | string | boolean | null> | null;
  artifacts: ArtifactRef[];
  attachments: AttachmentRef[];
  estimate?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  duration_ms?: number | null;
  error?: string | null;
  retries: number;
}

export interface CardIndexEntry {
  id: string;
  type: CardType;
  parent: string | null;
  status: CardStatus;
  title: string;
}

export interface CardIndex {
  cards: Record<string, CardIndexEntry>;
}

export type CardChildrenIndex = string[];
export type CardDependencyIndex = Record<string, string[]>;
export type CardBlocksIndex = Record<string, string[]>;

export type PlannerFrameStatus = 'queued' | 'running' | 'suspended' | 'resumable' | 'completed' | 'blocked' | 'failed';
export type PlannerResumeReason = 'dispatch_completed' | 'review_completed' | 'operator_unblocked' | 'none';
export type PlannerDispatchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'timed_out';

export interface PlannerFrameRecord {
  frame_id: string;
  planner_card_id: string;
  planner_role: 'planner';
  planner_scope: 'project' | 'goal';
  status: PlannerFrameStatus;
  resume_reason: PlannerResumeReason;
  waiting_on_dispatch_ids: string[];
  last_resume_cursor: string | null;
  last_dispatch_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlannerDispatchCompletion {
  outcome: 'done' | 'failed' | 'blocked' | 'cancelled' | 'timed_out';
  summary: string;
  child_result: Record<string, unknown> | null;
  review: ReviewAssessment | null;
  artifacts: ArtifactRef[];
  attachments: AttachmentRef[];
  evidence_card_ids: string[];
  error: string | null;
}

export interface PlannerDispatchRecord {
  dispatch_id: string;
  parent_frame_id: string;
  parent_card_id: string;
  target_card_id: string;
  target_kind: 'goal' | 'terminal_card';
  requested_by_role: 'planner';
  requested_by_scope: 'project' | 'goal';
  status: PlannerDispatchStatus;
  completion: PlannerDispatchCompletion | null;
  idempotency_key: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// ── Project Configuration ────────────────────────────────────

export interface ProjectConfig {
  id: 'project';
  name: string;
  context: string;
  goals_summary: string;
  constraints: string[];
  max_goal_depth: number;
  planner_enabled: boolean;
  created_at: string;
  updated_at: string;
}

// ── Goal Diary ───────────────────────────────────────────────

export type DiaryKind =
  | 'planner_invocation'
  | 'planner_decision'
  | 'card_mutation'
  | 'review_assessment'
  | 'failure_handling';

export interface DiaryEntry {
  id: string;
  goal_card_id: string;
  invocation_id: string;
  kind: DiaryKind;
  timestamp: string;
  input_summary?: string;
  decision?: string;
  rationale?: string;
  created_cards?: string[];
  updated_cards?: string[];
  reviewed_cards?: string[];
  assessment?: ReviewAssessment;
  raw?: Record<string, unknown>;
}

// ── Review Assessment ────────────────────────────────────────

export interface ReviewAssessment {
  id: string;
  goal_card_id: string;
  reviewer_session_id: string;
  result: 'pass' | 'fail';
  summary: string;
  achieved: string[];
  missing: string[];
  evidence_card_ids: string[];
  created_at: string;
}

// ── Notes ────────────────────────────────────────────────────

export type NoteAuthor = 'user' | 'analyst' | 'planner' | 'executor' | 'reviewer' | 'runtime';

export type NoteKind = 'comment' | 'progress' | 'directive' | 'escalation';

export interface NoteRecord {
  id: string;
  card_id: string;
  author: NoteAuthor;
  timestamp: string;
  content: string;
  kind: NoteKind;
  handled: boolean;
  handled_at?: string | null;
}

export interface NotesQueueEntry {
  card_id: string;
  note_id: string;
  timestamp: string;
  kind: NoteKind;
}

export interface NotesQueue {
  entries: NotesQueueEntry[];
}

export interface NotesQueueResolvedEntry extends NotesQueueEntry {
  note: NoteRecord;
}

// ── Process ──────────────────────────────────────────────────

export type ProcessStatus = 'running' | 'exited' | 'failed' | 'killed';

export interface ProcessRecord {
  id: string;
  card_id: string;
  command: string;
  cwd: string;
  status: ProcessStatus;
  pid?: number | null;
  started_at: string;
  completed_at?: string | null;
  exit_code?: number | null;
  required_for_card_completion: boolean;
  output_dir: string;
  stdout_path: string;
  stderr_path: string;
  combined_log_path: string;
  agent_session_id?: string | null;
  goal_id?: string | null;
  launch_reason?: string | null;
  owner_kind?: 'agent' | 'operator' | 'runtime' | null;
  background_policy?: 'foreground' | 'background_required' | 'background_optional' | 'detach' | 'kill_on_freeze' | null;
  process_group_id?: number | null;
}

export type AgentRole = 'analyst' | 'planner' | 'executor' | 'reviewer' | 'content_supervisor';
export type SessionStatus = 'active' | 'done' | 'failed';

export interface AgentSession {
  id: string;
  role: AgentRole;
  goal_card_id?: string | null;
  card_id?: string | null;
  status: SessionStatus;
  started_at: string;
  completed_at?: string | null;
  model?: string;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageKind =
  | 'text'
  | 'activity'
  | 'tool_call'
  | 'tool_result'
  | 'tool_error'
  | 'model_issue'
  | 'model_repair'
  | 'model_recovered';

export interface EntityLink {
  entity_type: 'card' | 'process' | 'artifact' | 'attachment' | 'quarantine';
  entity_id: string;
  label?: string;
}

export interface AgentMessage {
  id: string;
  session_id: string;
  role: MessageRole;
  kind: MessageKind;
  content: string;
  tool?: string;
  tool_call_id?: string;
  timestamp: string;
  links?: EntityLink[];
}

export type RuntimeStatus = 'idle' | 'running' | 'paused' | 'error' | 'frozen';

export interface HandoffSummary {
  session_id: string;
  role: AgentRole;
  last_action: string;
  next_action: string;
  context_summary: string;
}

export interface FreezeProcessEntry {
  id: string;
  action: 'kill' | 'reattach' | 'detach';
}

export interface FreezeManifest {
  freeze_id: string;
  reason: string;
  created_at: string;
  status: 'frozen';
  project_id: 'project';
  pid: number;
  started_at: string;
  current_card_id: string | null;
  current_agent_session_id: string | null;
  queue: string[];
  running_processes: FreezeProcessEntry[];
  handoff_summaries: HandoffSummary[];
  schema_version: number;
  runtime_version: string;
}

export interface RuntimeState {
  status: RuntimeStatus;
  project_id: 'project';
  pid: number;
  started_at: string;
  current_card_id?: string | null;
  current_agent_session_id?: string | null;
  paused: boolean;
  paused_at?: string | null;
  queue: string[];
  running_processes: string[];
  updated_at: string;
  frozen_reason?: string | null;
}

export type SourceKind = 'command_output' | 'file' | 'download' | 'web' | 'api' | 'tool';
export type ReviewStatus = 'passed' | 'blocked' | 'sanitized';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface ContentReview {
  id: string;
  source_kind: SourceKind;
  source_ref: string;
  status: ReviewStatus;
  summary: string;
  risk: RiskLevel;
  quarantine_id?: string | null;
  created_at: string;
}

export interface QuarantineItem {
  id: string;
  review_id: string;
  source_ref: string;
  stored_path: string;
  reason: string;
  created_at: string;
}

export interface DoctorCheck {
  name: string;
  passed: boolean;
  details?: string;
}

export interface DoctorIssue {
  severity: 'error' | 'warning';
  message: string;
}

export interface DoctorResponse {
  status: 'ok' | 'issues_found';
  checks: DoctorCheck[];
  issues: DoctorIssue[];
}

export interface QuarantineSummaryEntry {
  quarantine_id: string;
  review_id: string;
  source_ref: string;
  risk: RiskLevel;
  created_at: string;
}

export interface SupervisionStats {
  total: number;
  blocked: number;
  passed: number;
  sanitized: number;
  byRisk: Record<string, number>;
  bySourceKind: Record<string, number>;
}

export interface SupervisionResponse {
  reviews: ContentReview[];
  quarantine: QuarantineSummaryEntry[];
  stats: SupervisionStats;
}

export type TriggerType = 'keyword' | 'tool' | 'path' | 'tag';

export interface SkillTrigger {
  type: TriggerType;
  pattern: string;
}

export interface SkillIndexEntry {
  name: string;
  file: string;
  target_agents: AgentRole[];
  triggers: SkillTrigger[];
  updated_at: string;
}

export type RuntimeEventKind =
  | 'started'
  | 'goal_completed'
  | 'goal_failed'
  | 'card_failed'
  | 'review_complete'
  | 'review_failed'
  | 'dispatch_blocked'
  | 'dispatch_interrupted'
  | 'escalation'
  | 'plan_updated'
  | 'paused'
  | 'resumed'
  | 'shutdown'
  | 'error'
  | 'stuck_supervisor_started'
  | 'stuck_supervisor_stopped'
  | 'stuck_verdict'
  | 'abort_target_selected'
  | 'force_cancel_sent';

export type AgentEventKind =
  | 'session_started'
  | 'model_selected'
  | 'invocation_succeeded'
  | 'invocation_failed'
  | 'retry_attempted'
  | 'compaction_triggered'
  | 'self_check_triggered'
  | 'session_cancelled'
  | 'session_force_cancelled'
  | 'mcp_tool_invocation';

export type EventKind = RuntimeEventKind | AgentEventKind;

export interface BaseEvent {
  id: string;
  kind: EventKind;
  timestamp: string;
  session_id?: string;
  goal_id?: string;
  card_id?: string;
}

export interface StartedEvent extends BaseEvent {
  kind: 'started';
  project_root: string;
}

export interface GoalCompletedEvent extends BaseEvent {
  kind: 'goal_completed';
  goal_id: string;
  assessment?: ReviewAssessment;
}

export interface GoalFailedEvent extends BaseEvent {
  kind: 'goal_failed';
  goal_id: string;
  error_message?: string;
}

export interface CardFailedEvent extends BaseEvent {
  kind: 'card_failed';
  card_id: string;
  goal_id: string;
}

export interface ReviewCompleteEvent extends BaseEvent {
  kind: 'review_complete';
  goal_id: string;
  assessment?: ReviewAssessment;
}

export interface ReviewFailedEvent extends BaseEvent {
  kind: 'review_failed';
  goal_id: string;
  assessment?: ReviewAssessment;
}

export interface DispatchBlockedEvent extends BaseEvent {
  kind: 'dispatch_blocked';
  reason: string;
  goal_id: string;
}

export interface DispatchInterruptedEvent extends BaseEvent {
  kind: 'dispatch_interrupted';
  goal_id: string;
  reason: string;
}

export interface EscalationEvent extends BaseEvent {
  kind: 'escalation';
  goal_id: string;
  reason?: string;
  message?: string;
}

export interface PlanUpdatedEvent extends BaseEvent {
  kind: 'plan_updated';
  goal_id: string;
  changes?: string[];
}

export interface PausedEvent extends BaseEvent {
  kind: 'paused';
}

export interface ResumedEvent extends BaseEvent {
  kind: 'resumed';
}

export interface ShutdownEvent extends BaseEvent {
  kind: 'shutdown';
}

export interface ErrorEvent extends BaseEvent {
  kind: 'error';
  goal_id?: string;
  card_id?: string;
  phase?: string;
  error_message: string;
}

export interface StuckSupervisorStartedEvent extends BaseEvent {
  kind: 'stuck_supervisor_started';
  interval_ms: number;
  consecutive_threshold: number;
}

export interface StuckSupervisorStoppedEvent extends BaseEvent {
  kind: 'stuck_supervisor_stopped';
  checks_performed: number;
}

export interface StuckVerdictEvent extends BaseEvent {
  kind: 'stuck_verdict';
  verdict: boolean;
  confidence: number;
  reason: string;
  evidence: string[];
  consecutive_count: number;
  threshold: number;
}

export interface AbortTargetSelectedEvent extends BaseEvent {
  kind: 'abort_target_selected';
  target_role: string;
  target_session_id: string;
  reason: string;
  consecutive_count: number;
}

export interface ForceCancelSentEvent extends BaseEvent {
  kind: 'force_cancel_sent';
  target_role: string;
  target_session_id: string;
  reason: string;
}

export interface SessionStartedEvent extends BaseEvent {
  kind: 'session_started';
  session_id: string;
  role: AgentRole;
  goal_id: string;
  card_id: string;
}

export interface ModelSelectedEvent extends BaseEvent {
  kind: 'model_selected';
  session_id: string;
  provider: string;
  model: string;
  role: AgentRole;
}

export interface InvocationSucceededEvent extends BaseEvent {
  kind: 'invocation_succeeded';
  session_id: string;
  role: AgentRole;
  attempt: number;
  duration_ms: number;
}

export interface InvocationFailedEvent extends BaseEvent {
  kind: 'invocation_failed';
  session_id: string;
  role: AgentRole;
  attempt: number;
  error_message: string;
}

export interface RetryAttemptedEvent extends BaseEvent {
  kind: 'retry_attempted';
  session_id: string;
  role: AgentRole;
  attempt: number;
  directive?: string;
}

export interface CompactionTriggeredEvent extends BaseEvent {
  kind: 'compaction_triggered';
  session_id: string;
  role: AgentRole;
  tokens_before: number;
  tokens_after: number;
}

export interface SelfCheckTriggeredEvent extends BaseEvent {
  kind: 'self_check_triggered';
  session_id: string;
  role: AgentRole;
  rounds: number;
  threshold: number;
  response?: string | null;
}

export interface SessionCancelledEvent extends BaseEvent {
  kind: 'session_cancelled';
  session_id: string;
}

export interface SessionForceCancelledEvent extends BaseEvent {
  kind: 'session_force_cancelled';
  session_id: string;
}

export interface McpToolInvocationEvent extends BaseEvent {
  kind: 'mcp_tool_invocation';
  server: string;
  tool: string;
  success: boolean;
  duration_ms: number;
  error?: string;
}

export type RuntimeEvent =
  | StartedEvent
  | GoalCompletedEvent
  | GoalFailedEvent
  | CardFailedEvent
  | ReviewCompleteEvent
  | ReviewFailedEvent
  | DispatchBlockedEvent
  | DispatchInterruptedEvent
  | EscalationEvent
  | PlanUpdatedEvent
  | PausedEvent
  | ResumedEvent
  | ShutdownEvent
  | ErrorEvent
  | StuckSupervisorStartedEvent
  | StuckSupervisorStoppedEvent
  | StuckVerdictEvent
  | AbortTargetSelectedEvent
  | ForceCancelSentEvent;

export type AgentEvent =
  | SessionStartedEvent
  | ModelSelectedEvent
  | InvocationSucceededEvent
  | InvocationFailedEvent
  | RetryAttemptedEvent
  | CompactionTriggeredEvent
  | SelfCheckTriggeredEvent
  | SessionCancelledEvent
  | SessionForceCancelledEvent
  | McpToolInvocationEvent;

export type LoggedEvent = RuntimeEvent | AgentEvent;
