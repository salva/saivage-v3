import type {
  AgentConversationEntry,
  AgentSessionSummary,
  CardHistoryEntry,
  CardHistoryHeader,
  CardDetail,
  CardHierarchyParent,
  CardHierarchyChildSummary,
  CardRecord,
  ChatWorkspaceContext,
  ControlActionSurface,
  DoctorResponse,
  McpInvocationStat,
  McpStatusState,
  McpToolsResponse as ContractMcpToolsResponse,
  OperatorApiSuccess,
  RuntimeState as ContractRuntimeState,
  ServerAvailability,
  RestartChatAcknowledgement,
} from './contracts';
export { cardStatusValues, cardTypeValues } from '@saivage/schemas';

export type {
  AgentConversationEntry,
  ChatWorkspaceContext,
  CardAction,
  CardHistoryEntry,
  CardHistoryHeader,
  CardHistoryKind,
  CardStatus,
  CardType,
  DoctorResponse,
  ControlActionSurface,
  EntityLink,
  MessageKind,
  MessageRole,
  McpInvocationStat,
  McpStatusState,
  LiveSyncClientFrame,
  LiveSyncCardInvalidateFrame,
  LiveSyncCardInvalidateTarget,
  LiveSyncCardRecordName,
  CardRecordDescriptor,
  CardDetail,
  CardRecord,
  LiveSyncInvalidateFrame,
  LiveSyncSubscribedFrame,
  LiveSyncInvalidateTarget,
  LiveSyncUnscopedResource,
  ServerAvailability,
  RestartChatAcknowledgement,
} from './contracts';

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

export type ControlActionAuditEntry =
  OperatorApiSuccess<'controlActions.list'>['control_actions'][number];

export type DoctorCheck = DoctorResponse['checks'][number];
export type DoctorIssue = DoctorResponse['issues'][number];
export type ProcessListResponse = OperatorApiSuccess<'processes.list'>;
export type ProcessView = ProcessListResponse['processes'][number];

export type AgentSession = AgentSessionSummary;

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt: string;
}

export type FileContent = OperatorApiSuccess<'files.content'>;

export type DebugErrorRecord = OperatorApiSuccess<'debug.errors'>['errors'][number];
export type DebugGraph = OperatorApiSuccess<'debug.graphs'>['graphs'][number];
export type DebugGraphsResponse = OperatorApiSuccess<'debug.graphs'>;
export type DebugTimelineEvent = OperatorApiSuccess<'events.list'>['events'][number];

export type McpToolWithStats = ContractMcpToolsResponse['servers'][number]['tools'][number];
export type McpServerWithTools = ContractMcpToolsResponse['servers'][number];
export type McpToolsResponse = OperatorApiSuccess<'mcp.tools'>;

export type WsConnectionState =
  | 'connected'
  | 'connecting'
  | 'offline'
  | 'unauthorized'
  | 'no-token';
export type { WsEventType, WsEnvelope } from './contracts';
export type DataAuthority = 'rest' | 'ws' | 'mixed' | 'unknown';
export type RuntimeStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'closing'
  | 'error';
export type RuntimeState = Omit<ContractRuntimeState, 'status'> & { status: RuntimeStatus };

export interface FreshnessState {
  lastFetchedAt: string | null;
  lastWsEventAt: string | null;
  lastUpdatedBy: DataAuthority;
  isStale: boolean;
}

export type CardHierarchyRecord = CardHierarchyParent | CardHierarchyChildSummary;
export type CardChildrenResponse = OperatorApiSuccess<'cards.children'>;
export type CardDetailResponse = OperatorApiSuccess<'cards.get'>;
export type CardRecordListResponse = OperatorApiSuccess<'cards.records.list'>;
export type CardRecordContentResponse = OperatorApiSuccess<'cards.records.get'>;
export type CardHistoryListResponse = OperatorApiSuccess<'cards.history.list'>;
export type CardHistoryEntryResponse = OperatorApiSuccess<'cards.history.get'>;
export type CardDiffResponse = OperatorApiSuccess<'cards.diff'> & { diff: CardDiffRow[] };
export type RuntimeStateResponse = Omit<OperatorApiSuccess<'runtime.getState'>, 'runtime'> & {
  runtime: RuntimeState | null;
};
export type RuntimeStatusResponse = OperatorApiSuccess<'runtime.status'>;
export type AgentConversationResponse = OperatorApiSuccess<'agents.conversation'>;
export type AgentDetailResponse = OperatorApiSuccess<'agents.detail'>;
export type CardAgentSessionsResponse = OperatorApiSuccess<'agents.cardSessions'>;
export type AgentLlmExchangeResponse = OperatorApiSuccess<'agents.llmExchange'>;
export type AgentSessionsResponse = Omit<OperatorApiSuccess<'agents.list'>, 'sessions'> & {
  sessions: AgentSession[];
};
export type ControlActionsListResponse = OperatorApiSuccess<'controlActions.list'>;
export type ChatEntriesResponse = OperatorApiSuccess<'chats.get'>;
export type AnalystSession = AgentSessionSummary;
export type ChatResponse = OperatorApiSuccess<'chats.send'>;
export type FilesListResponse = OperatorApiSuccess<'files.list'>;
export type DebugErrorsResponse = OperatorApiSuccess<'debug.errors'>;
export type EventsResponse = OperatorApiSuccess<'events.list'>;
