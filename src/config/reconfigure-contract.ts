import { z } from 'zod';

import { agentRoleSchema } from '../schemas/index.js';

const setRoleRoutingSchema = z.object({
  action: z.literal('set_role_routing'),
  role: agentRoleSchema,
  model_candidate: z.string().min(1),
}).strict();

const setFailoverChainSchema = z.object({
  action: z.literal('set_failover_chain'),
  for_model: z.string().min(1),
  ordered_failover_models: z.array(z.string().min(1)),
}).strict();

const mcpServerMutationFields = {
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
};

const mcpAddSchema = z.object({ action: z.literal('mcp_add'), ...mcpServerMutationFields }).strict();
const mcpEditSchema = z.object({ action: z.literal('mcp_edit'), ...mcpServerMutationFields }).strict();
const mcpRemoveSchema = z.object({ action: z.literal('mcp_remove'), name: z.string().min(1) }).strict();

const runtimeSettingSchema = z.union([
  z.object({ action: z.literal('set_runtime_setting'), key: z.literal('continuous_improvement'), value: z.boolean() }).strict(),
  z.object({
    action: z.literal('set_runtime_setting'),
    key: z.literal('process_timeouts'),
    value: z.object({
      planner_ms: z.number().int().positive(),
      executor_ms: z.number().int().positive(),
      reviewer_ms: z.number().int().positive(),
    }).strict(),
  }).strict(),
]);

const serverSettingSchema = z.union([
  z.object({ action: z.literal('set_server_setting'), key: z.literal('port'), value: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('set_server_setting'), key: z.literal('host'), value: z.string() }).strict(),
]);

export const reconfigureParamsSchema = z.union([
  setRoleRoutingSchema,
  setFailoverChainSchema,
  mcpAddSchema,
  mcpEditSchema,
  mcpRemoveSchema,
  runtimeSettingSchema,
  serverSettingSchema,
]);

export type ReconfigureParams = z.infer<typeof reconfigureParamsSchema>;
