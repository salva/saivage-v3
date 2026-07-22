import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import type { z } from 'zod';
import type { AuthPolicy } from './auth-policy.js';
import type { EventLog } from '../observability/index.js';
import { rethrowAppLogPublicationError } from '../persistence/app-log.js';
import {
  UNEXPECTED_INTERNAL_SERVER_ERROR,
  type OperatorRouteContract,
} from '../contracts/index.js';
import { ConversationSessionIdSchema, cardIdSchema } from '../schemas/index.js';

function assertNever(value: never): never {
  throw new Error(`Unsupported contract authentication class: ${String(value)}`);
}

type ContractSchemaOutput<
  TContract extends OperatorRouteContract,
  TKey extends 'params' | 'query' | 'body',
> = TContract extends Record<TKey, infer TSchema extends z.ZodTypeAny> ? z.output<TSchema> : undefined;

type ParsedContractRequest<TContract extends OperatorRouteContract> = {
  params: ContractSchemaOutput<TContract, 'params'>;
  query: ContractSchemaOutput<TContract, 'query'>;
  body: ContractSchemaOutput<TContract, 'body'>;
};

export interface ContractPermissionContext<TContract extends OperatorRouteContract = OperatorRouteContract> {
  contract: TContract;
  params: ContractSchemaOutput<TContract, 'params'>;
  query: ContractSchemaOutput<TContract, 'query'>;
  body: ContractSchemaOutput<TContract, 'body'>;
  request: FastifyRequest;
}

export type ContractPermissionPredicate<TContract extends OperatorRouteContract = OperatorRouteContract> = (
  context: ContractPermissionContext<TContract>,
) => boolean | { allowed: true } | { allowed: false; reason?: string } | Promise<boolean | { allowed: true } | { allowed: false; reason?: string }>;

export interface ContractPreSendReply {
  readonly raw: { once(event: string, listener: (...args: unknown[]) => void): unknown };
  header(name: string, value: string | number | string[] | undefined): void;
}

export interface ContractRequestContext<TContract extends OperatorRouteContract = OperatorRouteContract> extends ContractPermissionContext<TContract> {
  reply: ContractPreSendReply;
}

export type ContractHandler<TContract extends OperatorRouteContract = OperatorRouteContract> = (
  context: ContractRequestContext<TContract>,
) => Promise<ContractHandlerResult> | ContractHandlerResult;

export interface ContractHandlerResult {
  statusCode?: number;
  body?: unknown;
}

export interface ContractRuntimeOptions {
  eventLogger: EventLog;
  authPolicy: AuthPolicy;
}

type FailureCode =
  | 'auth_evaluation_failed'
  | 'request_validation_failed'
  | 'failure_identity_projection_failed'
  | 'permission_evaluation_failed'
  | 'handler_failed'
  | 'response_validation_failed';

type SafeFailureIdentity = { sessionId: string } | { cardId: string } | Record<never, never>;
type ResponseDescriptor = { statusCode: number; body: unknown };
const RESPONSE_CONTRACT_VIOLATION = Symbol('response-contract-violation');

function zodIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

function validationErrorBody(operationId: string, target: string, error: z.ZodError): Record<string, unknown> {
  return {
    error: 'ValidationError',
    message: `${operationId} ${target} did not match the operator API contract`,
    issues: zodIssues(error),
  };
}

function unauthorizedBody(): Record<string, unknown> {
  return { error: 'Unauthorized', statusCode: 401 };
}

function forbiddenBody(reason?: string): Record<string, unknown> {
  return { error: 'Forbidden', statusCode: 403, ...(reason ? { message: reason } : {}) };
}

function schemaForStatus(contract: OperatorRouteContract, statusCode: number): z.ZodTypeAny | undefined {
  return contract.response?.[statusCode] ?? (statusCode >= 200 && statusCode < 300 ? contract.success : contract.error);
}

function isPermissionAllowed(result: Awaited<ReturnType<ContractPermissionPredicate>>): { allowed: boolean; reason?: string } {
  if (typeof result === 'boolean') return { allowed: result };
  return result.allowed ? { allowed: true } : { allowed: false, reason: result.reason };
}

export class ContractRuntime {
  private readonly eventLogger: EventLog;
  private readonly authPolicy: AuthPolicy;

  constructor(options: ContractRuntimeOptions) {
    this.eventLogger = options.eventLogger;
    this.authPolicy = options.authPolicy;
  }

  mount<TContracts extends Record<string, OperatorRouteContract>>(
    fastify: FastifyInstance,
    contracts: TContracts,
    handlers: { [K in keyof TContracts]?: ContractHandler<TContracts[K]> },
  ): void {
    for (const operationId in contracts) {
      const contract = contracts[operationId];
      const handler = handlers[operationId];
      if (!handler) continue;
      this.mountOne(fastify, contract, handler);
    }
  }

