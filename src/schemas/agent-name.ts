import { z } from 'zod';

export const agentNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u, 'Expected a lowercase agent name of at most 64 ASCII letters, digits, or hyphens.');
export type AgentName = z.infer<typeof agentNameSchema>;

export function parseAgentName(value: unknown): AgentName {
  return agentNameSchema.parse(value);
}
