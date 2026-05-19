import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree, writeFileAtomic } from '../../src/utils/file-tree.js';
import {
  initRuntimeState,
  legacyRuntimeStatePath,
  runtimeStatePath,
} from '../../src/utils/runtime-state.js';
import { createServer, type ServerInstance } from '../../src/server/server.js';
import type { RuntimeState } from '../../src/schemas/types.js';

let root: string;
let server: ServerInstance | null;

function authoritativePath(): string {
  return runtimeStatePath(root);
}

function legacyPath(): string {
  return legacyRuntimeStatePath(root);
}

function migratedLegacyPath(): string {
  return join(root, '.saivage', 'runtime', 'state.json.migrated');
}

function readAuthoritative(): RuntimeState {
  return JSON.parse(readFileSync(authoritativePath(), 'utf-8')) as RuntimeState;
}

function syntheticRuntimeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  const now = new Date().toISOString();
  return {
    status: 'paused',
    project_id: 'project',
    pid: 4242,
    started_at: now,
    current_card_id: null,
    current_agent_session_id: null,
    active_card_run: null,
    paused: true,
    paused_at: now,
    queue: ['legacy-card'],
    running_processes: [],
    updated_at: now,
    frozen_reason: null,
    ...overrides,
  };
}

async function startServer(): Promise<ServerInstance> {
  server = await createServer(root, false);
  return server;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-runtime-layout-api-'));
  initProjectTree(root);
  server = null;
});

afterEach(async () => {
  if (server) await server.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('runtime-state layout startup/API guard', () => {
  it('migrates legacy-only runtime state through /api/state and keeps pause/resume on the authoritative file', async () => {
    const legacy = syntheticRuntimeState({ status: 'paused', paused: true, queue: ['legacy-card'] });
    writeFileAtomic(legacyPath(), JSON.stringify(legacy, null, 2) + '\n');
    expect(existsSync(authoritativePath())).toBe(false);

    const app = await startServer();
    const stateResponse = await app.fastify.inject({ method: 'GET', url: '/api/state' });
    expect(stateResponse.statusCode).toBe(200);
    expect(stateResponse.json().runtime).toMatchObject({
      status: 'paused',
      paused: true,
      queue: ['legacy-card'],
    });
    expect(existsSync(authoritativePath())).toBe(true);
    expect(existsSync(legacyPath())).toBe(false);
    expect(existsSync(migratedLegacyPath())).toBe(true);
    expect(readAuthoritative()).toMatchObject({ status: 'paused', paused: true, queue: ['legacy-card'] });

    const pauseResponse = await app.fastify.inject({
      method: 'POST',
      url: '/api/runtime/pause',
      headers: { 'content-type': 'application/json' },
    });
    expect(pauseResponse.statusCode).toBe(200);
    expect(pauseResponse.json()).toMatchObject({ status: 'paused', paused: true });
    expect(readAuthoritative()).toMatchObject({ status: 'paused', paused: true, queue: ['legacy-card'] });
    expect(existsSync(legacyPath())).toBe(false);

    const resumeResponse = await app.fastify.inject({
      method: 'POST',
      url: '/api/runtime/resume',
      headers: { 'content-type': 'application/json' },
    });
    expect(resumeResponse.statusCode).toBe(200);
    expect(resumeResponse.json()).toMatchObject({ status: 'idle', paused: false, paused_at: null });
    expect(readAuthoritative()).toMatchObject({ status: 'idle', paused: false, paused_at: null, queue: ['legacy-card'] });
    expect(existsSync(legacyPath())).toBe(false);
  });

  it('refuses mixed old/new runtime-state layouts through state and control API without choosing either file', async () => {
    const authoritative = initRuntimeState(root);
    const legacy = syntheticRuntimeState({ status: 'paused', paused: true, queue: ['legacy-only'] });
    writeFileAtomic(legacyPath(), JSON.stringify(legacy, null, 2) + '\n');
    const authoritativeBefore = readAuthoritative();

    const app = await startServer();
    const stateResponse = await app.fastify.inject({ method: 'GET', url: '/api/state' });
    expect(stateResponse.statusCode).toBe(500);
    expect(stateResponse.json()).toMatchObject({
      error: 'RuntimeStateLayoutError',
      message: expect.stringContaining('split-brain state files'),
    });

    const pauseResponse = await app.fastify.inject({ method: 'POST', url: '/api/runtime/pause' });
    expect(pauseResponse.statusCode).toBe(500);
    expect(pauseResponse.json()).toMatchObject({
      error: 'RuntimeStateLayoutError',
      message: expect.stringContaining('both authoritative'),
    });

    const resumeResponse = await app.fastify.inject({ method: 'POST', url: '/api/runtime/resume' });
    expect(resumeResponse.statusCode).toBe(500);
    expect(resumeResponse.json()).toMatchObject({
      error: 'RuntimeStateLayoutError',
      message: expect.stringContaining('both authoritative'),
    });

    expect(readAuthoritative()).toEqual(authoritativeBefore);
    expect(readAuthoritative()).toMatchObject({ status: authoritative.status, paused: authoritative.paused });
    expect(existsSync(legacyPath())).toBe(true);
  });
});
