/**
 * Stage 20 — Events API Endpoint Tests
 *
 * Tests for GET /api/events endpoint (and regression check for /api/debug/timeline).
 *
 * Test coverage:
 *   1.  GET /api/events returns 200 with valid auth
 *   2.  GET /api/events without auth returns 401
 *   3.  GET /api/events with invalid auth returns 401
 *   4.  Response shape: { events: [...], total: number }
 *   5.  kind filter reduces results to matching kind only
 *   6.  session_id filter reduces results to matching session
 *   7.  goal_id filter reduces results to matching goal
 *   8.  limit defaults to 50 when not specified
 *   9.  offset skips the first N events
 *   10. limit+offset together paginate correctly
 *   11. limit over 500 is capped to 500
 *   12. total counts events BEFORE offset/limit
 *   13. Total count matches the filter (without pagination)
 *   14. Multiple filters combine (kind + session_id)
 *   15. Existing GET /api/debug/timeline still works
 *   16. Empty events.jsonl returns { events: [], total: 0 }
 *   17. Filter with no matches returns { events: [], total: 0 }
 *   18. offset beyond total events returns { events: [], total: <total> }
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Helpers ───────────────────────────────────────────────────

function uniqueDir(): string {
  return join(
    tmpdir(),
    `saivage-events-api-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function setupProject(projectRoot: string, eventsJsonl: string): void {
  const sd = join(projectRoot, '.saivage');
  mkdirSync(sd, { recursive: true });
  for (const d of [
    'cards/by-id',
    'cards/tree',
    'cards/dependencies',
    'notes/by-card',
    'runtime',
    'agents/sessions',
    'agents/messages',
    'diaries',
  ]) {
    mkdirSync(join(sd, d), { recursive: true });
  }

  const config = {
    server: { port: 8080, host: '127.0.0.1' },
    models: { default: ['test-model'] },
    providers: {
      test: { priority: 10, models: ['test-model'], apiKey: 'secret-key' },
    },
  };

  writeFileSync(join(sd, 'saivage.json'), JSON.stringify(config, null, 2));

  const now = new Date().toISOString();
  writeFileSync(
    join(sd, 'cards', 'by-id', 'project.json'),
    JSON.stringify({
      id: 'project',
      type: 'project',
      parent: null,
      depth: 0,
      title: 'project',
      description: '',
      status: 'backlog',
      tags: [],
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      created_at: now,
      updated_at: now,
      depends_on: [],
      blocks: [],
      related: [],
      acceptance: '',
      artifacts: [],
      attachments: [],
      retries: 0,
    }),
  );
  writeFileSync(
    join(sd, 'cards', 'index.json'),
    JSON.stringify({
      cards: {
        project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' },
      },
    }),
  );
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ entries: [] }));

  writeFileSync(
    join(sd, 'runtime', 'state.json'),
    JSON.stringify({
      status: 'idle',
      project_id: 'project',
      pid: process.pid,
      started_at: now,
      paused: false,
      queue: [],
      running_processes: [],
      updated_at: now,
    }),
  );

  // Write the events.jsonl file
  writeFileSync(join(sd, 'runtime', 'events.jsonl'), eventsJsonl);

  // Also write an empty errors.jsonl (debug/timeline route code path may reference it)
  writeFileSync(join(sd, 'runtime', 'errors.jsonl'), '');
}

// ── Event Seed Data Helpers ───────────────────────────────────

function makeEvent(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build a diverse set of 25 events spanning multiple kinds, session_ids, and goal_ids.
 *
 * Layout:
 *   goal_a: 5 events (3 goal_completed, 1 session_started, 1 started — all sess-1)
 *   goal_b: 5 events (2 goal_completed [sess-1, sess-2], 1 card_failed [sess-2],
 *            1 review_complete [sess-2], 1 error [sess-2])
 *   goal_c: 5 events (1 goal_completed [sess-2], 2 invocation_succeeded [sess-3],
 *            1 invocation_failed [sess-3], 1 model_selected [sess-3])
 *   no goal: 10 events (3 started [sess-1, sess-2, sess-3], 2 paused, 2 resumed,
 *              2 shutdown, 1 error — no session)
 *
 * session_id counts:
 *   sess-1: 7 events (5 goal_a + 1 goal_b + 1 started no-goal)
 *   sess-2: 6 events (goal_b: goal_completed, card_failed, review_complete, error,
 *                      goal_c: goal_completed, started no-goal)
 *   sess-3: 4 events (goal_c: inv_succ ×2, inv_fail, model_selected)
 *   no session: 8 events (2 paused, 2 resumed, 2 shutdown, 1 started in goal_a goal_id, 1 error)
 *
 *   Actually recounting:
 *   - with session_id=sess-1 AND goal_id set: started(g_a), 3×goal_completed(g_a), session_started(g_a), goal_completed(g_b) = 6
 *   - with session_id=sess-1 but goal_id might NOT be set: started (no-goal) = 1
 *   So total sess-1 = 7
 */
