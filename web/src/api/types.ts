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

export type CardAction = 'card.start' | 'card.cancel' | 'card.delete' | 'card.restart';
export type CardUrgency = 'low' | 'normal' | 'high' | 'critical';
export type CardCreator = 'user' | 'analyst' | 'planner';
export type SafeFileSensitivity = 'normal' | 'sensitive-blocked' | 'sensitive-redacted';
export type NoteAuthor = 'user' | 'analyst' | 'planner' | 'executor' | 'reviewer' | 'runtime';
export type NoteKind = 'comment' | 'progress' | 'directive' | 'escalation';
export type ControlActionSurface = 'web-chat' | 'telegram' | 'rest' | 'cli' | 'runtime' | 'web-ui';
export type NotificationSeverity = 'info' | 'warn' | 'block';
export type NotificationKind = 'card_changed' | 'note_added' | 'process_state' | 'runtime_state' | 'config_changed';
export type ControlActionOutcome = 'ok' | 'error' | 'denied' | 'rejected';

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
  urgency: CardUrgency;
  created_by: CardCreator;
  created_at: string;
  updated_at: string;
  version_seq?: number;
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
  notes?: NoteRecord[];
  allowedActions?: CardAction[];
}

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

export interface GeneratedFileRef {
  path: string;
  source: 'artifact' | 'attachment' | 'result.generated_files' | 'result.artifact_paths';
  artifactId?: string;
  attachmentId?: string;
  artifactType?: ArtifactRef['type'];
  description?: string;
  retain?: boolean;
  exists?: boolean;
  size?: number;
  modifiedAt?: string;
  previewable?: boolean;
  downloadable?: boolean;
  blocked?: boolean;
  redactedOnly?: boolean;
  sensitivity?: SafeFileSensitivity;
  availabilityReason?: string;
}

export interface VerificationCommandRef {
  command: string;
  process_id: string | null;
  status: string | null;
  exit_code: number | null;
  timed_out: boolean | null;
}

export type CardEvidenceState = 'none-recorded' | 'partial' | 'present' | 'missing-files' | 'blocked' | 'redacted' | 'incomplete';

export interface CardEvidenceSummary {
  state: CardEvidenceState;
  summary: string;
  hasRecordedEvidence: boolean;
  hasDurableEvidence: boolean;
  missingCount: number;
  blockedCount: number;
  redactedCount: number;
  fileCount: number;
  verificationCount: number;
  toolErrorCount: number;
  parseRecovered: boolean;
}

export interface CardEvidence {
  generatedFiles: GeneratedFileRef[];
  verificationCommands: VerificationCommandRef[];
  artifactPaths: string[];
  toolErrors: string[];
  parseFailure?: Record<string, unknown>;
  summary: CardEvidenceSummary;
}

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

export interface CardLifecycleSummary {
  status: CardStatus;
  terminal: boolean;
  phase: 'drafting' | 'planned' | 'ready' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  explanation: string;
  completionState: 'not-started' | 'in-progress' | 'blocked' | 'failed' | 'cancelled' | 'marked-done';
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  retries: number;
  childCounts: Record<CardStatus, number>;
  hasActiveChildren: boolean;
  hasBlockingChildren: boolean;
  dependencyIds: string[];
  blockedByDependencyIds: string[];
}

export interface CardReviewSummary {
  status: 'not-run' | 'passed' | 'failed' | 'incomplete';
  review: ReviewAssessment | null;
  evidenceStatus: 'none' | 'partial' | 'recorded';
  summary: string;
}

export interface CardPlanningSummary {
  status: string | null;
  summary: string | null;
  blockedReason: string | null;
  createdCardIds: string[];
  updatedCardIds: string[];
  reviewSummary: string | null;
  hasUnfinishedChildWork: boolean;
  plannerDeclaredDone: boolean;
}

export interface DispatchSummaryItem {
  dispatchId: string;
  direction: 'outgoing' | 'incoming';
  parentCardId: string;
  targetCardId: string;
  targetKind: 'goal' | 'terminal_card';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'timed_out';
  outcome: 'done' | 'failed' | 'blocked' | 'cancelled' | 'timed_out' | null;
  summary: string | null;
  error: string | null;
  evidenceCardIds: string[];
  completedAt: string | null;
}

export interface DispatchSummary {
  outgoing: DispatchSummaryItem[];
  incoming: DispatchSummaryItem[];
}

export interface DetailErrorState {
  kind: 'unauthorized' | 'not-found' | 'server' | 'network' | 'unknown';
  status: number | null;
  message: string;
}

export interface DetailFreshnessState {
  isStale: boolean;
  lastLoadedAt: string | null;
  staleReason: 'ws-card-updated' | 'refresh-failed' | null;
}

export interface NoteQueueEntry {
  card_id: string;
  note_id: string;
  timestamp: string;
  kind: NoteKind;
  note?: NoteRecord;
}

