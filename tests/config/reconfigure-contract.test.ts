import { describe, expect, it } from '@jest/globals';

import { reconfigureParamsSchema } from '../../src/config/index.js';

describe('reconfigure input contract', () => {
  const valid = [
    { action: 'set_role_routing', role: 'planner', model_candidate: 'tok_model' },
    { action: 'set_failover_chain', for_model: 'sk-model', ordered_failover_models: ['rt-model'] },
    { action: 'mcp_add', name: 'tok_server', command: 'node', args: ['server.js'], env: { TOKEN: 'secret' } },
    { action: 'mcp_edit', name: 'ghu_server', command: 'bun', args: [], env: {} },
    { action: 'mcp_remove', name: 'rt_server' },
    { action: 'set_runtime_setting', key: 'continuous_improvement', value: true },
    { action: 'set_runtime_setting', key: 'process_timeouts', value: { planner_ms: 1, executor_ms: 2, reviewer_ms: 3 } },
    { action: 'set_server_setting', key: 'port', value: 8181 },
    { action: 'set_server_setting', key: 'host', value: 'tok_host' },
  ] as const;

  it.each(valid)('accepts the closed $action/$key variant', (input) => {
    expect(reconfigureParamsSchema.parse(input)).toEqual(input);
  });

  it.each([
    { action: 'set_role_routing', role: 'planner' },
    { action: 'set_role_routing', role: 'planner', model_candidate: 'm', value: true },
    { action: 'set_failover_chain', for_model: 'm', ordered_failover_models: 'fallback' },
    { action: 'mcp_add', name: 'server' },
    { action: 'mcp_edit', name: 'server', command: '' },
    { action: 'mcp_remove', name: 'server', command: 'node' },
    { action: 'set_runtime_setting', key: 'continuous_improvement', value: 'true' },
    { action: 'set_runtime_setting', key: 'process_timeouts', value: { planner_ms: 1, executor_ms: 2 } },
    { action: 'set_runtime_setting', key: 'unknown', value: true },
    { action: 'set_server_setting', key: 'port', value: '8181' },
    { action: 'set_server_setting', key: 'host', value: 127 },
    { action: 'set_server_setting', key: 'unknown', value: true },
    { action: 'unknown' },
  ])('rejects wrong action/member/key/value combinations', (input) => {
    expect(reconfigureParamsSchema.safeParse(input).success).toBe(false);
  });
});