  private mountOne<TContract extends OperatorRouteContract>(fastify: FastifyInstance, contract: TContract, handler: ContractHandler<TContract>): void {
    const route: RouteOptions = {
      method: contract.method,
      url: contract.path,
      handler: async (request, reply) => {
        let failureCode: FailureCode = 'auth_evaluation_failed';
        let safeIdentity: SafeFailureIdentity = {};
        let final: ResponseDescriptor;

        try {
          let candidate: ResponseDescriptor | undefined;

          failureCode = 'auth_evaluation_failed';
          switch (contract.auth) {
            case 'public': break;
            case 'operator-session': {
              const authResult = this.authPolicy.validateHttpRequest(request);
              if (!authResult.ok) candidate = { statusCode: 401, body: unauthorizedBody() };
              break;
            }
            default: assertNever(contract.auth);
          }

          let parsed: ParsedContractRequest<TContract> | undefined;
          if (!candidate) {
            failureCode = 'request_validation_failed';
            const parsedResult = this.parseRequest(contract, request);
            if (!parsedResult.ok) candidate = { statusCode: 400, body: parsedResult.body };
            else parsed = parsedResult;
          }

          if (!candidate && parsed) {
            failureCode = 'failure_identity_projection_failed';
            safeIdentity = this.projectFailureIdentity(contract, parsed);

            failureCode = 'permission_evaluation_failed';
            const permissionFailure = await this.validatePermission(contract, request, parsed);
            if (permissionFailure) candidate = { statusCode: 403, body: permissionFailure };
          }

          if (!candidate && parsed) {
            failureCode = 'handler_failed';
            const replyCapability: ContractPreSendReply = {
              raw: reply.raw,
              header: (name, value) => { reply.header(name, value); },
            };
            const result = await handler({ request, reply: replyCapability, contract, params: parsed.params, query: parsed.query, body: parsed.body });
            candidate = { statusCode: result.statusCode ?? 200, body: result.body };
          }

          if (!candidate) throw new Error('Contract operation produced no response descriptor.');

          failureCode = 'response_validation_failed';
          const schema = schemaForStatus(contract, candidate.statusCode);
          const parsedResponse = schema?.safeParse(candidate.body);
          if (schema && !parsedResponse?.success) {
            this.eventLogger.appendEventPrepared(() => ({
              kind: 'runtime_actionable_error',
              actionable_error: {
                code: 'contract_response_violation',
                message: 'Operator contract response validation failed.',
                nextAction: 'Fix the route handler to return the declared contract response shape.',
                currentState: {
                  operation: contract.operationId,
                  statusCode: candidate.statusCode,
                  failureCode: 'response_validation_failed',
                },
              },
            }));
            failureCode = 'response_validation_failed';
            throw RESPONSE_CONTRACT_VIOLATION;
          }

          final = { statusCode: candidate.statusCode, body: parsedResponse?.success ? parsedResponse.data : candidate.body };

        } catch (error) {
          rethrowAppLogPublicationError(error);
          request.log.error(
            { operation: contract.operationId, failureCode, ...safeIdentity },
            'Operator contract operation failed',
          );
          final = { statusCode: 500, body: UNEXPECTED_INTERNAL_SERVER_ERROR };
        }

        return reply.status(final.statusCode).send(final.body);
      },
    };
    fastify.route(route);
  }

  private parseRequest<TContract extends OperatorRouteContract>(contract: TContract, request: FastifyRequest):
    | ({ ok: true } & ParsedContractRequest<TContract>)
    | { ok: false; body: Record<string, unknown> } {
    const paramsResult = contract.params?.safeParse(request.params ?? {});
    if (paramsResult && !paramsResult.success) return { ok: false, body: validationErrorBody(contract.operationId, 'params', paramsResult.error) };

    const queryResult = contract.query?.safeParse(request.query ?? {});
    if (queryResult && !queryResult.success) return { ok: false, body: validationErrorBody(contract.operationId, 'query', queryResult.error) };

    const bodyResult = contract.body?.safeParse(request.body ?? {});
    if (bodyResult && !bodyResult.success) return { ok: false, body: validationErrorBody(contract.operationId, 'body', bodyResult.error) };

    return { ok: true, params: paramsResult?.data, query: queryResult?.data, body: bodyResult?.data };
  }

  private projectFailureIdentity<TContract extends OperatorRouteContract>(contract: TContract, parsed: ParsedContractRequest<TContract>): SafeFailureIdentity {
    if (!contract.failureIdentity) return {};
    const params = parsed.params as unknown as Record<string, unknown>;
    if (contract.failureIdentity.kind === 'session') {
      return { sessionId: ConversationSessionIdSchema.parse(params[contract.failureIdentity.parameter]) };
    }
    return { cardId: cardIdSchema.parse(params[contract.failureIdentity.parameter]) };
  }

  private async validatePermission<TContract extends OperatorRouteContract>(
    contract: TContract,
    request: FastifyRequest,
    parsed: ParsedContractRequest<TContract>,
  ): Promise<Record<string, unknown> | null> {
    if (!contract.permissions) return null;
    const decision = isPermissionAllowed(await contract.permissions({ contract, request, params: parsed.params, query: parsed.query, body: parsed.body }));
    return decision.allowed ? null : forbiddenBody(decision.reason);
  }

}
