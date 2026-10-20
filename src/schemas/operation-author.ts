import { z } from 'zod';
import { agentNameSchema, type AgentName } from './agent-name.js';

/** Credential-holder label, not an assertion about a person or model. */
export const externalPrincipalSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const externalActorSchema = z.string().regex(/^external:[a-z][a-z0-9-]{0,63}$/);
export const operationAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agent: agentNameSchema }).strict(),
  z.object({ kind: z.literal('external-agent'), principal: externalPrincipalSchema }).strict(),
]);
export type OperationAuthor = z.infer<typeof operationAuthorSchema>;
export type OperationActor = AgentName | `external:${string}`;
export function operationActor(author: OperationAuthor): OperationActor {
  return author.kind === 'agent' ? author.agent : `external:${author.principal}`;
}