function buildSeedEvents(): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];

  // goal_a events
  const t = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000).toISOString();
  events.push(makeEvent({ kind: 'started', session_id: 'sess-1', goal_id: 'goal_a', timestamp: t(0), project_root: '/tmp/test' }));
  events.push(makeEvent({ kind: 'goal_completed', session_id: 'sess-1', goal_id: 'goal_a', timestamp: t(1) }));
  events.push(makeEvent({ kind: 'goal_completed', session_id: 'sess-1', goal_id: 'goal_a', timestamp: t(2) }));
  events.push(makeEvent({ kind: 'goal_completed', session_id: 'sess-1', goal_id: 'goal_a', timestamp: t(3) }));
  events.push(makeEvent({ kind: 'session_started', session_id: 'sess-1', goal_id: 'goal_a', card_id: 'card-1', role: 'analyst', timestamp: t(4) }));

  // goal_b events
  events.push(makeEvent({ kind: 'goal_completed', session_id: 'sess-1', goal_id: 'goal_b', timestamp: t(5) }));
  events.push(makeEvent({ kind: 'goal_completed', session_id: 'sess-2', goal_id: 'goal_b', timestamp: t(6) }));
  events.push(makeEvent({ kind: 'card_failed', session_id: 'sess-2', goal_id: 'goal_b', card_id: 'card-2', timestamp: t(7) }));
  events.push(makeEvent({ kind: 'review_complete', session_id: 'sess-2', goal_id: 'goal_b', timestamp: t(8) }));
  events.push(makeEvent({ kind: 'error', session_id: 'sess-2', goal_id: 'goal_b', error_message: 'test error', timestamp: t(9) }));

  // goal_c events
  events.push(makeEvent({ kind: 'goal_completed', session_id: 'sess-2', goal_id: 'goal_c', timestamp: t(10) }));
  events.push(makeEvent({ kind: 'invocation_succeeded', session_id: 'sess-3', goal_id: 'goal_c', role: 'executor', attempt: 1, duration_ms: 100, timestamp: t(11) }));
  events.push(makeEvent({ kind: 'invocation_failed', session_id: 'sess-3', goal_id: 'goal_c', role: 'executor', attempt: 1, error_message: 'fail', timestamp: t(12) }));
  events.push(makeEvent({ kind: 'invocation_succeeded', session_id: 'sess-3', goal_id: 'goal_c', role: 'executor', attempt: 2, duration_ms: 200, timestamp: t(13) }));
  events.push(makeEvent({ kind: 'model_selected', session_id: 'sess-3', goal_id: 'goal_c', provider: 'test', model: 'm1', role: 'analyst', timestamp: t(14) }));

  // no goal events (no goal_id field at all)
  events.push(makeEvent({ kind: 'started', session_id: 'sess-1', project_root: '/tmp/test', timestamp: t(15) }));
  events.push(makeEvent({ kind: 'started', session_id: 'sess-2', project_root: '/tmp/test', timestamp: t(16) }));
  events.push(makeEvent({ kind: 'started', session_id: 'sess-3', project_root: '/tmp/test', timestamp: t(17) }));
  events.push(makeEvent({ kind: 'paused', timestamp: t(18) }));
  events.push(makeEvent({ kind: 'paused', timestamp: t(19) }));
  events.push(makeEvent({ kind: 'resumed', timestamp: t(20) }));
  events.push(makeEvent({ kind: 'resumed', timestamp: t(21) }));
  events.push(makeEvent({ kind: 'shutdown', timestamp: t(22) }));
  events.push(makeEvent({ kind: 'shutdown', timestamp: t(23) }));
  events.push(makeEvent({ kind: 'error', error_message: 'global error', timestamp: t(24) }));

  return events;
}

