import type {
  AgentConversationEntry,
  AgentSessionSummary,
  CardDetail,
  CardHierarchyParent,
  CardHierarchyChildSummary,
  CardDiffRow,
  CardRecord,
  ChatWorkspaceContext,
  ControlActionSurface,
  McpToolsResponse as ContractMcpToolsResponse,
  OperatorApiSuccess,
  ServerAvailability,
  RestartChatAcknowledgement,
} from './contracts';
export type { CardDiffRow };

export type {
  AgentConversationEntry,
  ChatWorkspaceContext,
  CardAction,
  CardHistoryKind,
  CardStatus,
  CardType,
  ControlActionSurface,
  EntityLink,
  MessageKind,
  MessageRole,
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
  RuntimeState,
  RuntimeStatus,
} from './contracts';

export interface DetailErrorState {
  kind: 'unauthorized' | 'not-found' | 'busy' | 'server' | 'network' | 'unknown';
  status: number | null;
  message: string;
}

export type DoctorResponse = OperatorApiSuccess<'debug.doctor'>;
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

export type McpServerWithTools = ContractMcpToolsResponse['servers'][number];
export type McpToolsResponse = OperatorApiSuccess<'mcp.tools'>;

export type WsConnectionState =
  | 'connected'
  | 'connecting'
  | 'offline'
  | 'unauthorized';
export type { WsEnvelope } from './contracts';

export type CardHierarchyRecord = CardHierarchyParent | CardHierarchyChildSummary;
export type CardChildrenResponse = OperatorApiSuccess<'cards.children'>;
export type CardDetailResponse = OperatorApiSuccess<'cards.get'>;
export type CardRecordListResponse = OperatorApiSuccess<'cards.records.list'>;
export type CardRecordContentResponse = OperatorApiSuccess<'cards.records.get'>;
export type RecordHistoryListResponse = OperatorApiSuccess<'cards.records.history.list'>;
export type RecordVersionContentResponse = OperatorApiSuccess<'cards.records.versions.get'>;
export type RecordDiffResponse = OperatorApiSuccess<'cards.records.diff'>;
export type CardHistoryListResponse = OperatorApiSuccess<'cards.history.list'>;
export type CardHistoryEntryResponse = OperatorApiSuccess<'cards.history.get'>;
export type CardHistoryHeader = CardHistoryListResponse['versions'][number];
export type CardHistoryEntry = CardHistoryEntryResponse;
export type CardDiffResponse = OperatorApiSuccess<'cards.diff'>;
export type RuntimeStateResponse = OperatorApiSuccess<'runtime.getState'>;
export type ContentPolicyRuntimeResponse = OperatorApiSuccess<'runtime.contentPolicy'>;
export type RuntimeStatusResponse = OperatorApiSuccess<'runtime.status'>;
export type AgentConversationResponse = OperatorApiSuccess<'agents.conversation'>;
export type AgentConversationVersionListResponse = OperatorApiSuccess<'agents.conversationVersions.list'>;
export type AgentConversationVersionResponse = OperatorApiSuccess<'agents.conversationVersions.get'>;
export type AgentDetailResponse = OperatorApiSuccess<'agents.detail'>;
export type CardAgentSessionsResponse = OperatorApiSuccess<'agents.cardSessions'>;
export type AgentLlmExchangeResponse = OperatorApiSuccess<'agents.llmExchange'>;
export type AgentSessionsResponse = Omit<OperatorApiSuccess<'agents.list'>, 'sessions'> & {
  sessions: AgentSession[];
};
export type ChatEntriesResponse = OperatorApiSuccess<'chats.get'>;
export type AnalystSession = AgentSessionSummary;
export type ChatResponse = OperatorApiSuccess<'chats.send'>;
export type FilesListResponse = OperatorApiSuccess<'files.list'>;
export type DebugErrorsResponse = OperatorApiSuccess<'debug.errors'>;
export type EventsResponse = OperatorApiSuccess<'events.list'>;
