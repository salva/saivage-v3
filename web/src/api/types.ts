import type {
  AgentActivityStatus as ContractActivityStatus,
  AgentConversationEntry,
  AgentRole,
  AgentSessionSummary,
  CardHistoryEntry,
  CardHistoryHeader,
  OperatorCard,
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
  LiveSyncCardInvalidateFrame,
  LiveSyncCardInvalidateTarget,
  LiveSyncCardRecordSlot,
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







export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt: string;
}

export type FileContent = OperatorApiSuccess<'files.content'>;

export type DebugErrorRecord = OperatorApiSuccess<'debug.errors'>['errors'][number];
export type DebugTimelineEvent = OperatorApiSuccess<'debug.timeline'>['events'][number];


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



export type CardRecord = OperatorCard & { notes?: NoteRecord[] };
export type CardChildrenResponse = OperatorApiSuccess<'cards.children'>;
export type CardDetailResponse = OperatorApiSuccess<'cards.get'>;
export type CardHistoryListResponse = OperatorApiSuccess<'cards.history.list'>;
export type CardHistoryEntryResponse = OperatorApiSuccess<'cards.history.get'>;
export type CardDiffResponse = OperatorApiSuccess<'cards.diff'> & { diff: CardDiffRow[]; };
export type RuntimeStateResponse = Omit<OperatorApiSuccess<'runtime.getState'>, 'runtime'> & { runtime: RuntimeState | null };
export type RuntimeStatusResponse = OperatorApiSuccess<'runtime.status'>;
export type RuntimeCardRunsResponse = OperatorApiSuccess<'runtime.cardRuns'>;
export type AgentConversationResponse = Omit<OperatorApiSuccess<'agents.conversation'>, 'session' | 'entries' | 'activity_status'> & { session: AgentSession; entries: AgentConversationEntry[]; activity_status: ActivityStatus; };
export type AgentLlmExchangeResponse = OperatorApiSuccess<'agents.llmExchange'>;
export type AgentSessionsResponse = Omit<OperatorApiSuccess<'agents.list'>, 'sessions'> & { sessions: AgentSession[]; };
export type ControlActionsListResponse = OperatorApiSuccess<'controlActions.list'>;
export type ChatSessionsResponse = OperatorApiSuccess<'chats.list'>;
export type ChatEntriesResponse = OperatorApiSuccess<'chats.get'>;
export type ChatResponse = OperatorApiSuccess<'chats.send'>;
export type FilesListResponse = OperatorApiSuccess<'files.list'>;
export type DebugErrorsResponse = OperatorApiSuccess<'debug.errors'>;
export type DebugTimelineResponse = OperatorApiSuccess<'debug.timeline'>;