function eventsToJsonl(events: Record<string, unknown>[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

// ── Shared type for JSON response bodies ─────────────────────

type EventResponse = { events: Array<Record<string, unknown>>; total: number };

// ═══════════════════════════════════════════════════════════════
// Events API Tests
// ═══════════════════════════════════════════════════════════════

describe('Events API', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;
  let seedEvents: Record<string, unknown>[];

  beforeAll(async () => {
    projectRoot = uniqueDir();
    seedEvents = buildSeedEvents();
    const jsonl = eventsToJsonl(seedEvents);
    setupProject(projectRoot, jsonl);

    authToken = process.env['SAIVAGE_API_TOKEN'] || 'test-token';
    process.env['SAIVAGE_API_TOKEN'] = authToken;

    app = Fastify({ logger: false });
    await app.register(cors);
    await app.register(websocket);

    // Register auth plugin
    const { default: authPlugin } = await import('../../src/server/auth.js');
    await app.register(authPlugin);

    // Register the events route
    const { registerEventsRoute } = await import('../../src/server/routes/events.js');
    registerEventsRoute(app, projectRoot);

    // Register chats-files-debug routes (for debug/timeline regression)
    const { registerChatsFilesDebugRoutes } = await import('../../src/server/routes/chats-files-debug.js');
    registerChatsFilesDebugRoutes(app, projectRoot);

    // Health endpoint
    app.get('/health', async (_req, reply) => {
      return reply.send({ status: 'ok', version: '0.1.0', project: 'test', runtime: 'idle' });
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }, 10000);

  // ── Helpers ───────────────────────────────────────────────

  function apiUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  function authHdr(): Record<string, string> {
    return { authorization: `Bearer ${authToken}` };
  }

  // ══════════════════════════════════════════════════════════
  // Auth
  // ══════════════════════════════════════════════════════════

  describe('Auth', () => {
    it('GET /api/events returns 200 with valid auth', async () => {
      const res = await fetch(apiUrl('/api/events'), { headers: authHdr() });
      expect(res.status).toBe(200);
    });

    it('GET /api/events without auth returns 401', async () => {
      const res = await fetch(apiUrl('/api/events'));
      expect(res.status).toBe(401);
    });

    it('GET /api/events with invalid auth returns 401', async () => {
      const res = await fetch(apiUrl('/api/events'), {
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  // ══════════════════════════════════════════════════════════
  // Basic Response
  // ══════════════════════════════════════════════════════════

  describe('Basic response', () => {
    it('Response shape: { events: [...], total: number }', async () => {
      const res = await fetch(apiUrl('/api/events'), { headers: authHdr() });
      expect(res.status).toBe(200);

      const body = (await res.json()) as EventResponse;
      expect(body).toHaveProperty('events');
      expect(body).toHaveProperty('total');
      expect(Array.isArray(body.events)).toBe(true);
      expect(typeof body.total).toBe('number');
      expect(body.total).toBeGreaterThan(0);
    });

    it('No parameters returns all events up to default limit (50)', async () => {
      const res = await fetch(apiUrl('/api/events'), { headers: authHdr() });
      expect(res.status).toBe(200);

      const body = (await res.json()) as EventResponse;
      // We have 25 events, all should fit within default limit 50
      expect(body.total).toBe(25);
      expect(body.events.length).toBe(25);
    });

    it('Each event has id, kind, timestamp fields', async () => {
      const res = await fetch(apiUrl('/api/events'), { headers: authHdr() });
      const body = (await res.json()) as EventResponse;

      for (const event of body.events) {
        expect(event).toHaveProperty('id');
        expect(event).toHaveProperty('kind');
        expect(event).toHaveProperty('timestamp');
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  // Filtering
  // ══════════════════════════════════════════════════════════

  describe('Filtering', () => {
    it('kind filter reduces results to matching kind only', async () => {
      const res = await fetch(apiUrl('/api/events?kind=goal_completed'), {
        headers: authHdr(),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as EventResponse;

      // We seeded 3 + 2 + 1 = 6 goal_completed events
      expect(body.total).toBe(6);
      for (const event of body.events) {
        expect(event.kind).toBe('goal_completed');
      }
    });

    it('kind filter works for error events', async () => {
      const res = await fetch(apiUrl('/api/events?kind=error'), {
        headers: authHdr(),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as EventResponse;

      // 1 error in goal_b + 1 global error = 2
      expect(body.total).toBe(2);
      for (const event of body.events) {
        expect(event.kind).toBe('error');
      }
    });

    it('session_id filter reduces results to matching session', async () => {
      const res = await fetch(apiUrl('/api/events?session_id=sess-1'), {
        headers: authHdr(),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as EventResponse;

      // sess-1: 5 goal_a + 1 goal_b + 1 started (no-goal) = 7
      expect(body.total).toBe(7);
      for (const event of body.events) {
        expect(event.session_id).toBe('sess-1');
      }
    });

    it('goal_id filter reduces results to matching goal', async () => {
      const res = await fetch(apiUrl('/api/events?goal_id=goal_a'), {
        headers: authHdr(),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as EventResponse;

      // goal_a: 5 events
      expect(body.total).toBe(5);
      for (const event of body.events) {
        expect(event.goal_id).toBe('goal_a');
      }
    });

    it('Multiple filters combine (kind + session_id)', async () => {
      const res = await fetch(
        apiUrl('/api/events?kind=goal_completed&session_id=sess-1'),
        { headers: authHdr() },
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as EventResponse;

      // sess-1 goal_completed: 3 in goal_a + 1 in goal_b = 4
      expect(body.total).toBe(4);
      for (const event of body.events) {
        expect(event.kind).toBe('goal_completed');
        expect(event.session_id).toBe('sess-1');
      }
    });

    it('Filter with no matches returns { events: [], total: 0 }', async () => {
      const res = await fetch(apiUrl('/api/events?kind=nonexistent_kind'), {
        headers: authHdr(),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as EventResponse;
      expect(body.events).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════
  // Pagination
  // ══════════════════════════════════════════════════════════

  describe('Pagination', () => {
    it('limit defaults to 50 when not specified', async () => {
      // We have 25 events, all should be returned
      const res = await fetch(apiUrl('/api/events'), { headers: authHdr() });
      expect(res.status).toBe(200);

      const body = (await res.json()) as EventResponse;
      expect(body.total).toBe(25);
      expect(body.events.length).toBe(25);
    });

    it('limit parameter restricts the number of events returned', async () => {
      const res = await fetch(apiUrl('/api/events?limit=5'), {
        headers: authHdr(),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as EventResponse;
      expect(body.total).toBe(25); // total counts ALL matching events
      expect(body.events.length).toBe(5); // but limit restricts returned
    });

    it('offset skips the first N events', async () => {
      // Get first 5 events (no offset)
      const res1 = await fetch(apiUrl('/api/events?limit=5&offset=0'), {
        headers: authHdr(),
      });
      const body1 = (await res1.json()) as EventResponse;

      // Get events with offset=5
      const res2 = await fetch(apiUrl('/api/events?limit=5&offset=5'), {
        headers: authHdr(),
      });
      const body2 = (await res2.json()) as EventResponse;

      // The first event of the offset page should be the 6th event (index 5)
      // and should not equal the first event of the non-offset page
      expect(body1.events[0].id).not.toBe(body2.events[0].id);
      expect(body1.total).toBe(body2.total); // total stays same
    });

    it('limit+offset together paginate correctly', async () => {
      // Page 1: first 3
      const res1 = await fetch(apiUrl('/api/events?limit=3&offset=0'), {
        headers: authHdr(),
      });
      const body1 = (await res1.json()) as EventResponse;

      // Page 2: next 3
      const res2 = await fetch(apiUrl('/api/events?limit=3&offset=3'), {
        headers: authHdr(),
      });
      const body2 = (await res2.json()) as EventResponse;

      expect(body1.events.length).toBe(3);
      expect(body2.events.length).toBe(3);
      expect(body1.total).toBe(25);
      expect(body2.total).toBe(25);

      // Pages should not overlap
      const ids1 = new Set(body1.events.map((e) => e.id as string));
      for (const e of body2.events) {
        expect(ids1.has(e.id as string)).toBe(false);
      }
    });

    it('limit over 500 is capped to 500', async () => {
      // We only have 25 events, but the limit cap should still apply.
      // When limit=1000, it gets capped to 500, which is more than our 25 events,
      // so all 25 events are returned.
      const res = await fetch(apiUrl('/api/events?limit=1000'), {
        headers: authHdr(),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as EventResponse;
      // All 25 events should be returned since 500 > 25
      expect(body.total).toBe(25);
      expect(body.events.length).toBe(25);
    });

    it('total counts events BEFORE offset/limit (so total > events.length when paginating)', async () => {
      const res = await fetch(apiUrl('/api/events?limit=3&offset=0'), {
        headers: authHdr(),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as EventResponse;
      expect(body.total).toBe(25);
      expect(body.events.length).toBe(3);
      expect(body.total).toBeGreaterThan(body.events.length);
    });

    it('offset beyond total events returns { events: [], total: <total> }', async () => {
      const res = await fetch(apiUrl('/api/events?offset=1000'), {
        headers: authHdr(),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as EventResponse;
      expect(body.events).toEqual([]);
      expect(body.total).toBe(25);
    });
  });

  // ══════════════════════════════════════════════════════════
  // Edge Cases
  // ══════════════════════════════════════════════════════════

  describe('Edge cases', () => {
    it('Total count matches the filter (without pagination)', async () => {
      // kind=started: 4 events (1 in goal_a session, 3 in no-goal sessions)
      const res = await fetch(apiUrl('/api/events?kind=started'), {
        headers: authHdr(),
      });
      const body = (await res.json()) as EventResponse;

      expect(body.total).toBe(4);
      expect(body.events.length).toBe(4);
      for (const event of body.events) {
        expect(event.kind).toBe('started');
      }
    });

    it('Events are returned in file order (chronological, oldest first)', async () => {
      const res = await fetch(apiUrl('/api/events'), { headers: authHdr() });
      const body = (await res.json()) as EventResponse;

      // Verify timestamps are non-decreasing
      const timestamps = body.events.map((e) => e.timestamp as string);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i] >= timestamps[i - 1]).toBe(true);
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  // Regression: Debug Timeline
  // ══════════════════════════════════════════════════════════

  describe('Regression: Debug Timeline', () => {
    it('Existing GET /api/debug/timeline still works and returns the same events', async () => {
      const res = await fetch(apiUrl('/api/debug/timeline'), { headers: authHdr() });
      expect(res.status).toBe(200);

      const body = (await res.json()) as EventResponse;
      expect(body).toHaveProperty('events');
      expect(body).toHaveProperty('total');
      expect(Array.isArray(body.events)).toBe(true);
      // All 25 events should be returned (debug/timeline has no pagination)
      expect(body.total).toBe(25);
      expect(body.events.length).toBe(25);
    });

    it('GET /api/debug/timeline without auth returns 401', async () => {
      const res = await fetch(apiUrl('/api/debug/timeline'));
      expect(res.status).toBe(401);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Empty Events Log Tests
// ═══════════════════════════════════════════════════════════════

describe('Events API — Empty log', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot, ''); // empty events.jsonl

    authToken = process.env['SAIVAGE_API_TOKEN'] || 'test-token-empty';
    process.env['SAIVAGE_API_TOKEN'] = authToken;

    app = Fastify({ logger: false });
    await app.register(cors);
    await app.register(websocket);

    const { default: authPlugin } = await import('../../src/server/auth.js');
    await app.register(authPlugin);

    const { registerEventsRoute } = await import('../../src/server/routes/events.js');
    registerEventsRoute(app, projectRoot);

    app.get('/health', async (_req, reply) => {
      return reply.send({ status: 'ok' });
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }, 10000);

  function apiUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  function authHdr(): Record<string, string> {
    return { authorization: `Bearer ${authToken}` };
  }

  it('Empty events.jsonl returns { events: [], total: 0 }', async () => {
    const res = await fetch(apiUrl('/api/events'), { headers: authHdr() });
    expect(res.status).toBe(200);

    const body = (await res.json()) as EventResponse;
    expect(body.events).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('Kind filter on empty log returns { events: [], total: 0 }', async () => {
    const res = await fetch(apiUrl('/api/events?kind=goal_completed'), {
      headers: authHdr(),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as EventResponse;
    expect(body.events).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('Pagination on empty log returns { events: [], total: 0 }', async () => {
    const res = await fetch(apiUrl('/api/events?limit=10&offset=5'), {
      headers: authHdr(),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as EventResponse;
    expect(body.events).toEqual([]);
    expect(body.total).toBe(0);
  });
});

describe('Events API process reconciliation audit visibility', () => {
  it('exposes process reconciliation audit events through the existing kind filter without leaking secrets', async () => {
    const projectRoot = uniqueDir();
    const secret = 'sk-live-events-api-secret';
    setupProject(projectRoot, eventsToJsonl([
      makeEvent({
        kind: 'process_reconciled_dead',
        process_id: 'proc-api-dead',
        card_id: 'card-api',
        goal_id: 'goal-api',
        session_id: 'sess-api',
        pid: 123,
        probe_status: 'not_running',
        terminal_reason: 'lost',
        failure_classification: 'lost',
        detail: 'restart identity probe mismatch sk-[REDACTED]',
      }),
      makeEvent({ kind: 'goal_completed', goal_id: 'goal-api' }),
    ]));
    const token = 'test-token-process-events';
    process.env['SAIVAGE_API_TOKEN'] = token;
    const app = Fastify({ logger: false });
    await app.register(cors);
    await app.register(websocket);
    const { default: authPlugin } = await import('../../src/server/auth.js');
    await app.register(authPlugin);
    const { registerEventsRoute } = await import('../../src/server/routes/events.js');
    registerEventsRoute(app, projectRoot);
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const port = (app.server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/events?kind=process_reconciled_dead`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as EventResponse;
      expect(body.total).toBe(1);
      expect(body.events).toEqual([expect.objectContaining({ kind: 'process_reconciled_dead', process_id: 'proc-api-dead', card_id: 'card-api' })]);
      expect(JSON.stringify(body)).not.toContain(secret);
    } finally {
      await app.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