export interface CardHistoryHeader {
  card_id: string;
  version_seq: number;
  changed_at: string;
  changed_by_actor: NoteAuthor;
  changed_by_surface: ControlActionSurface;
  change_reason: string | null;
  changed_fields: string[];
  change_summary: string;
}

export interface CardHistoryEntry extends CardHistoryHeader {
  snapshot: CardRecord;
}

export interface CardDiffRow {
  field: string;
  before: unknown;
  after: unknown;
}

export interface NotificationRecord {
  id: string;
  session_id: string | null;
  kind: NotificationKind;
  severity: NotificationSeverity;
  payload_summary: string;
  related_card_id?: string;
  related_note_id?: string;
  related_process_id?: string;
  related_version_seq?: number;
  source_actor: NoteAuthor;
  source_surface: ControlActionSurface;
  created_at: string;
  delivered_at: string | null;
  acknowledged_at: string | null;
}

export interface ControlActionAuditEntry {
  id: string;
  actor: NoteAuthor;
  surface: ControlActionSurface;
  action: string;
  target_kind: 'card' | 'note' | 'process' | 'runtime' | 'config' | 'session' | null;
  target_id: string | null;
  params_summary: string;
  confirmed: boolean;
  outcome: ControlActionOutcome;
  outcome_summary: string;
  error?: string;
  created_at: string;
}

export type DiaryEntryKind =
  | 'planner_invocation'
  | 'planner_decision'
  | 'card_mutation'
  | 'review_assessment'
  | 'failure_handling';

