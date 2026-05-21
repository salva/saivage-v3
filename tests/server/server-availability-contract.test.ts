import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerInstance } from '../../src/server/server.js';
import { buildServerAvailability } from '../../src/server/availability.js';
import { resetAuthPolicyForTests } from '../../src/server/auth-policy.js';

const AUTH_TOKEN = 'availability-test-token';

function setupProject(root: string, withRuntimeState = true): void {
  const sd = join(root, '.saivage');
  for (const d of ['runtime', 'cards/by-id', 'cards/tree', 'cards/dependencies', 'notes/by-card', 'agents/sessions', 'agents/messages', 'diaries']) {
    mkdirSync(join(sd, d), { recursive: true });
  }
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({ server: { host: '127.0.0.1', port: 8080 }, models: { default: ['test-model'] }, providers: {} }, null, 2));
  if (withRuntimeState) {
    writeFileSync(join(sd, 'runtime', 'state.json'), JSON.stringify({
      status: 'idle',
      project_id: 'project',
      pid: process.pid,
      started_at: '2026-01-01T00:00:00.000Z',
      current_card_id: null,
      current_agent_session_id: null,
      paused: false,
      paused_at: null,
      queue: [],
      running_processes: [],
      updated_at: '2026-01-01T00:00:01.000Z',
    }, null, 2));
  }
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

  it('marks runtime degraded when no ActiveRuntime is attached but persisted state exists', () => {
    setupProject(tmpDir, true);
    const availability = buildServerAvailability({ projectRoot: tmpDir });
    expect(availability.components.api.state).toBe('available');
    expect(availability.components.runtime).toEqual(expect.objectContaining({ state: 'degraded', source: 'runtime-state' }));
    expect(availability.components.mcp).toEqual(expect.objectContaining({ state: 'unknown', source: 'unknown' }));
  });

  it('distinguishes runtime and MCP startup failures with redacted diagnostics', () => {
    setupProject(tmpDir, false);
    const availability = buildServerAvailability({
      projectRoot: tmpDir,
      runtimeStartupFailure: () => ({ code: 'active-runtime-start-failed', error: new Error(`token=super-secret ${tmpDir}/.saivage/auth-profiles.json`) }),
      mcpStartupFailure: () => ({ code: 'mcp-manager-start-failed', error: new Error('password=hunter2 failed') }),
    });
    expect(availability.components.runtime.state).toBe('unavailable');
    expect(availability.components.runtime.diagnostic?.code).toBe('active-runtime-start-failed');
    expect(availability.components.runtime.diagnostic?.summary).not.toContain('super-secret');
    expect(availability.components.runtime.diagnostic?.summary).not.toContain(tmpDir);
    expect(availability.components.mcp.state).toBe('unavailable');
    expect(availability.components.mcp.diagnostic?.summary).not.toContain('hunter2');
  });

  it('distinguishes unknown runtime and empty MCP manager states', () => {
    setupProject(tmpDir, false);
    const availability = buildServerAvailability({
      projectRoot: tmpDir,
      mcpManager: () => ({ getStatus: () => [] }) as any,
    });
    expect(availability.components.runtime.state).toBe('unknown');
    expect(availability.components.mcp).toEqual(expect.objectContaining({ state: 'degraded', source: 'mcp-manager' }));
    expect(availability.components.mcp.diagnostic?.code).toBe('mcp-manager-empty');
  });

  it('adds serverAvailability to health, runtime status, MCP status, and state without removing existing fields', async () => {
    setupProject(tmpDir, true);
    const { createServer } = await import('../../src/server/server.js');
    server = await createServer(tmpDir);

    const health = await server.fastify.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    const healthBody = health.json() as Record<string, any>;
    expect(healthBody).toEqual(expect.objectContaining({ status: 'ok', version: '0.1.0', project: 'saivage-v3', runtime: 'idle' }));
    expect(healthBody.serverAvailability.components.api.state).toBe('available');

    const runtimeStatus = await server.fastify.inject({ method: 'GET', url: '/api/runtime/status', headers: { authorization: `Bearer ${AUTH_TOKEN}` } });
    expect(runtimeStatus.statusCode).toBe(200);
    expect(runtimeStatus.json()).toEqual(expect.objectContaining({ runtime: 'idle', paused: false, currentCardId: null, goalCount: 0, serverAvailability: expect.any(Object) }));

    const mcpStatus = await server.fastify.inject({ method: 'GET', url: '/api/mcp/status', headers: { authorization: `Bearer ${AUTH_TOKEN}` } });
    expect(mcpStatus.statusCode).toBe(200);
    expect(mcpStatus.json()).toEqual(expect.objectContaining({ servers: [], serverAvailability: expect.any(Object) }));
    expect(mcpStatus.json().serverAvailability.components.mcp.state).toBe('degraded');

    const state = await server.fastify.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${AUTH_TOKEN}` } });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toEqual(expect.objectContaining({ runtime: expect.any(Object), cardIndex: expect.any(Object), serverAvailability: expect.any(Object) }));
  });
});
