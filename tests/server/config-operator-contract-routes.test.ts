import { describe, expect, it } from '@jest/globals';
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operatorRouteInventory } from '../../src/contracts/operator-api.js';
import { recordControlAction } from '../../src/persistence/index.js';
import { registerOperatorContractRoutes } from '../../src/server/routes/operator-contracts.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import type { SaivageConfig } from '../../src/agents/config-api.js';
import { initProjectTree, testConfigAuthority } from '../helpers/canonical-project.js';
import { writeSaivageConfig } from '../helpers/project-config.js';
import { testAppLogs } from '../helpers/app-logs.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { buildProviderRoutingReadModel } from '../../src/agents/provider-routing-read-model.js';

function testConfig(): SaivageConfig {
  return {
    models: { default: ['test-model'], max_tokens: { analyst: 200 } },
    providers: {
      test: {
        priority: 7,
        models: ['test-model'],
        baseUrl: 'https://provider.example.test',
        apiKey: 'secret-provider-key',
        accounts: {
          primary: { apiKey: 'secret-account-key' },
          secondary: { apiKey: 'secret-account-key-2' },
        },
      },
    },
    server: { host: '127.0.0.1', port: 0 },
    runtime: {},
    security: {},
    compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'test', account: 'primary', model: 'test-model' } },
  } as unknown as SaivageConfig;
}

function providerRoutingReadModelProvider() {
  const registry = new ProviderRegistry(testConfig());
  const readModel = buildProviderRoutingReadModel({ registry, availability: new MemoryCandidateAvailability() });
  return () => readModel;
}