export interface DiaryEntry {
  id: string;
  goal_card_id: string;
  invocation_id: string;
  kind: DiaryEntryKind;
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

export interface ProcessLogRefs {
  stdout: string | null;
  stderr: string | null;
  combined: string | null;
}

export type ProcessControlAvailabilityStatus =
  | 'live-attached'
  | 'stale-not-attached'
  | 'already-ended'
  | 'unknown';

export interface ProcessControlAvailability {
  can_view_logs: boolean;
  can_terminate: boolean;
  terminate_status: ProcessControlAvailabilityStatus;
  terminate_degraded: boolean;
  terminate_reason: string;
}

export interface ProcessView {
  id: string;
  status: ProcessStatus | string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  timed_out: boolean;
  owner: 'agent' | 'operator' | 'runtime' | string | null;
  session_id: string | null;
  card_id: string;
  command: string;
  cwd: string | null;
  logs: ProcessLogRefs;
  control: ProcessControlAvailability;
}

export interface ProcessTerminateResponse {
  process: ProcessView;
  terminated: boolean;
  message: string;
}

export type AgentRole = 'analyst' | 'planner' | 'executor' | 'reviewer' | 'content_supervisor';
export type AgentStatus = 'active' | 'waiting' | 'inactive' | 'done' | 'blocked' | 'failed';
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

export interface AgentSession {
  id: string;
  role: AgentRole;
  goal_card_id?: string | null;
  card_id?: string | null;
  status: AgentStatus;
  started_at: string;
  completed_at?: string | null;
  model?: string;
}

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
export type RuntimeIntentStatus = 'running' | 'stopped';
export type RuntimeCommandName = 'start_project' | 'stop_project';
export type RuntimeCommandStatus = 'accepted' | 'rejected' | 'completed';
export type RuntimeRunKind = 'root' | 'child';
export type RuntimeRunPhase = 'pending' | 'planner' | 'executor' | 'reviewer' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'stopped';
export type RuntimeRunStatus = 'idle' | 'running' | 'paused' | 'error' | 'frozen' | 'stopped' | 'cancelled';
export type RuntimeRunResult = 'done' | 'failed' | 'blocked' | 'cancelled' | 'stopped';
export type RuntimeActivationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';

export interface ActionableErrorEnvelope {
  code: string;
  message: string;
  acceptedValues?: string[];
  currentState?: Record<string, unknown>;
  nextAction: string;
  docsRef?: string;
  runId?: string | null;
  sessionId?: string | null;
  cardId?: string | null;
  parentCardId?: string | null;
  childCardId?: string | null;
}

export interface RuntimeIntent {
  status: RuntimeIntentStatus;
  updated_at: string;
  source_command_id: string | null;
  reason?: string | null;
}

export interface RuntimeCommandRecord {
  command_id: string;
  command: RuntimeCommandName;
  status: RuntimeCommandStatus;
  requested_at: string;
  completed_at?: string | null;
  source: 'operator' | 'tool' | 'runtime';
  error?: ActionableErrorEnvelope | null;
}

export interface RuntimeRunRecord {
  run_id: string;
  kind: RuntimeRunKind;
  card_id: string;
  parent_run_id?: string | null;
  command_id?: string | null;
  activation_id?: string | null;
  phase: RuntimeRunPhase;
  runtime_status: RuntimeRunStatus;
  session_id?: string | null;
  started_at: string;
  updated_at: string;
  finished_at?: string | null;
  result?: RuntimeRunResult | null;
}

export interface RuntimeActivationRecord {
  activation_id: string;
  idempotency_key: string;
  parent_card_id: string;
  parent_run_id: string;
  parent_session_id: string;
  parent_tool_call_id: string;
  child_card_id: string;
  status: RuntimeActivationStatus;
  requested_at: string;
  updated_at: string;
  precondition: 'accepted' | 'rejected';
  runtime_run_id?: string | null;
  error?: ActionableErrorEnvelope | null;
}

export interface RuntimeSummary {
  intent: RuntimeIntent;
  currentRun: RuntimeRunRecord | null;
  activeChildRuns: RuntimeRunRecord[];
  activations: RuntimeActivationRecord[];
  lastCommand: RuntimeCommandRecord | null;
}

export interface RuntimeCommandResponse {
  success: true;
  command: RuntimeCommandRecord;
  intent: RuntimeIntent;
  run?: RuntimeRunRecord;
}

export interface RuntimeCommandErrorResponse {
  success: false;
  command?: RuntimeCommandRecord;
  actionable_error: ActionableErrorEnvelope;
}

export interface RuntimeState {
  status: RuntimeStatus;
  project_id: string;
  pid: number;
  started_at: string;
  current_card_id?: string | null;
  current_agent_session_id?: string | null;
  paused: boolean;
  paused_at?: string | null;
  /** Temporary debug compatibility only; execution control must use runtime_runs/runtime_activations. */
  queue: string[];
  running_processes: string[];
  updated_at: string;
  frozen_reason?: string | null;
  runtime_intent?: RuntimeIntent;
  runtime_commands?: RuntimeCommandRecord[];
  runtime_runs?: RuntimeRunRecord[];
  runtime_activations?: RuntimeActivationRecord[];
}

export interface CardIndex {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
}

export interface CardStoreCompatibilitySnapshotWarning {
  code: 'compatibility-snapshot-degraded';
  operation: 'startup-repair' | 'mutation-rebuild' | 'delete-cleanup' | 'archive-cleanup' | 'manual-repair';
  relativePath?: string;
  message: string;
  errorName?: string;
  occurredAt: string;
  canonicalCommitted: boolean;
}

export interface CardStoreHealth {
  canonical: 'ok' | 'invalid';
  compatibilitySnapshots: 'ok' | 'degraded';
  lastCompatibilitySnapshotWarning: CardStoreCompatibilitySnapshotWarning | null;
  warnings: CardStoreCompatibilitySnapshotWarning[];
}


export type AvailabilityState = 'available' | 'degraded' | 'unavailable' | 'unknown';
export type AvailabilityComponentSource = 'startup' | 'active-runtime' | 'runtime-state' | 'mcp-manager' | 'health-check' | 'unknown';

export interface AvailabilityDiagnostic {
  code: string;
  summary: string;
}

export interface AvailabilityComponent {
  state: AvailabilityState;
  source: AvailabilityComponentSource;
  checkedAt: string;
  diagnostic?: AvailabilityDiagnostic;
}

export interface ServerAvailability {
  generatedAt: string;
  components: {
    api: AvailabilityComponent;
    runtime: AvailabilityComponent;
    mcp: AvailabilityComponent;
  };
}

export interface ProviderEntry {
  priority: number;
  models: string[];
  baseUrl: string;
  hasAccounts: number;
  status: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt: string;
}

export interface FileContent {
  path: string;
  size: number;
  contentType: string;
  content: string;
  redacted?: boolean;
  sensitivity?: SafeFileSensitivity;
}

export interface DebugState {
  runtime: RuntimeState | null;
  cards: Array<{
    id: string;
    type: CardType;
    parent: string | null;
    status: CardStatus;
    title: string;
    priority: number;
    depends_on: string[];
    blocks: string[];
  }>;
  totalCards: number;
}

export interface DebugError {
  source: string;
  type: string;
  severity: string;
  message: string;
  details?: string;
  timestamp: string;
}

export interface DebugTimelineEvent {
  id?: string;
  kind: string;
  card_id?: string;
  goal_id?: string;
  session_id?: string;
  timestamp: string;
  [key: string]: unknown;
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

export interface McpToolInvocationStats {
  total: number;
  success: number;
  error: number;
  lastInvokedAt?: string;
}

export interface McpToolWithStats {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, object>;
    required?: string[];
  };
  stats: McpToolInvocationStats;
}

export interface McpServerWithTools {
  name: string;
  transport: string;
  status: string;
  toolCount: number;
  tools: McpToolWithStats[];
}

export interface McpToolsResponse {
  tools: any[];
  servers: string[];
  invocationStats: Record<string, McpToolInvocationStats>;
  serverDetails: McpServerWithTools[];
}

export interface ChatSession {
  id: string;
  role: string;
  status: string;
  started_at: string;
}

export interface ChatMessage {
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

export interface ChatResponse {
  sessionId: string;
  message: Record<string, unknown>;
  toolInvocations?: Array<{
    tool: string;
    params: Record<string, unknown>;
    result?: Record<string, unknown>;
  }>;
}

export type WsConnectionState = 'connected' | 'connecting' | 'offline' | 'unauthorized' | 'no-token';
export type { WsEventType, WsEnvelope } from './contracts';
export type DataAuthority = 'rest' | 'ws' | 'mixed' | 'unknown';

export interface FreshnessState {
  lastFetchedAt: string | null;
  lastWsEventAt: string | null;
  lastUpdatedBy: DataAuthority;
  isStale: boolean;
}

export interface FreezeResponse {
  status: string;
  freeze_id: string;
  reason: string;
  created_at: string;
}

export interface ResumeFromFreezeResponse {
  status: string;
  freeze_id: string;
  restored_queue: string[];
  restored_processes: string[];
  restored_card_id: string | null;
}

export interface CardListResponse { cards: CardRecord[]; total: number; }
export interface CardDetailResponse {
  card: CardRecord;
  children: CardRecord[];
  ancestorIds: string[];
  evidence?: CardEvidence;
  lifecycle: CardLifecycleSummary;
  review: CardReviewSummary;
  planning: CardPlanningSummary | null;
  dispatches: DispatchSummary;
}
export interface CardCreateResponse { card: CardRecord; }
export interface CardUpdateResponse { card: CardRecord; }
export interface CardHistoryListResponse { history: CardHistoryHeader[]; total: number; }
export interface CardHistoryEntryResponse { entry: CardHistoryEntry; }
export interface CardDiffResponse { diff: CardDiffRow[]; from: number; to: number; card_id: string; }
export interface RuntimeStateResponse { runtime: RuntimeState | null; cardIndex: CardIndex; cardStoreHealth?: CardStoreHealth; serverAvailability?: ServerAvailability; }
export interface ConfigResponse { config: Record<string, unknown>; warnings?: string[]; }
export interface ProvidersResponse { providers: Record<string, ProviderEntry>; warnings?: string[]; }
export interface AgentConversationResponse { session: AgentSession; messages: AgentMessage[]; }
export interface AgentSessionsResponse { sessions: AgentSession[]; }
export interface NotesListResponse { notes: NoteQueueEntry[]; total: number; }
export interface NotesClearResponse { deleted: number; noteIds: string[]; }
export interface NotificationsListResponse { notifications: NotificationRecord[]; total: number; }
export interface NotificationAcknowledgeResponse { notification: NotificationRecord; }
export interface ControlActionsListResponse { control_actions: ControlActionAuditEntry[]; total: number; }
export interface ChatSessionsResponse { sessions: ChatSession[]; }
export interface ChatMessagesResponse { sessionId: string; messages: ChatMessage[]; }
export interface FilesListResponse { path: string; files: FileEntry[]; }
export interface DebugStateResponse {
  runtime: RuntimeState | null;
  cards: Array<{ id: string; type: CardType; parent: string | null; status: CardStatus; title: string; priority: number; depends_on: string[]; blocks: string[] }>;
  totalCards: number;
}
export interface DebugErrorsResponse { errors: DebugError[]; total: number; }
export interface DebugTimelineResponse { events: DebugTimelineEvent[]; total: number; }
export interface ProcessListResponse { processes: ProcessView[]; }
export interface ProcessDetailResponse { process: ProcessView; }

export interface CreateCardPayload {
  type: CardType;
  parent?: string | null;
  title: string;
  description?: string;
  status?: CardStatus;
  tags?: string[];
  priority?: number;
  urgency?: CardUrgency;
  created_by?: CardCreator;
  depends_on?: string[];
  related?: string[];
  acceptance?: string;
  result?: Record<string, unknown>;
  metrics?: Record<string, string | number | boolean | null>;
  estimate?: string;
  error?: string;
  retries?: number;
  subtype?: string;
  assigned_to?: string;
  instructions_file?: string;
}

export interface UpdateCardPayload {
  title?: string;
  description?: string;
  status?: CardStatus;
  tags?: string[];
  priority?: number;
  urgency?: CardUrgency;
  acceptance?: string;
  result?: Record<string, unknown> | null;
  metrics?: Record<string, string | number | boolean | null> | null;
  depends_on?: string[];
  related?: string[];
  estimate?: string | null;
  error?: string | null;
  retries?: number;
  parent?: string | null;
  assigned_to?: string | null;
  type?: CardType;
  subtype?: string | null;
  instructions_file?: string | null;
}

