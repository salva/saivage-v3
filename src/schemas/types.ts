// ── Card Types ────────────────────────────────────────────────

export type CardType =
  | 'project'
  | 'goal'
  | 'plan'
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

// ── Plan Diary ───────────────────────────────────────────────

export type DiaryKind =
  | 'planner_invocation'
  | 'planner_decision'
  | 'card_mutation'
  | 'review_assessment'
  | 'failure_handling';

export interface DiaryEntry {
  id: string;
  plan_card_id: string;
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
  plan_card_id: string;
  reviewer_session_id: string;
  result: 'pass' | 'fail';
  summary: string;
  achieved: string[];
  missing: string[];
  evidence_card_ids: string[];
  created_at: string;
}

// ── Notes ────────────────────────────────────────────────────

export type NoteAuthor =
  | 'user'
  | 'analyst'
  | 'planner'
  | 'executor'
  | 'reviewer'
  | 'runtime';

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
}

// ── Agent Session & Messages ─────────────────────────────────

export type AgentRole =
  | 'analyst'
  | 'planner'
  | 'executor'
  | 'reviewer'
  | 'content_supervisor';

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
  timestamp: string;
  links?: EntityLink[];
}

// ── Runtime State ────────────────────────────────────────────

export type RuntimeStatus = 'idle' | 'running' | 'paused' | 'error';

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
}

// ── Content Supervision ──────────────────────────────────────

export type SourceKind =
  | 'command_output'
  | 'file'
  | 'download'
  | 'web'
  | 'api'
  | 'tool';

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
