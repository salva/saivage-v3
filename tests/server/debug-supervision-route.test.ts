import { initProjectTree, CardStore } from '../helpers/canonical-project.js';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';



import { registerInternalDebugRoutes } from '../../src/server/routes/chats-files-debug.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { quarantineContent, recordContentPass } from '../helpers/content-review.js';

let root: string;
let app: FastifyInstance;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-debug-supervision-route-'));
  initProjectTree(root);
  app = Fastify();
  registerInternalDebugRoutes(app, root, new CardStore(root).repository, new AuthPolicy());
});

afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/debug/supervision', () => {
  it('requires the injected policy before starting the runtime or reading diagnostics', async () => {
    const protectedApp = Fastify();
    const startProject = jest.fn(async () => ({ started: true }));
    registerInternalDebugRoutes(
      protectedApp,
      root,
      new CardStore(root).repository,
      new AuthPolicy({ apiToken: 'debug-test-token' }),
      { runtimeApi: { startProject } } as any,
    );
    try {
      const start = await protectedApp.inject({ method: 'POST', url: '/api/debug/runtime/start' });
      const doctor = await protectedApp.inject({ method: 'GET', url: '/api/debug/doctor?token=debug-test-token', headers: { authorization: 'Bearer debug-test-token' } });

      expect(start.statusCode).toBe(401);
      expect(doctor.statusCode).toBe(401);
      expect(startProject).not.toHaveBeenCalled();
    } finally {
      await protectedApp.close();
    }
  });

  it('derives reviews and stats from content_review app-log entries without quarantine metadata', async () => {
    recordContentPass(root, 'file', 'safe.txt', 'Clean');
    quarantineContent({
      projectRoot: root,
      sourceKind: 'web',
      sourceRef: 'https://evil.example.com/payload',
      content: 'raw blocked content that must not be stored',
      reason: 'self_labeled_injection',
      risk: 'high',
    });

    const response = await app.inject({ method: 'GET', url: '/api/debug/supervision' });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body).not.toHaveProperty('quarantine');
    expect(body.reviews).toHaveLength(2);
    expect(body.reviews[0]).toEqual(expect.objectContaining({
      source_kind: 'web',
      source_ref: 'https://evil.example.com/payload',
      status: 'blocked',
      summary: 'Blocked: self_labeled_injection',
      risk: 'high',
    }));
    expect(body.reviews[0]).not.toHaveProperty('quarantine_id');
    expect(body.stats).toEqual({
      total: 2,
      blocked: 1,
      passed: 1,
      sanitized: 0,
      byRisk: { low: 1, high: 1 },
      bySourceKind: { file: 1, web: 1 },
    });
    expect(existsSync(join(root, '.saivage', 'supervision'))).toBe(false);
    expect(existsSync(join(root, '.saivage', 'work', 'quarantine'))).toBe(false);
  });
});
