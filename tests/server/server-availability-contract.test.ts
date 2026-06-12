import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerInstance } from '../../src/server/server.js';
import { buildServerAvailability } from '../../src/server/availability.js';
import { resetAuthPolicyForTests } from '../../src/server/auth-policy.js';
import { createTestRuntimeApplication } from '../helpers/test-runtime-application.js';
import { initRuntimeState } from '../../src/runtime/state.js';

const AUTH_TOKEN = 'availability-test-token';

function setupProject(root: string, withRuntimeState = true): void {
  const sd = join(root, '.saivage');
  for (const d of ['runtime', 'cards/by-id', 'cards/tree', 'cards/dependencies', 'notes/by-card', 'agents/sessions', 'agents/messages', 'diaries']) {
    mkdirSync(join(sd, d), { recursive: true });
  }
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({ server: { host: '127.0.0.1', port: 8080 }, models: { default: ['test-model'] }, providers: {} }, null, 2));
  if (withRuntimeState) initRuntimeState(root);
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: {} }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
}

describe('server availability contract', () => {
  let tmpDir: string;
  let server: ServerInstance | undefined;
  let originalToken: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-availability-'));
    originalToken = process.env['SAIVAGE_API_TOKEN'];
    process.env['SAIVAGE_API_TOKEN'] = AUTH_TOKEN;
    resetAuthPolicyForTests();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
    if (originalToken === undefined) delete process.env['SAIVAGE_API_TOKEN'];
    else process.env['SAIVAGE_API_TOKEN'] = originalToken;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks runtime available when live runtime services and persisted state are present', () => {
    setupProject(tmpDir, true);
    const availability = buildServerAvailability({ projectRoot: tmpDir, runtimeApplication: createTestRuntimeApplication(), mcpManager: { getStatus: () => [] } });
    expect(availability.components.api.state).toBe('available');
    expect(availability.components.runtime).toEqual(expect.objectContaining({ state: 'available', source: 'runtime-application' }));
    expect(availability.components.mcp).toEqual(expect.objectContaining({ state: 'idle', source: 'mcp-manager' }));
  });

  it('uses live runtime services even when legacy runtime state is absent', () => {
    setupProject(tmpDir, false);
    const availability = buildServerAvailability({ projectRoot: tmpDir, runtimeApplication: createTestRuntimeApplication(), mcpManager: { getStatus: () => [] } });
    expect(availability.components.runtime).toEqual(expect.objectContaining({ state: 'available', source: 'runtime-application' }));
    expect(availability.components.mcp.state).toBe('idle');
  });

  it('distinguishes unknown runtime and empty MCP manager states', () => {
    setupProject(tmpDir, false);
    const availability = buildServerAvailability({
      projectRoot: tmpDir,
      runtimeApplication: createTestRuntimeApplication(),
      mcpManager: { getStatus: () => [] },
    });
    expect(availability.components.runtime).toEqual(expect.objectContaining({ state: 'available', source: 'runtime-application' }));
    expect(availability.components.mcp).toEqual(expect.objectContaining({ state: 'idle', source: 'mcp-manager' }));
    expect(availability.components.mcp.state).not.toBe('degraded');
    expect(availability.components.mcp.diagnostic?.code).toBe('mcp-manager-empty');
  });

  it('adds serverAvailability to health, runtime status, MCP status, and state without removing existing fields', async () => {
    setupProject(tmpDir, true);
    const { createServer } = await import('../../src/server/server.js');
    server = await createServer(tmpDir);

    const health = await server.fastify.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    const healthBody = health.json() as Record<string, any>;
    expect(healthBody).toEqual({ status: 'ok', version: '0.1.0', project: 'saivage-v3' });

    const ready = await server.fastify.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual(expect.objectContaining({ status: 'ready', serverAvailability: expect.any(Object) }));
    expect(ready.json().serverAvailability.components.api.state).toBe('available');

    const runtimeStatus = await server.fastify.inject({ method: 'GET', url: '/api/runtime/status', headers: { authorization: `Bearer ${AUTH_TOKEN}` } });
    expect(runtimeStatus.statusCode).toBe(200);
    expect(runtimeStatus.json()).toEqual(expect.objectContaining({ runtime: 'idle', paused: false, currentCardId: null, goalCount: 0, actorRuntime: expect.any(Object), serverAvailability: expect.any(Object) }));
    expect(runtimeStatus.json().actorRuntime).toEqual(expect.objectContaining({ pauseMode: 'running', cards: [], agents: [], diagnostics: [] }));
    expect(JSON.stringify(runtimeStatus.json().actorRuntime)).not.toContain('state_value');
    expect(JSON.stringify(runtimeStatus.json().actorRuntime)).not.toContain('context');

    const mcpStatus = await server.fastify.inject({ method: 'GET', url: '/api/mcp/status', headers: { authorization: `Bearer ${AUTH_TOKEN}` } });
    expect(mcpStatus.statusCode).toBe(200);
    expect(mcpStatus.json()).toEqual(expect.objectContaining({ servers: [], serverAvailability: expect.any(Object) }));
    expect(mcpStatus.json().serverAvailability.components.mcp.state).toBe('idle');

    const state = await server.fastify.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${AUTH_TOKEN}` } });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toEqual(expect.objectContaining({ runtime: expect.any(Object), cardIndex: expect.any(Object), serverAvailability: expect.any(Object) }));
  });
});
