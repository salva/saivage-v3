import { describe, expect, it } from '@jest/globals';
import { ConfigGetResponseSchema } from '../../src/contracts/operator-api-config.js';
import { buildConfigOperatorContractHandlers } from '../../src/server/routes/operator-config-handlers.js';
import { recordControlAction } from '../../src/persistence/control-action-audit.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('config.get outbound projection', () => {
  it('returns an object accepted by the public contract without endpoint credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-config-handler-'));
    try {
      const config = structuredClone(TEST_SAIVAGE_CONFIG);
      config.providers = {
        test: {
          ...config.providers.test,
          apiKey: 'provider-secret',
          baseUrl: 'https://provider-user:provider-pass@provider.example.test/v1?token=secret#private',
        },
      };
      config.mcpServers = {
        remote: {
          transport: 'streamable-http',
          url: 'https://mcp-user:mcp-pass@mcp.example.test/rpc?token=secret#private',
          disabled: false,
          autostart: true,
        },
      };
      const handlers = buildConfigOperatorContractHandlers({
        projectRoot: root,
        configAuthority: createTestConfigAuthority(root, { config }),
        providerRoutingReadModelProvider: () => { throw new Error('providers.list is not under test'); },
      });

      const response = handlers['config.get']({} as never);
      if (response instanceof Promise) throw new Error('config.get unexpectedly returned a Promise');
      const parsed = ConfigGetResponseSchema.parse(response.body);
      expect(JSON.stringify(parsed)).not.toContain('baseUrl');
      expect(JSON.stringify(parsed)).not.toContain('provider-user');
      expect(JSON.stringify(parsed)).not.toContain('mcp-user');
      expect(parsed.config.mcpServers?.remote).toEqual(expect.objectContaining({ url: 'https://%5BREDACTED%5D:%5BREDACTED%5D@mcp.example.test/rpc?[REDACTED]' }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('controlActions.list projection', () => {
  it('forwards card_id and since narrowing to the shared projection', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-control-actions-handler-'));
    try {
      for (const entry of [
        { id: 'planner-retained', actor: 'planner' as const, target_id: 'card-a', created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'analyst-before', actor: 'analyst' as const, target_id: 'card-a', created_at: '2026-01-02T00:00:00.000Z' },
        { id: 'analyst-match', actor: 'analyst' as const, target_id: 'card-a', created_at: '2026-01-03T00:00:00.000Z' },
        { id: 'analyst-other-card', actor: 'analyst' as const, target_id: 'card-b', created_at: '2026-01-04T00:00:00.000Z' },
      ]) recordControlAction(root, () => ({ ...entry, surface: 'rest', action: 'card.inspect', target_kind: 'card', params_summary: '', outcome: 'ok', outcome_summary: '' }));
      const handlers = buildConfigOperatorContractHandlers({
        projectRoot: root,
        configAuthority: createTestConfigAuthority(root),
        providerRoutingReadModelProvider: () => { throw new Error('providers.list is not under test'); },
      });

      const response = handlers['controlActions.list']({ query: { card_id: 'card-a', since: '2026-01-03T00:00:00.000Z' } });
      if (response instanceof Promise) throw new Error('controlActions.list unexpectedly returned a Promise');
      expect(response.body).toEqual({ control_actions: [expect.objectContaining({ id: 'analyst-match' })], total: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
