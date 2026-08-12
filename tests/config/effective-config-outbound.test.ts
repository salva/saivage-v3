import { describe, expect, it } from '@jest/globals';
import { projectEffectiveConfigForOutbound } from '../../src/config/effective-config-outbound.js';
import {
  outboundEffectiveSaivageConfigSchema,
  type OutboundEffectiveSaivageConfig,
} from '../../src/schemas/index.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { SECRET_REDACTION_PLACEHOLDER } from '../../src/redaction/index.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

describe('effective config outbound boundary', () => {
  it('projects the complete effective shape without endpoint credentials or input mutation', () => {
    const input = effectiveSaivageConfigSchema.parse({
      ...structuredClone(TEST_SAIVAGE_CONFIG),
      providers: {
        'provider-namespace': {
          priority: 7,
          models: ['test-model'],
          apiKey: 'provider-secret',
          baseUrl: 'https://provider-user:provider-pass@provider.example.test/v1?token=secret#private',
          authProfile: 'provider-profile',
          accounts: {
            'account-namespace': {
              priority: 3,
              apiKey: 'account-secret',
              baseUrl: 'https://account-user:account-pass@account.example.test/v1?key=secret#private',
              authProfile: 'account-profile',
              models: ['test-model'],
            },
          },
        },
      },
      mcpServers: {
        local: {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { ORDINARY_NAME: 'ordinary-value', API_TOKEN: 'secret-value' },
          disabled: false,
          autostart: true,
        },
        remote: {
          transport: 'streamable-http',
          url: 'https://mcp-user:mcp-pass@mcp.example.test/rpc?token=secret#private',
          disabled: true,
          autostart: false,
        },
      },
    });
    const before = structuredClone(input);

    const projected: OutboundEffectiveSaivageConfig = projectEffectiveConfigForOutbound(input);

    expect(projected).toEqual({
      ...before,
      providers: {
        'provider-namespace': {
          priority: 7,
          models: ['test-model'],
          apiKey: SECRET_REDACTION_PLACEHOLDER,
          authProfile: 'provider-profile',
          accounts: {
            'account-namespace': {
              priority: 3,
              apiKey: SECRET_REDACTION_PLACEHOLDER,
              authProfile: 'account-profile',
              models: ['test-model'],
            },
          },
        },
      },
      mcpServers: {
        local: {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { ORDINARY_NAME: SECRET_REDACTION_PLACEHOLDER, API_TOKEN: SECRET_REDACTION_PLACEHOLDER },
          disabled: false,
          autostart: true,
        },
        remote: {
          transport: 'streamable-http',
          url: 'https://%5BREDACTED%5D:%5BREDACTED%5D@mcp.example.test/rpc?[REDACTED]',
          disabled: true,
          autostart: false,
        },
      },
    });
    expect(input).toEqual(before);
    expect(effectiveSaivageConfigSchema.safeParse(input).success).toBe(true);
    expect(outboundEffectiveSaivageConfigSchema.safeParse(input).success).toBe(false);
    expect(outboundEffectiveSaivageConfigSchema.parse(projected)).toEqual(projected);
  });
});
