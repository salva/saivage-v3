import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import type { z } from 'zod';
import { getAuthPolicy } from './auth-policy.js';
import type { EventBus, EventKind } from '../events/index.js';
import type { OperatorRouteContract } from '../contracts/index.js';


export interface ContractPermissionContext<TContract extends OperatorRouteContract = OperatorRouteContract> {
  contract: TContract;
  params: unknown;
  query: unknown;
  body: unknown;
  request: FastifyRequest;
}

export type ContractPermissionPredicate<TContract extends OperatorRouteContract = OperatorRouteContract> = (
  context: ContractPermissionContext<TContract>,
) => boolean | { allowed: true } | { allowed: false; reason?: string } | Promise<boolean | { allowed: true } | { allowed: false; reason?: string }>;

export interface ContractRequestContext<TContract extends OperatorRouteContract = OperatorRouteContract> extends ContractPermissionContext<TContract> {
  reply: FastifyReply;
}

export type ContractHandler<TContract extends OperatorRouteContract = OperatorRouteContract> = (
  context: ContractRequestContext<TContract>,
) => Promise<ContractHandlerResult> | ContractHandlerResult;

export interface ContractHandlerResult {
  statusCode?: number;
  body?: unknown;
}

export interface ContractRuntimeOptions {
  eventBus?: EventBus;
}

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

function internalErrorBody(message = 'Internal server error'): Record<string, unknown> {
  return { error: 'InternalServerError', message };
}

function contractViolationBody(operationId: string): Record<string, unknown> {
  return { error: 'ContractViolation', message: `${operationId} response did not match the operator API contract` };
}

function schemaForStatus(contract: OperatorRouteContract, statusCode: number): z.ZodTypeAny | undefined {
  return contract.response?.[statusCode] ?? (statusCode >= 200 && statusCode < 300 ? contract.success : contract.error);
}

function isPermissionAllowed(result: Awaited<ReturnType<ContractPermissionPredicate>>): { allowed: boolean; reason?: string } {
  if (typeof result === 'boolean') return { allowed: result };
  return result.allowed ? { allowed: true } : { allowed: false, reason: result.reason };
}

export function defineContract<TContract extends OperatorRouteContract>(contract: TContract): TContract {
  return contract;
}

export class ContractRuntime {
  private readonly eventBus?: EventBus;

  constructor(options: ContractRuntimeOptions = {}) {
    this.eventBus = options.eventBus;
  }

  mount<TContracts extends Record<string, OperatorRouteContract>>(
    fastify: FastifyInstance,
    contracts: TContracts,
    handlers: { [K in keyof TContracts]?: ContractHandler<TContracts[K]> },
  ): void {
    for (const [operationId, contract] of Object.entries(contracts) as Array<[keyof TContracts, TContracts[keyof TContracts]]>) {
      const handler = handlers[operationId];
      if (!handler) continue;
      this.mountOne(fastify, contract, handler as ContractHandler);
    }
  }

  private mountOne(fastify: FastifyInstance, contract: OperatorRouteContract, handler: ContractHandler): void {
    const route: RouteOptions = {
      method: contract.method,
      url: contract.path,
      handler: async (request, reply) => {
        const authFailure = this.validateAuth(contract, request);
        if (authFailure) return reply.status(401).send(this.validateEnvelope(contract, 401, authFailure));

        const parsed = this.parseRequest(contract, request);
        if (!parsed.ok) return reply.status(400).send(this.validateEnvelope(contract, 400, parsed.body));

        const permissionFailure = await this.validatePermission(contract, request, parsed);
        if (permissionFailure) return reply.status(403).send(this.validateEnvelope(contract, 403, permissionFailure));

        let result: ContractHandlerResult;
        try {
          result = await handler({ request, reply, contract, params: parsed.params, query: parsed.query, body: parsed.body });
        } catch (err) {
          request.log.error({ err, operationId: contract.operationId }, 'Contract handler threw');
          return reply.status(500).send(this.validateEnvelope(contract, 500, internalErrorBody()));
        }
        if (reply.sent) return reply;

        const statusCode = result.statusCode ?? 200;
        if (statusCode === 204) return reply.status(204).send();
        const response = this.validateResponse(contract, statusCode, result.body, request);
        return reply.status(response.statusCode).send(response.body);
      },
    };
    fastify.route(route);
  }

