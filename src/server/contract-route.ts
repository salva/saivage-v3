import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { OperatorRouteContract } from '../contracts/operator-api.js';

export interface ContractRequest<TContract extends OperatorRouteContract> {
  request: FastifyRequest;
  reply: FastifyReply;
  params: TContract['params'] extends z.ZodTypeAny ? z.infer<TContract['params']> : undefined;
  query: TContract['query'] extends z.ZodTypeAny ? z.infer<TContract['query']> : undefined;
  body: TContract['body'] extends z.ZodTypeAny ? z.infer<TContract['body']> : undefined;
}

function validationErrorBody(operationId: string, target: string, error: z.ZodError): Record<string, unknown> {
  return {
    error: 'Request validation failed',
    message: `${operationId} ${target} did not match the operator API contract`,
    issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  };
}

export function parseContractRequest<TContract extends OperatorRouteContract>(
  contract: TContract,
  request: FastifyRequest,
): { ok: true; params: ContractRequest<TContract>['params']; query: ContractRequest<TContract>['query']; body: ContractRequest<TContract>['body'] } | { ok: false; statusCode: number; body: Record<string, unknown> } {
  const paramsResult = contract.params?.safeParse(request.params ?? {});
  if (paramsResult && !paramsResult.success) {
    return { ok: false, statusCode: 400, body: validationErrorBody(contract.operationId, 'params', paramsResult.error) };
  }

  const queryResult = contract.query?.safeParse(request.query ?? {});
  if (queryResult && !queryResult.success) {
    return { ok: false, statusCode: 400, body: validationErrorBody(contract.operationId, 'query', queryResult.error) };
  }

  const bodyResult = contract.body?.safeParse(request.body ?? {});
  if (bodyResult && !bodyResult.success) {
    return { ok: false, statusCode: 400, body: validationErrorBody(contract.operationId, 'body', bodyResult.error) };
  }

  return {
    ok: true,
    params: (paramsResult?.data ?? undefined) as ContractRequest<TContract>['params'],
    query: (queryResult?.data ?? undefined) as ContractRequest<TContract>['query'],
    body: (bodyResult?.data ?? undefined) as ContractRequest<TContract>['body'],
  };
}

export function validateContractSuccess<TContract extends OperatorRouteContract>(
  contract: TContract,
  payload: unknown,
): z.infer<TContract['success']> {
  return contract.success.parse(payload) as z.infer<TContract['success']>;
}

export async function sendContractSuccess<TContract extends OperatorRouteContract>(
  contract: TContract,
  reply: FastifyReply,
  payload: unknown,
): Promise<FastifyReply> {
  const parsed = validateContractSuccess(contract, payload);
  return reply.send(parsed);
}
