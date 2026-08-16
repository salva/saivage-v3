import { z } from 'zod';

export type ContractAuthClass = 'public' | 'operator-session';

export type HttpMethod = 'GET' | 'POST';

export const UnexpectedInternalServerErrorSchema = z.object({
  error: z.literal('InternalServerError'),
  message: z.literal('Internal server error'),
}).strict();
export type UnexpectedInternalServerError = z.infer<typeof UnexpectedInternalServerErrorSchema>;
export const UNEXPECTED_INTERNAL_SERVER_ERROR: Readonly<UnexpectedInternalServerError> = Object.freeze(
  UnexpectedInternalServerErrorSchema.parse({ error: 'InternalServerError', message: 'Internal server error' }),
);

export const ValidationErrorSchema = z.object({
  error: z.literal('ValidationError'),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()),
}).strict();

export const UnauthorizedErrorSchema = z.object({
  error: z.literal('Unauthorized'),
  statusCode: z.literal(401),
}).strict();

export const operatorSessionContract = { auth: 'operator-session' } as const;
export const publicContract = { auth: 'public' } as const;

export type ContractFailureIdentity =
  | { kind: 'session'; parameter: 'id' }
  | { kind: 'card'; parameter: 'id' };

export type OperatorRouteContract<
  TParams extends z.ZodTypeAny | undefined = z.ZodTypeAny | undefined,
  TQuery extends z.ZodTypeAny | undefined = z.ZodTypeAny | undefined,
  TBody extends z.ZodTypeAny | undefined = z.ZodTypeAny | undefined,
  TSuccess extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  operationId: string;
  method: HttpMethod;
  path: string;
  params?: TParams;
  query?: TQuery;
  body?: TBody;
  success: TSuccess;
  response: Record<number, z.ZodTypeAny>;
  auth: ContractAuthClass;
  failureIdentity?: ContractFailureIdentity;
  describe?: string;
  successSchemaName: string;
};
