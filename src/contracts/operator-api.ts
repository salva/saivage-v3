import { z } from 'zod';
import { type OperatorRouteContract } from './operator-api-core.js';
import { authOperatorApiContracts } from './operator-api-auth.js';
import { agentOperatorApiContracts } from './operator-api-agents.js';
import { chatOperatorApiContracts } from './operator-api-chats.js';
import { configOperatorApiContracts } from './operator-api-config.js';
import { eventsOperatorApiContracts } from './operator-api-events.js';
import { filesDebugOperatorApiContracts } from './operator-api-files-debug.js';
import { mcpOperatorApiContracts } from './operator-api-mcp.js';
import { processesOperatorApiContracts } from './operator-api-processes.js';
import { runtimeCardsOperatorApiContracts } from './operator-api-runtime-cards.js';

export { AgentConversationResponseSchema, AgentListResponseSchema, CardAgentSessionsResponseSchema, AgentSessionSummarySchema } from './operator-api-agents.js';
export type { AgentConversationEntry, AgentSessionSummary } from './operator-api-agents.js';
export { ChatSendRequestSchema, AnalystTurnBusyErrorSchema } from './operator-api-chats.js';
export type { ChatWorkspaceContext, RestartChatAcknowledgement } from './operator-api-chats.js';
export { DebugGraphsResponseSchema, DoctorResponseSchema, WorkspaceFilesListResponseSchema } from './operator-api-files-debug.js';
export type { WorkspaceFilesListResponse } from './operator-api-files-debug.js';
export { ProviderSummarySchema } from './operator-api-config.js';
export {
  EventsListResponseSchema,
  EventsQuerySchema } from './operator-api-events.js';
export {
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  UnexpectedInternalServerErrorSchema,
  UNEXPECTED_INTERNAL_SERVER_ERROR,
} from './operator-api-core.js';
export type { OperatorRouteContract } from './operator-api-core.js';
export { AvailabilityComponentSourceSchema, AvailabilityStateSchema, ServerAvailabilitySchema } from './operator-api-availability.js';
export { HistoricalVersionNotFoundErrorSchema } from './historical-version-not-found.js';
export type { ServerAvailability } from './operator-api-availability.js';
export { WebSocketTicketResponseSchema } from './operator-api-auth.js';
export { McpToolsResponseSchema } from './operator-api-mcp.js';
export type { McpToolsResponse } from './operator-api-mcp.js';
export { CardDetailResponseSchema, CardDetailSchema, CardRecordListResponseSchema, CardRecordContentResponseSchema, CardChildrenResponseSchema, CardDiffQuerySchema, CardDiffRowSchema, CardDiffResponseSchema, CardHistoryEntryParamsSchema, CardHistoryEntryResponseSchema, CardHistoryListResponseSchema, CardDiffNotFoundUnionSchema, CardHistoryEntryNotFoundUnionSchema, CardNotFoundErrorSchema, canonicalPositiveSafeIntegerStringSchema, HealthLivenessResponseSchema, ContentPolicyRuntimeResponseSchema } from './operator-api-runtime-cards.js';
export type { CardDetail, CardRecordDescriptor, CardHierarchyParent, CardHierarchyChildSummary, CardDiffRow, CardHistoryListResponse, ContentPolicyRuntimeResponse, RuntimeStatusResponse } from './operator-api-runtime-cards.js';
export { ProcessListResponseSchema, ProcessViewSchema } from './operator-api-processes.js';
export type { ProcessView } from './operator-api-processes.js';
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
type ParsedOperatorApiResponse<
  K extends OperatorApiOperationId,
  S extends number,
> = S extends OperatorApiResponseStatus<K>
  ? OperatorApiResponse<K, S>
  : OperatorApiResponse<K, OperatorApiResponseStatus<K>>;
export type OperatorApiHandlerResult<K extends OperatorApiOperationId> =
  | { statusCode?: 200; body: OperatorApiSuccess<K> }
  | {
      [S in Exclude<OperatorApiResponseStatus<K>, 200>]: {
        statusCode: S;
        body: OperatorApiResponse<K, S>;
      };
    }[Exclude<OperatorApiResponseStatus<K>, 200>];

export function parseOperatorResponse<
  K extends OperatorApiOperationId,
  S extends number,
>(
  operationId: K,
  statusCode: S,
  payload: unknown,
): ParsedOperatorApiResponse<K, S> {
  const responseSchemas = operatorApiContracts[operationId].response as Partial<Record<number, z.ZodTypeAny>>;
  const schema = responseSchemas[statusCode];
  if (schema === undefined) {
    throw new Error(`Operator API operation ${operationId} does not declare response status ${statusCode}.`);
  }
  return schema.parse(payload) as ParsedOperatorApiResponse<K, S>;
}
