import type {
  ArtifactRef,
  AttachmentRef,
  CardHistoryEntry,
  CardHistoryHeader,
  CardRecord as ContractCardRecord,
  CardStatus,
  CardType,
  ControlActionSurface,
  CreatedBy as CardCreator,
  McpInvocationStat,
  McpStatusState,
  McpToolDefinition,
  McpToolsResponse as ContractMcpToolsResponse,
  McpTransport,
  NoteAuthor,
  OperatorApiSuccess,
  RuntimeActivationRecord,
  RuntimeCommandRecord,
  RuntimeIntent,
  RuntimeRunRecord,
  RuntimeState,
  RuntimeStatus,
  ServerAvailability,
  Urgency as CardUrgency,
} from './contracts';


export type {
  ArtifactRef,
  AttachmentRef,
  CardAction,
  CardHistoryEntry,
  CardHistoryHeader,
  CardHistoryKind,
  CardStatus,
  CardType,
  ControlActionSurface,
  NoteAuthor,
  RuntimeActivationRecord,
  RuntimeActivationStatus,
  RuntimeCommandName,
  RuntimeCommandRecord,
  RuntimeCommandStatus,
  RuntimeIntent,
  RuntimeIntentStatus,
  RuntimeRunKind,
  RuntimeRunPhase,
  RuntimeRunRecord,
  RuntimeState,
  RuntimeStatus,
  ServerAvailability,
} from './contracts';

export type SafeFileSensitivity = 'normal' | 'sensitive-blocked' | 'sensitive-redacted';
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

export type NoteKind = 'comment' | 'progress' | 'directive' | 'escalation';

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


export interface CardDiffRow {
  field: string;
  before: unknown;
  after: unknown;
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

export interface RuntimeSummary {
  intent: RuntimeIntent;
  currentRun: RuntimeRunRecord | null;
  activeChildRuns: RuntimeRunRecord[];
  activations: RuntimeActivationRecord[];
  lastCommand: RuntimeCommandRecord | null;
}


export interface RuntimeCommandErrorResponse {
  success: false;
  command?: RuntimeCommandRecord;
  actionable_error: ActionableErrorEnvelope;
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

export type FileContent = OperatorApiSuccess<'files.content'>;

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

export type McpToolInvocationStats = McpInvocationStat;
export type McpToolWithStats = ContractMcpToolsResponse['serverDetails'][number]['tools'][number];
export type McpServerWithTools = ContractMcpToolsResponse['serverDetails'][number];
export type McpToolsResponse = OperatorApiSuccess<'mcp.tools'>;
export type McpTool = McpToolDefinition;
export type McpStatusResponse = OperatorApiSuccess<'mcp.status'>;
export type McpTransportKind = McpTransport;
export type McpStatusKind = McpStatusState;

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

export interface WorkspaceContext {
  view: string | null;
  entityId: string | null;
  refinement: Record<string, string> | null;
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



export type CardRecord = ContractCardRecord & { notes?: NoteRecord[]; children?: CardRecord[] };
export type CardListResponse = OperatorApiSuccess<'cards.list'>;
export type CardDetailResponse = OperatorApiSuccess<'cards.get'> & {
  evidence?: CardEvidence;
  lifecycle: CardLifecycleSummary;
  review: CardReviewSummary;
  planning: CardPlanningSummary | null;
  dispatches: DispatchSummary;
};
export type CardHistoryListResponse = OperatorApiSuccess<'cards.history.list'>;
export type CardHistoryEntryResponse = OperatorApiSuccess<'cards.history.get'>;
export type CardDiffResponse = OperatorApiSuccess<'cards.diff'> & { diff: CardDiffRow[]; };
export type RuntimeStateResponse = OperatorApiSuccess<'runtime.getState'>;
export type CardIndex = RuntimeStateResponse['cardIndex'];
export type RuntimeStatusResponse = OperatorApiSuccess<'runtime.status'>;
export type RuntimeCardRunsResponse = OperatorApiSuccess<'runtime.cardRuns'>;
export interface ConfigResponse { config: Record<string, unknown>; warnings?: string[]; }
export interface ProvidersResponse { providers: Record<string, ProviderEntry>; warnings?: string[]; }
export interface AgentConversationResponse { session: AgentSession; messages: AgentMessage[]; }
export interface AgentSessionsResponse { sessions: AgentSession[]; }
export interface ControlActionsListResponse { control_actions: ControlActionAuditEntry[]; total: number; }
export type ChatSessionsResponse = OperatorApiSuccess<'chats.list'>;
export type ChatMessagesResponse = OperatorApiSuccess<'chats.get'> & { messages: ChatMessage[]; };
export type FilesListResponse = OperatorApiSuccess<'files.list'>;
export type DebugStateResponse = OperatorApiSuccess<'debug.state'> & { runtime: RuntimeState | null; cards: Array<{ id: string; type: CardType; parent: string | null; status: CardStatus; title: string; priority: number; depends_on: string[]; blocks: string[] }>; };
export type DebugErrorsResponse = Omit<OperatorApiSuccess<'debug.errors'>, 'errors'> & { errors: DebugError[]; };
export type DebugTimelineResponse = Omit<OperatorApiSuccess<'debug.timeline'>, 'events'> & { events: DebugTimelineEvent[]; };
export interface ProcessListResponse { processes: ProcessView[]; }
export interface ProcessDetailResponse { process: ProcessView; }



