import { z } from 'zod';
import { agentNameSchema } from '../schemas/agent-name.js';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
export const reconfigureParamsSchema = z.union([
  z.object({ action: z.literal('set_agent_model_route'), agent: agentNameSchema, model_route: identifier }).strict(),
  z.object({ action: z.literal('set_model_failover'), for_model: z.string().min(1), ordered_failover_models: z.array(z.string().min(1)) }).strict(),
  z.object({ action: z.literal('set_server_setting'), key: z.literal('port'), value: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('set_server_setting'), key: z.literal('host'), value: z.string() }).strict(),
]);
export type ReconfigureParams = z.infer<typeof reconfigureParamsSchema>;
