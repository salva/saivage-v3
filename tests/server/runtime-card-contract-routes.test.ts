import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type ServerInstance } from '../../src/server/server.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
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
    expect(badCreate.json()).toEqual(expect.objectContaining({ error: 'ValidationError' }));

    const create = await server.fastify.inject({ method: 'POST', url: '/api/cards', payload: { type: 'goal', parent: 'project', title: 'goal', description: 'd' } });
    expect(create.statusCode).toBe(201);
    const created = parseOperatorResponse('cards.create', create.json()).card;

    const badUpdate = await server.fastify.inject({ method: 'PATCH', url: `/api/cards/${created.id}`, payload: { priority: -1 } });
    expect(badUpdate.statusCode).toBe(400);
    expect(badUpdate.json().error).toBe('ValidationError');

    const update = await server.fastify.inject({ method: 'PATCH', url: `/api/cards/${created.id}`, payload: { priority: 42 } });
    expect(update.statusCode).toBe(200);
    const updated = parseOperatorResponse('cards.update', update.json()).card;
    expect(updated.priority).toBe(42);
    expect(updated.allowedActions).toContain('card.start');

    const fail = await server.fastify.inject({ method: 'PATCH', url: `/api/cards/${created.id}`, payload: { status: 'failed' } });
    expect(fail.statusCode).toBe(200);
    expect(parseOperatorResponse('cards.update', fail.json()).card.allowedActions).toContain('card.restart');
  });

  it('enforces the card permission matrix before contract delete mutation', async () => {
    const create = await server.fastify.inject({ method: 'POST', url: '/api/cards', payload: { type: 'goal', parent: 'project', title: 'delete-denied', description: 'd' } });
    expect(create.statusCode).toBe(201);
    const created = parseOperatorResponse('cards.create', create.json()).card;

    const activate = await server.fastify.inject({ method: 'PATCH', url: `/api/cards/${created.id}`, payload: { status: 'active' } });
    expect(activate.statusCode).toBe(200);

    const denied = await server.fastify.inject({ method: 'DELETE', url: `/api/cards/${created.id}`, payload: {} });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual(expect.objectContaining({ error: 'Forbidden', message: 'wrong_state' }));
    const cardPath = join(root, '.saivage', 'cards', 'by-id', `${created.id}.json`);
    expect(existsSync(cardPath)).toBe(true);
    expect(JSON.parse(readFileSync(cardPath, 'utf-8')).status).toBe('active');

    const auditPath = join(root, '.saivage', 'runtime', 'control-actions.jsonl');
    const auditLines = existsSync(auditPath) ? readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
    expect(auditLines.some((line) => line.action === 'card.delete' && line.target_id === created.id)).toBe(false);
  });

  it('allows matrix-permitted contract delete and records the mutation audit', async () => {
    const create = await server.fastify.inject({ method: 'POST', url: '/api/cards', payload: { type: 'goal', parent: 'project', title: 'delete-allowed', description: 'd' } });
    expect(create.statusCode).toBe(201);
    const created = parseOperatorResponse('cards.create', create.json()).card;

    const deleted = await server.fastify.inject({ method: 'DELETE', url: `/api/cards/${created.id}`, payload: {} });
    expect(deleted.statusCode).toBe(204);
    expect(existsSync(join(root, '.saivage', 'cards', 'by-id', `${created.id}.json`))).toBe(false);

    const auditLines = readFileSync(join(root, '.saivage', 'runtime', 'control-actions.jsonl'), 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(auditLines).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'card.delete', outcome: 'ok', target_id: created.id })]));
  });
});
