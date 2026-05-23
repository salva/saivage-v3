import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type ServerInstance } from '../../src/server/server.js';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { initRuntimeState } from '../../src/runtime/state.js';
import { parseOperatorResponse } from '../../src/contracts/operator-api.js';

let root: string;
let server: ServerInstance;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'saivage-contract-routes-'));
  initProjectTree(root);
  initRuntimeState(root);
  server = await createServer(root, false);
});

afterEach(async () => {
  await server.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('first-batch contract-bound runtime/card routes', () => {
  it('pause and resume return RuntimeState bodies parsed by the shared contract', async () => {
    const pause = await server.fastify.inject({ method: 'POST', url: '/api/runtime/pause' });
    expect(pause.statusCode).toBe(200);
    expect(parseOperatorResponse('runtime.pause', pause.json()).paused).toBe(true);

    const resume = await server.fastify.inject({ method: 'POST', url: '/api/runtime/resume' });
    expect(resume.statusCode).toBe(200);
    expect(parseOperatorResponse('runtime.resume', resume.json()).paused).toBe(false);
  });

  it('validates card create/update request bodies before mutation', async () => {
    const badCreate = await server.fastify.inject({ method: 'POST', url: '/api/cards', payload: { title: 'bad', priority: 101 } });
    expect(badCreate.statusCode).toBe(400);
    expect(badCreate.json()).toEqual(expect.objectContaining({ error: 'Card creation failed', message: 'priority must be an integer from 0 to 100' }));

    const create = await server.fastify.inject({ method: 'POST', url: '/api/cards', payload: { type: 'goal', parent: 'project', title: 'goal', description: 'd' } });
    expect(create.statusCode).toBe(201);
    const created = parseOperatorResponse('cards.create', create.json()).card;

    const badUpdate = await server.fastify.inject({ method: 'PATCH', url: `/api/cards/${created.id}`, payload: { priority: -1 } });
    expect(badUpdate.statusCode).toBe(400);
    expect(badUpdate.json().error).toBe('Request validation failed');

    const update = await server.fastify.inject({ method: 'PATCH', url: `/api/cards/${created.id}`, payload: { priority: 42 } });
    expect(update.statusCode).toBe(200);
    const updated = parseOperatorResponse('cards.update', update.json()).card;
    expect(updated.priority).toBe(42);
    expect(updated.allowedActions).toContain('card.start');

    const fail = await server.fastify.inject({ method: 'PATCH', url: `/api/cards/${created.id}`, payload: { status: 'failed' } });
    expect(fail.statusCode).toBe(200);
    expect(parseOperatorResponse('cards.update', fail.json()).card.allowedActions).toContain('card.restart');
  });
});