describe('contract-backed config/providers/control-actions routes', () => {
  it('returns the latest redacted startup-selected config through the operator contract runtime', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-config-route-'));
    const fastify = Fastify({ logger: false });
    try {
      writeSaivageConfig(projectRoot, {
        models: testConfig().models,
        providers: testConfig().providers,
        server: { host: '127.0.0.1', port: 8080 },
        compaction: testConfig().compaction,
      });
      registerOperatorContractRoutes({ fastify, projectRoot, configAuthority: testConfigAuthority(projectRoot), saivageConfig: testConfig(), providerRoutingReadModelProvider: providerRoutingReadModelProvider(), authPolicy: new AuthPolicy() });

      const response = await fastify.inject({ method: 'GET', url: '/api/config' });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { config: { providers: Record<string, { apiKey?: string; accounts?: Record<string, { apiKey?: string }> }> }; warnings: string[] };
      expect(body.warnings).toEqual([]);
      expect(JSON.stringify(body.config)).not.toContain('secret-provider-key');
      expect(body.config.providers.test.apiKey).toBe('[REDACTED]');
      expect(body.config.providers.test.accounts?.primary.apiKey).toBe('[REDACTED]');
    } finally {
      await fastify.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('projects provider summaries with account counts', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-providers-route-'));
    const fastify = Fastify({ logger: false });
    try {
      writeSaivageConfig(projectRoot, {
        models: testConfig().models,
        providers: testConfig().providers,
        compaction: testConfig().compaction,
      });
      registerOperatorContractRoutes({ fastify, projectRoot, configAuthority: testConfigAuthority(projectRoot), saivageConfig: testConfig(), providerRoutingReadModelProvider: providerRoutingReadModelProvider(), authPolicy: new AuthPolicy() });

      const response = await fastify.inject({ method: 'GET', url: '/api/providers' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ availabilityScope: 'process_local_reset_on_restart', providers: { test: expect.objectContaining({
        priority: 7,
        models: ['test-model'],
        baseUrl: 'https://provider.example.test',
        candidateCount: 2,
        availableCandidateCount: 2,
        availability: [
          { candidate: { provider: 'test', account: 'primary', model: 'test-model' }, state: 'HEALTHY' },
          { candidate: { provider: 'test', account: 'secondary', model: 'test-model' }, state: 'HEALTHY' },
        ],
      }) } });
    } finally {
      await fastify.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('filters and sorts control actions through the operator contract runtime', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-control-actions-route-'));
    initProjectTree(projectRoot);
    const fastify = Fastify({ logger: false });
    try {
      mkdirSync(join(projectRoot, '.saivage', 'runtime'), { recursive: true });
      recordControlAction(testAppLogs(projectRoot), {
        id: 'older-action',
        created_at: '2026-01-01T00:00:00.000Z',
        actor: 'analyst',
        surface: 'rest',
        action: 'card.update',
        target_kind: 'card',
        target_id: '11111111-1111-4111-8111-111111111111',
        params_summary: 'token=should-redact',
        outcome: 'ok',
        outcome_summary: 'updated',
      });
      recordControlAction(testAppLogs(projectRoot), {
        id: 'newer-action',
        created_at: '2026-01-02T00:00:00.000Z',
        actor: 'analyst',
        surface: 'rest',
        action: 'card.update',
        target_kind: 'card',
        target_id: '11111111-1111-4111-8111-111111111111',
        params_summary: 'safe params',
        outcome: 'ok',
        outcome_summary: 'updated',
      });
      recordControlAction(testAppLogs(projectRoot), {
        id: 'other-card-action',
        created_at: '2026-01-03T00:00:00.000Z',
        actor: 'analyst',
        surface: 'rest',
        action: 'card.update',
        target_kind: 'card',
        target_id: '22222222-2222-4222-8222-222222222222',
        params_summary: 'safe params',
        outcome: 'ok',
        outcome_summary: 'updated',
      });
      registerOperatorContractRoutes({ fastify, projectRoot, configAuthority: testConfigAuthority(projectRoot), providerRoutingReadModelProvider: providerRoutingReadModelProvider(), authPolicy: new AuthPolicy() });

      const response = await fastify.inject({ method: 'GET', url: '/api/control-actions?card_id=11111111-1111-4111-8111-111111111111&since=2026-01-01T12:00:00.000Z' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        control_actions: [expect.objectContaining({ id: 'newer-action', target_id: '11111111-1111-4111-8111-111111111111' })],
        total: 1,
      });
    } finally {
      await fastify.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports a selected-file read failure without probing another config', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-config-error-route-'));
    const fastify = Fastify({ logger: false });
    try {
      registerOperatorContractRoutes({ fastify, projectRoot, configAuthority: testConfigAuthority(projectRoot), providerRoutingReadModelProvider: providerRoutingReadModelProvider(), authPolicy: new AuthPolicy() });

      const configResponse = await fastify.inject({ method: 'GET', url: '/api/config' });
      const providersResponse = await fastify.inject({ method: 'GET', url: '/api/providers' });

      expect(configResponse.statusCode).toBe(500);
      expect(configResponse.json()).toEqual({ error: 'Configuration unavailable', message: expect.stringContaining('Configuration not found') });
      expect(providersResponse.statusCode).toBe(200);
      expect(providersResponse.json()).toEqual(providerRoutingReadModelProvider()());
    } finally {
      await fastify.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports the Analyst reserve invariant through the selected /api/config authority', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-config-reserve-route-'));
    const fastify = Fastify({ logger: false });
    try {
      writeSaivageConfig(projectRoot, {
        models: { default: ['test-model'], max_tokens: { analyst: 201 } },
        providers: testConfig().providers,
        compaction: testConfig().compaction,
      });
      registerOperatorContractRoutes({ fastify, projectRoot, configAuthority: testConfigAuthority(projectRoot), providerRoutingReadModelProvider: providerRoutingReadModelProvider(), authPolicy: new AuthPolicy() });

      const response = await fastify.inject({ method: 'GET', url: '/api/config' });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: 'Configuration unavailable',
        message: expect.stringContaining('Effective Analyst max tokens 201 (source: analyst) exceed reserved completion tokens 200'),
      });
    } finally {
      await fastify.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('declares exactly one contract inventory owner for each migrated route', () => {
    expect(operatorRouteInventory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'config.get', method: 'GET', path: '/api/config', successSchemaName: 'ConfigGetResponse' }),
      expect.objectContaining({ operationId: 'providers.list', method: 'GET', path: '/api/providers', successSchemaName: 'ProvidersListResponse' }),
      expect.objectContaining({ operationId: 'controlActions.list', method: 'GET', path: '/api/control-actions', successSchemaName: 'ControlActionsListResponse' }),
    ]));
    expect(operatorRouteInventory().filter((route) => route.path === '/api/config')).toHaveLength(1);
    expect(operatorRouteInventory().filter((route) => route.path === '/api/providers')).toHaveLength(1);
    expect(operatorRouteInventory().filter((route) => route.path === '/api/control-actions')).toHaveLength(1);
  });
});
