import { z } from 'zod';
import {
  type HttpMethod,
  type OperatorRouteContract,
} from './operator-api-core.js';
import { authOperatorApiContracts } from './operator-api-auth.js';
import { agentOperatorApiContracts } from './operator-api-agents.js';
import { chatOperatorApiContracts } from './operator-api-chats.js';
import { configOperatorApiContracts } from './operator-api-config.js';
import { eventsOperatorApiContracts } from './operator-api-events.js';
import { filesDebugOperatorApiContracts } from './operator-api-files-debug.js';
import { mcpOperatorApiContracts } from './operator-api-mcp.js';
import { processesOperatorApiContracts } from './operator-api-processes.js';
import { runtimeCardsOperatorApiContracts } from './operator-api-runtime-cards.js';


export {
  AgentActivityStatusSchema,
  AgentConversationEntrySchema,
  AgentConversationParamsSchema,
  AgentConversationResponseSchema,
  AgentLlmExchangeParamsSchema,
  AgentLlmExchangeResponseSchema,
  AgentListResponseSchema,
  AgentSessionDetailSchema,
  AgentSessionParamsSchema,
  AgentSessionSummarySchema,
} from './operator-api-agents.js';
export type {
  AgentActivityStatus,
  AgentConversationEntry,
  AgentConversationResponse,
  AgentDetailResponse,
  AgentListResponse,
  AgentLlmExchangeResponse,
  AgentSessionDetail,
  AgentSessionSummary,
} from './operator-api-agents.js';
export {
  ChatEntriesResponseSchema,
  ChatListResponseSchema,
  ChatSendRequestSchema,
  ChatSendResponseSchema,
  ChatSessionParamsSchema,
  ChatWorkspaceContextSchema,
} from './operator-api-chats.js';
export type { ChatEntriesResponse, ChatListResponse, ChatSendRequest, ChatSendResponse, ChatSession, ChatWorkspaceContext } from './operator-api-chats.js';
export {
  DebugErrorsResponseSchema,
  DebugRuntimeStateSchema,
  DebugStateResponseSchema,
  DebugTimelineResponseSchema,
  WorkspaceFileContentQuerySchema,
  WorkspaceFileContentResponseSchema,
  WorkspaceFilesListResponseSchema,
  WorkspaceFilesQuerySchema,
} from './operator-api-files-debug.js';
export type {
  DebugErrorsResponse,
  DebugStateResponse,
  DebugTimelineResponse,
  WorkspaceFileContentResponse,
  WorkspaceFilesListResponse,
} from './operator-api-files-debug.js';
export {
  ConfigGetResponseSchema,
  ConfigUnavailableErrorSchema,
  ControlActionsListFailureSchema,
  ControlActionsListResponseSchema,
  ControlActionsQuerySchema,
  ProviderSummarySchema,
  ProvidersListResponseSchema,
  ProvidersUnavailableErrorSchema,
} from './operator-api-config.js';
export type {
  ConfigGetResponse,
  ConfigUnavailableError,
  ControlActionsListFailure,
  ControlActionsListResponse,
  ControlActionsQuery,
  ProviderSummary,
  ProvidersListResponse,
  ProvidersUnavailableError,
} from './operator-api-config.js';
export {
  EventsListFailureSchema,
  EventsListResponseSchema,
  EventsQuerySchema,
} from './operator-api-events.js';
export type { EventsListFailure, EventsListResponse, EventsQuery } from './operator-api-events.js';
export {
  ApiErrorSchema,
  ForbiddenErrorSchema,
  HttpMethodSchema,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
} from './operator-api-core.js';
export type { ContractAuthClass, HttpMethod, OperatorRouteContract } from './operator-api-core.js';
export {
  AvailabilityComponentSchema,
  AvailabilityComponentSourceSchema,
  AvailabilityDiagnosticSchema,
  AvailabilityStateSchema,
  ServerAvailabilitySchema,
} from './operator-api-availability.js';
export type { AvailabilityComponent, AvailabilityState, ServerAvailability } from './operator-api-availability.js';
export {
  authOperatorApiContracts,
  WebSocketTicketResponseSchema,
} from './operator-api-auth.js';
export type { WebSocketTicketResponse } from './operator-api-auth.js';
export {
  McpInvocationStatSchema,
  McpServerStatusSchema,
  McpStatusResponseSchema,
  McpStatusStateSchema,
  McpToolDefinitionSchema,
  McpToolsResponseSchema,
  McpTransportSchema,
} from './operator-api-mcp.js';
export type {
  McpInvocationStat,
  McpServerStatus,
  McpStatusResponse,
  McpStatusState,
  McpToolDefinition,
  McpToolsResponse,
  McpTransport,
} from './operator-api-mcp.js';

