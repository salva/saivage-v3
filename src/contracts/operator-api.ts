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
  ChatSendRequestSchema,
  ChatSendResponseSchema,
  RestartChatAcknowledgementSchema,
  ChatSessionParamsSchema,
  ChatWorkspaceContextSchema,
} from './operator-api-chats.js';
export type { ChatEntriesResponse, ChatSendRequest, ChatSendResponse, ChatWorkspaceContext, RestartChatAcknowledgement } from './operator-api-chats.js';
export {
  DebugErrorsResponseSchema,
  DebugTimelineResponseSchema,
  WorkspaceFileContentQuerySchema,
  WorkspaceFileContentResponseSchema,
  WorkspaceFilesListResponseSchema,
  WorkspaceFilesQuerySchema,
} from './operator-api-files-debug.js';
export type {
  DebugErrorsResponse,
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
  UnexpectedInternalServerErrorSchema,
  UNEXPECTED_INTERNAL_SERVER_ERROR,
} from './operator-api-core.js';
export type { ContractAuthClass, ContractFailureIdentity, HttpMethod, OperatorRouteContract, UnexpectedInternalServerError } from './operator-api-core.js';
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
  CardChildrenResponseSchema,
  CardDiffQuerySchema,
  CardDiffResponseSchema,
  CardHistoryEntryParamsSchema,
  CardHistoryEntryResponseSchema,
  CardHistoryListResponseSchema,
  CardHistoryParamsSchema,
  CardIdParamsSchema,
  CardDiffNotFoundUnionSchema,
  CardDiffBadRequestSchema,
  CardDiffSourceNotFoundErrorSchema,
  CardHistoryEntryNotFoundErrorSchema,
  CardHistoryEntryNotFoundUnionSchema,
  CardNotFoundErrorSchema,
  InvalidCardDiffPivotsErrorSchema,
  OperatorCardSchema,
  canonicalPositiveSafeIntegerStringSchema,
  HealthLivenessResponseSchema,
  HealthReadinessResponseSchema,
  RuntimeCardRunsResponseSchema,
  RuntimeGetStateResponseSchema,
  RuntimeStatusResponseSchema,
  StopProjectResponseSchema,
  RuntimeControlConflictSchema,
  RestartServerRequestSchema,
  RestartServerResponseSchema,
  RestartUnavailableErrorSchema,
  runtimeCardsOperatorApiContracts,
} from './operator-api-runtime-cards.js';
export type {
  CardDetailResponse,
  CardChildrenResponse,
  CardDiffResponse,
  CardHistoryEntryResponse,
  CardHistoryListResponse,
  OperatorCard,
  HealthLivenessResponse,
  HealthReadinessResponse,
  RuntimeCardRunsResponse,
  RuntimeGetStateResponse,
  RuntimeStatusResponse,
} from './operator-api-runtime-cards.js';

export {
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
export type OperatorApiSuccess<K extends OperatorApiOperationId> = z.output<OperatorApiContract<K>['success']>;
export type OperatorApiBody<K extends OperatorApiOperationId> = OperatorApiContract<K> extends { body: infer TBody extends z.ZodTypeAny } ? z.output<TBody> : undefined;
export type OperatorApiParams<K extends OperatorApiOperationId> = OperatorApiContract<K> extends { params: infer TParams extends z.ZodTypeAny } ? z.output<TParams> : undefined;
export type OperatorApiQuery<K extends OperatorApiOperationId> = OperatorApiContract<K> extends { query: infer TQuery extends z.ZodTypeAny } ? z.output<TQuery> : undefined;

type OperatorApiResponseMap<K extends OperatorApiOperationId> = OperatorApiContract<K> extends {
  response: infer TResponse extends Record<number, z.ZodTypeAny>;
} ? TResponse : never;

export type OperatorApiResponseStatus<K extends OperatorApiOperationId> = Extract<keyof OperatorApiResponseMap<K>, number>;
export type OperatorApiResponse<
  K extends OperatorApiOperationId,
  S extends OperatorApiResponseStatus<K>,
> = z.output<OperatorApiResponseMap<K>[S]>;
export type OperatorApiHandlerResult<K extends OperatorApiOperationId> =
  | { statusCode?: 200; body: OperatorApiSuccess<K> }
  | {
      [S in Exclude<OperatorApiResponseStatus<K>, 200>]: {
        statusCode: S;
        body: OperatorApiResponse<K, S>;
      };
    }[Exclude<OperatorApiResponseStatus<K>, 200>];

export function parseOperatorResponse<K extends OperatorApiOperationId>(operationId: K, payload: unknown): OperatorApiSuccess<K> {
  return operatorApiContracts[operationId].success.parse(payload) as OperatorApiSuccess<K>;
}

export function operatorRouteInventory(): Array<{
  operationId: OperatorApiOperationId;
  method: HttpMethod;
  path: string;
  requiresAuth: boolean;
  successSchemaName: string;
}> {
  return Object.values(operatorApiContracts).map((contract) => ({
    operationId: contract.operationId,
    method: contract.method,
    path: contract.path,
    requiresAuth: contract.auth !== 'public',
    successSchemaName: contract.successSchemaName,
  }));
}