  private validateAuth(contract: OperatorRouteContract, request: FastifyRequest): Record<string, unknown> | null {
    const auth = contract.auth;
    if (auth === 'public') return null;
    if (auth !== 'operator-session') return { error: 'Unauthorized', statusCode: 401, message: `${auth} is not available for operator routes` };
    const result = getAuthPolicy().validateHttpRequest(request);
    return result.ok ? null : unauthorizedBody();
  }

  private parseRequest(contract: OperatorRouteContract, request: FastifyRequest):
    | { ok: true; params: unknown; query: unknown; body: unknown }
    | { ok: false; body: Record<string, unknown> } {
    const paramsResult = contract.params?.safeParse(request.params ?? {});
    if (paramsResult && !paramsResult.success) return { ok: false, body: validationErrorBody(contract.operationId, 'params', paramsResult.error) };

    const queryResult = contract.query?.safeParse(request.query ?? {});
    if (queryResult && !queryResult.success) return { ok: false, body: validationErrorBody(contract.operationId, 'query', queryResult.error) };

    const bodyResult = contract.body?.safeParse(request.body ?? {});
    if (bodyResult && !bodyResult.success) return { ok: false, body: validationErrorBody(contract.operationId, 'body', bodyResult.error) };

    return { ok: true, params: paramsResult?.data, query: queryResult?.data, body: bodyResult?.data };
  }

  private async validatePermission(
    contract: OperatorRouteContract,
    request: FastifyRequest,
    parsed: { params: unknown; query: unknown; body: unknown },
  ): Promise<Record<string, unknown> | null> {
    if (!contract.permissions) return null;
    const decision = isPermissionAllowed(await contract.permissions({ contract, request, params: parsed.params, query: parsed.query, body: parsed.body }));
    return decision.allowed ? null : forbiddenBody(decision.reason);
  }

  private validateEnvelope(contract: OperatorRouteContract, statusCode: number, body: unknown): unknown {
    const schema = schemaForStatus(contract, statusCode);
    if (!schema) return body;
    const parsed = schema.safeParse(body);
    return parsed.success ? parsed.data : body;
  }

  private validateResponse(contract: OperatorRouteContract, statusCode: number, body: unknown, request: FastifyRequest): { statusCode: number; body: unknown } {
    const schema = schemaForStatus(contract, statusCode);
    if (!schema) return { statusCode, body };
    const parsed = schema.safeParse(body);
    if (parsed.success) {
      this.emitAudit(contract, statusCode, parsed.data, request);
      return { statusCode, body: parsed.data };
    }

    const violation = contractViolationBody(contract.operationId);
    request.log.error({ operationId: contract.operationId, statusCode, issues: zodIssues(parsed.error) }, 'Contract response validation failed');
    try {
      this.eventBus?.emit('runtime_actionable_error', {
        actionable_error: {
          code: 'contract_response_violation',
          message: `${contract.operationId} returned an invalid ${statusCode} response`,
          nextAction: 'Fix the route handler to return the declared contract response shape.',
          currentState: { operationId: contract.operationId, statusCode, issues: zodIssues(parsed.error) },
        },
      });
    } catch (err) {
      request.log.warn({ err, operationId: contract.operationId }, 'Failed to emit contract response violation event');
    }
    return { statusCode: 500, body: this.validateEnvelope(contract, 500, violation) };
  }

  private emitAudit(contract: OperatorRouteContract, statusCode: number, body: unknown, request: FastifyRequest): void {
    if (!contract.audit || statusCode < 200 || statusCode >= 300) return;
    try {
      this.eventBus?.emit(contract.audit.kind as EventKind, {
        id: `${contract.operationId}:${Date.now()}`,
        action: contract.audit.action ?? contract.operationId,
        target_kind: contract.audit.targetKind ?? null,
        target_id: contract.audit.targetId?.({ request, body }) ?? null,
        outcome: 'success',
        created_at: new Date().toISOString(),
        actor: 'operator',
        surface: 'rest',
      } as never);
    } catch (err) {
      request.log.warn({ err, operationId: contract.operationId }, 'Failed to emit contract audit event');
    }
  }
}
