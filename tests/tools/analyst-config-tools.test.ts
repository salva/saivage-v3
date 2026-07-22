import { describe, expect, it } from '@jest/globals';

import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';
import { saivageConfigSchema } from '../../src/schemas/saivage-config.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { show_config } from '../../src/tools/analyst-misc-tools.js';

describe('Analyst config tools', () => {
  it('uses the effective config owner for show_config', async () => {
    const config = saivageConfigSchema.parse({
      models: { default: ['tok_model'], max_tokens: { analyst: 200 } },
      providers: {
        tok_provider: {
          models: ['tok_model'], apiKey: 'provider-secret', authProfile: 'sk_profile',
          accounts: { ghu_account: { apiKey: 'account-secret', models: ['tok_model'] } },
        },
      },
      compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'tok_provider', account: 'ghu_account', model: 'tok_model' } },
      card_processes: DEFAULT_CARD_PROCESSES,
      mcpServers: {
        rt_stdio: { transport: 'stdio', command: 'tok_command', env: { ORDINARY: 'stdio-secret' } },
        sk_http: { transport: 'streamable-http', url: 'https://tok-host.example.test/mcp?token=structural-value' },
      },
    });
    const ctx = { configAuthority: { loadEffective: () => ({ config, warnings: [] }) } } as unknown as ToolContext;

    const result = await show_config(ctx);

    expect(result).toMatchObject({ success: true, data: { config: {
      models: { default: ['tok_model'] },
      providers: { tok_provider: { apiKey: '[REDACTED]', authProfile: 'sk_profile', accounts: { ghu_account: { apiKey: '[REDACTED]' } } } },
      mcpServers: {
        rt_stdio: { transport: 'stdio', command: 'tok_command', env: { ORDINARY: '[REDACTED]' } },
        sk_http: { transport: 'streamable-http', url: 'https://tok-host.example.test/mcp?token=structural-value' },
      },
    } } });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
    expect(JSON.stringify(result)).not.toContain('account-secret');
    expect(JSON.stringify(result)).not.toContain('stdio-secret');
  });
});
