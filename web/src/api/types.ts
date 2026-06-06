import type {
  ArtifactRef,
  AttachmentRef,
  AgentActivityStatus as ContractActivityStatus,
  AgentConversationEntry,
  AgentRole,
  AgentSessionSummary,
  CardHistoryEntry,
  CardHistoryHeader,
  CardView as ContractCardView,
  CardStatus,
  CardType,
  ChatSession as ContractChatSession,
  ChatWorkspaceContext,
  ControlActionSurface,
  CreatedBy as CardCreator,
  DoctorResponse,
  DiaryKind,
  McpInvocationStat,
  McpStatusState,
  McpToolDefinition,
  McpToolsResponse as ContractMcpToolsResponse,
  McpTransport,
  NoteAuthor,
  OperatorApiSuccess,
  ReviewAssessment,
  RuntimeActivationRecord,
  RuntimeCommandRecord,
  RuntimeIntent,
  RuntimeRunRecord,
  RuntimeState,
  RuntimeStatus,
  ServerAvailability,
  SessionStatus,
  SupervisionResponse,
  Urgency as CardUrgency,
} from './contracts';


export type {
  ArtifactRef,
  AttachmentRef,
  AgentRole,
  CardAction,
  CardHistoryEntry,
  CardHistoryHeader,
  CardHistoryKind,
  CardStatus,
  CardType,
  DiaryEntry,
  DiaryKind,
  DoctorResponse,
  ControlActionSurface,
  EntityLink,
  ReviewAssessment,
  MessageKind,
  MessageRole,
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
  LiveSyncClientFrame,
  LiveSyncInvalidateFrame,
  LiveSyncInvalidateTarget,
  LiveSyncUnscopedResource,
  ServerAvailability,
  SupervisionResponse,
} from './contracts';

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

export type ControlActionAuditEntry = OperatorApiSuccess<'controlActions.list'>['control_actions'][number];


export type DiaryEntryKind = DiaryKind;
export type DoctorCheck = DoctorResponse['checks'][number];
export type DoctorIssue = DoctorResponse['issues'][number];
export type ContentReview = SupervisionResponse['reviews'][number];
export type QuarantineSummaryEntry = SupervisionResponse['quarantine'][number];
export type SupervisionStats = SupervisionResponse['stats'];

export type ProcessView = OperatorApiSuccess<'processes.get'>['process'];
export type ProcessListResponse = OperatorApiSuccess<'processes.list'>;
export type ProcessDetailResponse = OperatorApiSuccess<'processes.get'>;


export type AgentStatus = SessionStatus;
export type AgentSession = AgentSessionSummary & { role: AgentRole; status: AgentStatus };
export type ConversationEntry = AgentConversationEntry;
export type PendingCall = ContractActivityStatus['pending_calls'][number];
export type ActivityStatusKind = ContractActivityStatus['status'];
export type ActivityStatus = ContractActivityStatus;


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





export type ProviderEntry = OperatorApiSuccess<'providers.list'>['providers'][string];

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


export type McpToolInvocationStats = McpInvocationStat;
export type McpToolWithStats = ContractMcpToolsResponse['serverDetails'][number]['tools'][number];
export type McpServerWithTools = ContractMcpToolsResponse['serverDetails'][number];
export type McpToolsResponse = OperatorApiSuccess<'mcp.tools'>;
export type McpTool = McpToolDefinition;
export type McpStatusResponse = OperatorApiSuccess<'mcp.status'>;
export type McpTransportKind = McpTransport;
export type McpStatusKind = McpStatusState;

export type ChatSession = ContractChatSession;
export type WorkspaceContext = ChatWorkspaceContext;


export type WsConnectionState = 'connected' | 'connecting' | 'offline' | 'unauthorized' | 'no-token';
export type { WsEventType, WsEnvelope } from './contracts';
export type DataAuthority = 'rest' | 'ws' | 'mixed' | 'unknown';

export interface FreshnessState {
  lastFetchedAt: string | null;
  lastWsEventAt: string | null;
  lastUpdatedBy: DataAuthority;
  isStale: boolean;
}



export type CardRecord = ContractCardView & { notes?: NoteRecord[]; children?: CardRecord[] };
export type CardListResponse = OperatorApiSuccess<'cards.list'>;
export type CardDetailResponse = OperatorApiSuccess<'cards.get'>;
export type CardHistoryListResponse = OperatorApiSuccess<'cards.history.list'>;
export type CardHistoryEntryResponse = OperatorApiSuccess<'cards.history.get'>;
export type CardDiffResponse = OperatorApiSuccess<'cards.diff'> & { diff: CardDiffRow[]; };
export type RuntimeStateResponse = OperatorApiSuccess<'runtime.getState'>;
export type CardIndex = RuntimeStateResponse['cardIndex'];
export type RuntimeStatusResponse = OperatorApiSuccess<'runtime.status'>;
export type RuntimeCardRunsResponse = OperatorApiSuccess<'runtime.cardRuns'>;
export type ConfigResponse = OperatorApiSuccess<'config.get'>;
export type ProvidersResponse = OperatorApiSuccess<'providers.list'>;
export type AgentDetailSession = OperatorApiSuccess<'agents.detail'>['session'];
export type AgentDetailResponse = Omit<OperatorApiSuccess<'agents.detail'>, 'session'> & { session: AgentDetailSession; };
export type AgentConversationResponse = Omit<OperatorApiSuccess<'agents.conversation'>, 'session' | 'entries' | 'activity_status'> & { session: AgentSession; entries: ConversationEntry[]; activity_status: ActivityStatus; };
export type AgentLlmExchangeResponse = OperatorApiSuccess<'agents.llmExchange'>;
export type AgentSessionsResponse = Omit<OperatorApiSuccess<'agents.list'>, 'sessions'> & { sessions: AgentSession[]; };
export type ControlActionsListResponse = OperatorApiSuccess<'controlActions.list'>;
export type ChatSessionsResponse = OperatorApiSuccess<'chats.list'>;
export type ChatEntriesResponse = OperatorApiSuccess<'chats.get'> & { entries: ConversationEntry[]; };
export type ChatResponse = OperatorApiSuccess<'chats.send'>;
export type FilesListResponse = OperatorApiSuccess<'files.list'>;
export type DebugStateResponse = OperatorApiSuccess<'debug.state'> & { runtime: RuntimeState | null; cards: Array<{ id: string; type: CardType; parent: string | null; status: CardStatus; title: string; priority: number; depends_on: string[] }>; };
export type DebugErrorsResponse = Omit<OperatorApiSuccess<'debug.errors'>, 'errors'> & { errors: DebugError[]; };
export type DebugTimelineResponse = Omit<OperatorApiSuccess<'debug.timeline'>, 'events'> & { events: DebugTimelineEvent[]; };
