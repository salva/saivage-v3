import { z } from 'zod';

export type ContractAuthClass = 'public' | 'operator-session' | 'agent-session' | 'mcp-tool-token';

export const HttpMethodSchema = z.enum(['GET', 'POST', 'PATCH', 'DELETE']);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  statusCode: z.number().int().optional(),
}).catchall(z.unknown());

export const UnexpectedInternalServerErrorSchema = z.object({
  error: z.literal('InternalServerError'),
  message: z.literal('Internal server error'),
}).strict();
export type UnexpectedInternalServerError = z.infer<typeof UnexpectedInternalServerErrorSchema>;
export const UNEXPECTED_INTERNAL_SERVER_ERROR: Readonly<UnexpectedInternalServerError> = Object.freeze(
  UnexpectedInternalServerErrorSchema.parse({ error: 'InternalServerError', message: 'Internal server error' }),
);

export const ValidationErrorSchema = ApiErrorSchema.extend({
  error: z.union([z.literal('ValidationError'), z.literal('Request validation failed')]),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export const UnauthorizedErrorSchema = ApiErrorSchema.extend({
  error: z.literal('Unauthorized'),
  statusCode: z.literal(401).optional(),
});

export const ForbiddenErrorSchema = ApiErrorSchema.extend({
  error: z.literal('Forbidden'),
  statusCode: z.literal(403).optional(),
});

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
  TError extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  operationId: string;
  method: z.infer<typeof HttpMethodSchema>;
  path: string;
  params?: TParams;
  query?: TQuery;
  body?: TBody;
  success: TSuccess;
  error: TError;
  response?: Record<number, z.ZodTypeAny>;
  auth: ContractAuthClass;
  permissions?: (context: { contract: OperatorRouteContract; params: unknown; query: unknown; body: unknown; request: unknown }) => boolean | { allowed: true } | { allowed: false; reason?: string } | Promise<boolean | { allowed: true } | { allowed: false; reason?: string }>;
  audit?: { kind: string; action?: string; targetKind?: string | null; targetId?: (context: { request: unknown; body: unknown }) => string | null };
  failureIdentity?: ContractFailureIdentity;
  describe?: string;
  successSchemaName: string;
};
