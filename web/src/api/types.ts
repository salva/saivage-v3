import type {
  AgentActivityStatus as ContractActivityStatus,
  AgentConversationEntry,
  AgentRole,
  AgentSessionSummary,
  CardHistoryEntry,
  CardHistoryHeader,
  CardView as ContractCardView,
  CardStatus,
  CardType,
  ChatSession,
  ChatWorkspaceContext,
  ControlActionSurface,
  DoctorResponse,
  McpInvocationStat,
  McpStatusState,
  McpToolDefinition,
  McpToolsResponse as ContractMcpToolsResponse,
  NoteAuthor,
  OperatorApiSuccess,
  RuntimeState as ContractRuntimeState,
  ServerAvailability,
  SessionStatus,
  SupervisionResponse,
  RestartChatAcknowledgement,
} from './contracts';
export { cardStatusValues, cardTypeValues } from '@saivage/schemas';


export type {
  AgentConversationEntry,
  AgentRole,
  ChatSession,
  ChatWorkspaceContext,
  CardAction,
  CardHistoryEntry,
  CardHistoryHeader,
  CardHistoryKind,
  CardRefView,
  CardStatus,
  CardType,
  DoctorResponse,
  ControlActionSurface,
  EntityLink,
  MessageKind,
  MessageRole,
  McpInvocationStat,
  McpStatusState,
  McpToolDefinition,
  NoteAuthor,
  LiveSyncClientFrame,
  LiveSyncInvalidateFrame,
  LiveSyncSubscribedFrame,
  LiveSyncInvalidateTarget,
  LiveSyncUnscopedResource,
  ServerAvailability,
  SessionStatus,
  SupervisionResponse,
  RestartChatAcknowledgement,
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


export type DoctorCheck = DoctorResponse['checks'][number];
export type DoctorIssue = DoctorResponse['issues'][number];
export type ContentReview = SupervisionResponse['reviews'][number];
export type SupervisionStats = SupervisionResponse['stats'];

export type ProcessView = OperatorApiSuccess<'processes.get'>['process'];
export type ProcessListResponse = OperatorApiSuccess<'processes.list'>;
export type ProcessDetailResponse = OperatorApiSuccess<'processes.get'>;


export type AgentSession = AgentSessionSummary & { role: AgentRole; status: SessionStatus };
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

export interface RuntimeSummary {}






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


export type McpToolWithStats = ContractMcpToolsResponse['serverDetails'][number]['tools'][number];
export type McpServerWithTools = ContractMcpToolsResponse['serverDetails'][number];
export type McpToolsResponse = OperatorApiSuccess<'mcp.tools'>;
export type McpStatusResponse = OperatorApiSuccess<'mcp.status'>;


export type WsConnectionState = 'connected' | 'connecting' | 'offline' | 'unauthorized' | 'no-token';
export type { WsEventType, WsEnvelope } from './contracts';
export type DataAuthority = 'rest' | 'ws' | 'mixed' | 'unknown';
export type RuntimeStatus = 'stopped' | 'starting' | 'running' | 'pausing' | 'paused' | 'closing' | 'error';
export type RuntimeState = Omit<ContractRuntimeState, 'status'> & { status: RuntimeStatus };

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
export type RuntimeStateResponse = Omit<OperatorApiSuccess<'runtime.getState'>, 'runtime'> & { runtime: RuntimeState | null };
export type CardIndex = RuntimeStateResponse['cardIndex'];
export type RuntimeStatusResponse = OperatorApiSuccess<'runtime.status'>;
export type RuntimeStatusRuntime = RuntimeStatusResponse['runtime'];
export type RuntimeStatusActorRuntime = RuntimeStatusResponse['actorRuntime'];
export type RuntimeStatusCardActor = RuntimeStatusActorRuntime['cards'][number];
export type RuntimeStatusAgentActor = RuntimeStatusActorRuntime['agents'][number];
export type RuntimeCardRunsResponse = OperatorApiSuccess<'runtime.cardRuns'>;
export type AgentConversationResponse = Omit<OperatorApiSuccess<'agents.conversation'>, 'session' | 'entries' | 'activity_status'> & { session: AgentSession; entries: AgentConversationEntry[]; activity_status: ActivityStatus; };
export type AgentLlmExchangeResponse = OperatorApiSuccess<'agents.llmExchange'>;
export type AgentSessionsResponse = Omit<OperatorApiSuccess<'agents.list'>, 'sessions'> & { sessions: AgentSession[]; };
export type ControlActionsListResponse = OperatorApiSuccess<'controlActions.list'>;
export type ChatSessionsResponse = OperatorApiSuccess<'chats.list'>;
export type ChatEntriesResponse = OperatorApiSuccess<'chats.get'> & { entries: AgentConversationEntry[]; };
export type ChatResponse = OperatorApiSuccess<'chats.send'>;
export type FilesListResponse = OperatorApiSuccess<'files.list'>;
export type DebugStateResponse = OperatorApiSuccess<'debug.state'> & { runtime: RuntimeState | null; cards: Array<{ id: string; type: CardType; parent: string | null; status: CardStatus; title: string; priority: number; depends_on: string[] }>; };
export type DebugErrorsResponse = Omit<OperatorApiSuccess<'debug.errors'>, 'errors'> & { errors: DebugError[]; };
export type DebugTimelineResponse = Omit<OperatorApiSuccess<'debug.timeline'>, 'events'> & { events: DebugTimelineEvent[]; };
