/**
 * Shared TypeScript types for the Saivage v3 Web Control Room.
 *
 * These types mirror the schemas in 09-data-model.md and the API response
 * shapes from 08-server-api.md. They are used by the API client, Pinia
 * stores, and Vue components.
 */

// ── Core Card Types ───────────────────────────────────────────

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

export type CardUrgency = 'low' | 'normal' | 'high' | 'critical';

export type CardCreator = 'user' | 'analyst' | 'planner';

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
  urgency: CardUrgency;
  created_by: CardCreator;
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
  notes?: NoteRecord[];
}

// ── Artifacts & Attachments ───────────────────────────────────

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

// ── Notes ─────────────────────────────────────────────────────

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

export interface NoteQueueEntry {
  card_id: string;
  note_id: string;
  timestamp: string;
  kind: NoteKind;
  note?: NoteRecord;
}

// ── Plan Diary & Review ───────────────────────────────────────

export type DiaryEntryKind =
  | 'planner_invocation'
  | 'planner_decision'
  | 'card_mutation'
  | 'review_assessment'
  | 'failure_handling';

export interface DiaryEntry {
  id: string;
  plan_card_id: string;
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

// ── Processes ─────────────────────────────────────────────────

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

// ── Agent Session & Messages ──────────────────────────────────

export type AgentRole = 'analyst' | 'planner' | 'executor' | 'reviewer' | 'content_supervisor';
export type AgentStatus = 'active' | 'done' | 'failed';
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
  timestamp: string;
  links?: EntityLink[];
}

// ── Runtime State ─────────────────────────────────────────────

export type RuntimeStatus = 'idle' | 'running' | 'paused' | 'error';

export interface RuntimeState {
  status: RuntimeStatus;
  project_id: string;
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

export interface CardIndex {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
}

// ── Configuration ─────────────────────────────────────────────

export interface ProviderEntry {
  priority: number;
  models: string[];
  baseUrl: string;
  hasAccounts: number;
  status: string;
}

// ── Files ─────────────────────────────────────────────────────

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
}

// ── Debug ─────────────────────────────────────────────────────

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
  type: string;
  card_id?: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

// ── MCP ───────────────────────────────────────────────────────

/** Invocation statistics for a single tool. */
export interface McpToolInvocationStats {
  total: number;
  success: number;
  error: number;
  lastInvokedAt?: string;
}

/** A tool with its invocation statistics for UI display. */
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

/** A server with its tools and stats for UI display. */
export interface McpServerWithTools {
  name: string;
  transport: string;
  status: string;
  toolCount: number;
  tools: McpToolWithStats[];
}

/** Response from GET /api/mcp/tools. */
export interface McpToolsResponse {
  tools: any[];
  servers: string[];
  invocationStats: Record<string, McpToolInvocationStats>;
  serverDetails: McpServerWithTools[];
}

// ── Chat ──────────────────────────────────────────────────────

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

// ── WebSocket ─────────────────────────────────────────────────

export type WsConnectionState = 'connected' | 'connecting' | 'offline' | 'unauthorized';

export type WsEventType = 'message' | 'activity' | 'thinking' | 'status' | 'error';

export interface WsEnvelope {
  type: WsEventType;
  content: Record<string, unknown>;
}

// ── API Response Wrappers ─────────────────────────────────────

export interface CardListResponse {
  cards: CardRecord[];
  total: number;
}

export interface CardDetailResponse {
  card: CardRecord;
  children: CardRecord[];
  ancestorIds: string[];
}

export interface CardCreateResponse {
  card: CardRecord;
}

export interface CardUpdateResponse {
  card: CardRecord;
}

export interface RuntimeStateResponse {
  runtime: RuntimeState | null;
  cardIndex: CardIndex;
}

export interface ConfigResponse {
  config: Record<string, unknown>;
  warnings?: string[];
}

export interface ProvidersResponse {
  providers: Record<string, ProviderEntry>;
  warnings?: string[];
}

export interface AgentConversationResponse {
  session: AgentSession;
  messages: AgentMessage[];
}

export interface NotesListResponse {
  notes: NoteQueueEntry[];
  total: number;
}

export interface NotesClearResponse {
  deleted: number;
  noteIds: string[];
}

export interface ChatSessionsResponse {
  sessions: ChatSession[];
}

export interface ChatMessagesResponse {
  sessionId: string;
  messages: ChatMessage[];
}

export interface FilesListResponse {
  path: string;
  files: FileEntry[];
}

export interface DebugStateResponse {
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

export interface DebugErrorsResponse {
  errors: DebugError[];
  total: number;
}

export interface DebugTimelineResponse {
  events: DebugTimelineEvent[];
  total: number;
}

// ── Card Create/Update Payloads ───────────────────────────────

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
}
