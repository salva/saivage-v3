import { z } from 'zod';
import { type HttpMethod, type OperatorRouteContract } from './operator-api-core.js';
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
  AgentConversationEntrySchema,
  AgentConversationParamsSchema,
  AgentConversationResponseSchema,
  AgentConversationQuerySchema,
  AgentLlmExchangeParamsSchema,
  AgentLlmExchangeResponseSchema,
  AgentListResponseSchema,
  CardAgentSessionsParamsSchema,
  CardAgentSessionsResponseSchema,
  AgentSessionDetailSchema,
  AgentSessionParamsSchema,
  AgentSessionSummarySchema,
} from './operator-api-agents.js';
export type {
  AgentConversationEntry,
  AgentConversationResponse,
  AgentDetailResponse,
  AgentListResponse,
  AgentLlmExchangeResponse,
  AgentSessionDetail,
  AgentSessionSummary,
  CardAgentSessionsResponse,
} from './operator-api-agents.js';
export {
  ChatIdentityResponseSchema,
  ChatSendRequestSchema,
  ChatSendResponseSchema,
  RestartChatAcknowledgementSchema,
  ChatWorkspaceContextSchema,
} from './operator-api-chats.js';
export type {
  ChatIdentityResponse,
  ChatSendRequest,
  ChatSendResponse,
  ChatWorkspaceContext,
  RestartChatAcknowledgement,
} from './operator-api-chats.js';
export {
  DebugErrorsResponseSchema,
  DebugGraphsResponseSchema,
  WorkspaceFileContentQuerySchema,
  WorkspaceFileContentResponseSchema,
  WorkspaceFilesListResponseSchema,
  WorkspaceFilesQuerySchema,
} from './operator-api-files-debug.js';
export type {
  DebugErrorsResponse,
  DebugGraph,
  DebugGraphsResponse,
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
export type {
  ContractAuthClass,
  ContractFailureIdentity,
  HttpMethod,
  OperatorRouteContract,
  UnexpectedInternalServerError,
} from './operator-api-core.js';
export {
  AvailabilityComponentSchema,
  AvailabilityComponentSourceSchema,
  AvailabilityDiagnosticSchema,
  AvailabilityStateSchema,
  ServerAvailabilitySchema,
} from './operator-api-availability.js';
export type {
  AvailabilityComponent,
  AvailabilityState,
  ServerAvailability,
} from './operator-api-availability.js';
export { authOperatorApiContracts, WebSocketTicketResponseSchema } from './operator-api-auth.js';
export type { WebSocketTicketResponse } from './operator-api-auth.js';
export {
  McpInvocationStatSchema,
  McpStatusStateSchema,
  McpToolsResponseSchema,
  McpTransportSchema,
} from './operator-api-mcp.js';
export type {
  McpInvocationStat,
  McpStatusState,
  McpToolsResponse,
  McpTransport,
} from './operator-api-mcp.js';

export {
  CardDetailResponseSchema,
  CardDetailSchema,
  CardRecordDescriptorSchema,
  CardRecordListResponseSchema,
  CardRecordContentSchema,
  CardRecordContentResponseSchema,
  CardRecordNameParamsSchema,
  CardRecordDefinitionNotFoundErrorSchema,
  CardRecordNotFoundErrorSchema,
  CardHierarchyParentSchema,
  CardHierarchyChildSummarySchema,
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
  canonicalPositiveSafeIntegerStringSchema,
  HealthLivenessResponseSchema,
  HealthReadinessResponseSchema,
  RuntimeGetStateResponseSchema,
  RuntimeStatusResponseSchema,
  StopProjectResponseSchema,
  RestartServerRequestSchema,
  RestartServerResponseSchema,
  RestartUnavailableErrorSchema,
  runtimeCardsOperatorApiContracts,
} from './operator-api-runtime-cards.js';
export type {
  CardDetailResponse,
  CardDetail,
  CardRecordDescriptor,
  CardRecordListResponse,
  CardRecordContent,
  CardRecordContentResponse,
  CardHierarchyParent,
  CardHierarchyChildSummary,
  CardChildrenResponse,
  CardDiffResponse,
  CardHistoryEntryResponse,
  CardHistoryListResponse,
  HealthLivenessResponse,
  HealthReadinessResponse,
  RuntimeGetStateResponse,
  RuntimeStatusResponse,
} from './operator-api-runtime-cards.js';

export {
  ProcessListResponseSchema,
  ProcessLogRefsSchema,
  ProcessToolResultSchema,
  ProcessViewSchema,
  processesOperatorApiContracts,
} from './operator-api-processes.js';
export type {
  ProcessListResponse,
  ProcessToolResult,
  ProcessView,
} from './operator-api-processes.js';

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
export type OperatorApiContract<K extends OperatorApiOperationId> =
  (typeof operatorApiContracts)[K];
export type OperatorApiSuccess<K extends OperatorApiOperationId> = z.output<
  OperatorApiContract<K>['success']
>;
export type OperatorApiBody<K extends OperatorApiOperationId> =
  OperatorApiContract<K> extends { body: infer TBody extends z.ZodTypeAny }
    ? z.output<TBody>
    : undefined;
export type OperatorApiParams<K extends OperatorApiOperationId> =
  OperatorApiContract<K> extends { params: infer TParams extends z.ZodTypeAny }
    ? z.output<TParams>
    : undefined;
export type OperatorApiQuery<K extends OperatorApiOperationId> =
  OperatorApiContract<K> extends { query: infer TQuery extends z.ZodTypeAny }
    ? z.output<TQuery>
    : undefined;

type OperatorApiResponseMap<K extends OperatorApiOperationId> =
  OperatorApiContract<K> extends {
    response: infer TResponse extends Record<number, z.ZodTypeAny>;
  }
    ? TResponse
    : never;

export type OperatorApiResponseStatus<K extends OperatorApiOperationId> = Extract<
  keyof OperatorApiResponseMap<K>,
  number
>;
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

export function parseOperatorResponse<K extends OperatorApiOperationId>(
  operationId: K,
  payload: unknown,
): OperatorApiSuccess<K> {
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