export {
  CardDetailResponseSchema,
  CardDiffQuerySchema,
  CardDiffResponseSchema,
  CardHistoryEntryParamsSchema,
  CardHistoryEntryResponseSchema,
  CardHistoryListResponseSchema,
  CardHistoryParamsSchema,
  CardIdParamsSchema,
  CardIndexSummarySchema,
  CardListResponseSchema,
  CardNotFoundErrorSchema,
  CardPermissionFieldsSchema,
  HealthLivenessResponseSchema,
  HealthReadinessResponseSchema,
  RuntimeActivationRecordSchema,
  RuntimeCardRunsResponseSchema,
  RuntimeCommandRecordSchema,
  RuntimeGetStateResponseSchema,
  RuntimeRunRecordSchema,
  RuntimeStatusResponseSchema,
  RuntimeSummarySchema,
  runtimeCardsOperatorApiContracts,
} from './operator-api-runtime-cards.js';
export type {
  CardDetailResponse,
  CardDiffResponse,
  CardHistoryEntryResponse,
  CardHistoryListResponse,
  CardListResponse,
  HealthLivenessResponse,
  HealthReadinessResponse,
  RuntimeCardRunsResponse,
  RuntimeGetStateResponse,
  RuntimeStatusResponse,
} from './operator-api-runtime-cards.js';

export {
  ProcessControlAvailabilitySchema,
  ProcessDetailResponseSchema,
  ProcessIdParamsSchema,
  ProcessListResponseSchema,
  ProcessLogRefsSchema,
  ProcessNotFoundErrorSchema,
  ProcessViewSchema,
  processesOperatorApiContracts,
} from './operator-api-processes.js';
export type { ProcessDetailResponse, ProcessListResponse, ProcessView } from './operator-api-processes.js';

export const operatorApiContracts = {
  ...authOperatorApiContracts,
  ...runtimeCardsOperatorApiContracts,
  ...mcpOperatorApiContracts,
  ...agentOperatorApiContracts,
  ...chatOperatorApiContracts,
  ...filesDebugOperatorApiContracts,
  ...processesOperatorApiContracts,
  ...eventsOperatorApiContracts,
  ...configOperatorApiContracts,
} as const satisfies Record<string, OperatorRouteContract>;

export type OperatorApiOperationId = keyof typeof operatorApiContracts;
export type OperatorApiContract<K extends OperatorApiOperationId> = (typeof operatorApiContracts)[K];
export type OperatorApiSuccess<K extends OperatorApiOperationId> = z.infer<OperatorApiContract<K>['success']>;
export type OperatorApiBody<K extends OperatorApiOperationId> = OperatorApiContract<K> extends { body: infer TBody extends z.ZodTypeAny } ? z.infer<TBody> : undefined;
export type OperatorApiParams<K extends OperatorApiOperationId> = OperatorApiContract<K> extends { params: infer TParams extends z.ZodTypeAny } ? z.infer<TParams> : undefined;

export function parseOperatorResponse<K extends OperatorApiOperationId>(operationId: K, payload: unknown): OperatorApiSuccess<K> {
  return operatorApiContracts[operationId].success.parse(payload) as OperatorApiSuccess<K>;
}

export function safeParseOperatorResponse<K extends OperatorApiOperationId>(operationId: K, payload: unknown) {
  return operatorApiContracts[operationId].success.safeParse(payload);
}

export function operatorRouteInventory(): Array<{
  operationId: OperatorApiOperationId;
  method: HttpMethod;
  path: string;
  requiresAuth: boolean;
  successSchemaName: string;
}> {
  return Object.values(operatorApiContracts).map((contract) => ({
    operationId: contract.operationId as OperatorApiOperationId,
    method: contract.method,
    path: contract.path,
    requiresAuth: contract.auth !== 'public',
    successSchemaName: contract.successSchemaName,
  }));
}
