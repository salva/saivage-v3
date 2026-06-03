import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type ServerInstance } from '../../src/server/server.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { initRuntimeState, runtimeStatePath } from '../../src/runtime/state.js';

let root: string;
let server: ServerInstance | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-runtime-status-pid-'));
  initProjectTree(root);
  initRuntimeState(root);
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/runtime/status pid overlay', () => {
  it('returns process.pid in the live runtime branch', async () => {
    server = await createServer(root, true);
    const res = await server.fastify.inject({ method: 'GET', url: '/api/runtime/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ pid: number }>();
    expect(typeof body.pid).toBe('number');
    expect(body.pid).toBe(process.pid);
    expect(body.pid).toBeGreaterThan(0);
  });

  it('returns process.pid in the disk-fallback branch (no live runtime)', async () => {
    server = await createServer(root, false);
    const res = await server.fastify.inject({ method: 'GET', url: '/api/runtime/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ pid: number }>();
    expect(body.pid).toBe(process.pid);
    expect(body.pid).toBeGreaterThan(0);
  });

  it('ignores stale pid persisted on disk and reports the live process.pid', async () => {
    // Write a runtime.json containing an extra pid key — the schema must
    // strip it on read, so /api/runtime/status must surface process.pid
    // and never the stale on-disk value.
    const stalePid = 99999;
    const now = new Date().toISOString();
    const payload = {
      version: 1,
      data: {
        status: 'idle',
        project_id: 'project',
        pid: stalePid,
        started_at: now,
        current_card_id: null,
        current_agent_session_id: null,
        active_card_run: null,
        paused: false,
        paused_at: null,
                updated_at: now,
        frozen_reason: null,
        runtime_intent: { status: 'stopped', updated_at: now, source_command_id: null, reason: null },
        runtime_commands: [],
        runtime_runs: [],
        runtime_activations: [],
      },
    };
    writeFileSync(runtimeStatePath(root), JSON.stringify(payload));

    server = await createServer(root, false);
    const res = await server.fastify.inject({ method: 'GET', url: '/api/runtime/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ pid: number }>();
    expect(body.pid).toBe(process.pid);
    expect(body.pid).not.toBe(stalePid);
  });
});
