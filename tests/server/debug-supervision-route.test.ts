import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { registerInternalDebugRoutes } from '../../src/server/routes/chats-files-debug.js';
import { quarantineContent, recordContentPass } from '../../src/workspace/quarantine.js';

let root: string;
let app: FastifyInstance;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-debug-supervision-route-'));
  initProjectTree(root);
  app = Fastify();
  registerInternalDebugRoutes(app, root, new CardStore(root));
});

afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/debug/supervision', () => {
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
