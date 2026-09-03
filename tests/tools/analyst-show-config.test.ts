import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outboundEffectiveSaivageConfigSchema } from '../../src/schemas/index.js';
import { show_config } from '../../src/tools/analyst-misc-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

describe('show_config outbound projection', () => {
  it('returns the shared safe effective config shape', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-show-config-'));
    try {
      const config = structuredClone(TEST_SAIVAGE_CONFIG);
      config.providers.test = {
        ...config.providers.test,
        apiKey: 'provider-secret',
        baseUrl: 'https://provider-user:provider-pass@provider.example.test/v1?token=secret#private',
      };
      config.mcpServers = {
        remote: {
          transport: 'streamable-http',
          url: 'https://mcp-user:mcp-pass@mcp.example.test/rpc?token=secret#private',
          disabled: false,
          autostart: true,
        },
      };
      const result = await show_config({ configAuthority: createTestConfigAuthority(root, { config }) } as ToolContext);
      expect(result.kind).toBe('succeeded');
      if (result.kind !== 'succeeded' || typeof result.data !== 'object' || result.data === null || !('config' in result.data)) throw new Error('show_config returned no config');
      const projected = outboundEffectiveSaivageConfigSchema.parse(result.data.config);
      expect(JSON.stringify(projected)).not.toContain('baseUrl');
      expect(JSON.stringify(projected)).not.toContain('provider-user');
      expect(JSON.stringify(projected)).not.toContain('mcp-user');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
