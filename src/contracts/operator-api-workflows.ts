import { z } from 'zod';
import { agentNameSchema, cardTypeSchema, recordNameSchema } from '../schemas/index.js';
import { operatorSessionContract, UnauthorizedErrorSchema, ValidationErrorSchema, UnexpectedInternalServerErrorSchema, type OperatorRouteContract } from './operator-api-core.js';

export const WorkflowPresentationSchema = z.object({
  card_type: cardTypeSchema,
  nodes: z.array(z.object({ node_id: z.string().min(1), agent_name: agentNameSchema }).strict()).min(1),
  entries: z.array(z.object({ entry: z.enum(['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED']), node_id: z.string().min(1) }).strict()).length(4),
  edges: z.array(z.object({
    source_node_id: z.string().min(1), outcome: z.string().min(1), condition: z.enum(['default', 'pending_notifications']),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('node'), node_id: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('terminal'), terminal: z.enum(['DONE', 'BLOCKED', 'FAILED']) }).strict(),
    ]),
  }).strict()).min(1),
  terminals: z.array(z.object({ terminal: z.enum(['DONE', 'BLOCKED', 'FAILED']) }).strict()).length(3),
  records: z.array(z.object({ name: recordNameSchema, bootstrap: z.boolean() }).strict()),
}).strict();
export type WorkflowPresentation = z.infer<typeof WorkflowPresentationSchema>;
const WorkflowTypeNotFoundSchema = z.object({ error: z.literal('workflow_type_not_found'), card_type: cardTypeSchema }).strict();
export const workflowOperatorApiContracts = {
  'workflows.presentation': {
    operationId: 'workflows.presentation', method: 'GET', path: '/api/workflows/:cardType/presentation',
    params: z.object({ cardType: cardTypeSchema }).strict(), success: WorkflowPresentationSchema,
    response: { 200: WorkflowPresentationSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 404: WorkflowTypeNotFoundSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
} as const satisfies Record<string, OperatorRouteContract>;
