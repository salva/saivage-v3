import { expect, test } from '@playwright/test';

/**
 * Live read-only coverage for the contract endpoints not exercised by the
 * primary or extra specs. Asserts the response shape that the web client
 * actually depends on for each endpoint.
 */

test.describe('saivage-v3 live deployment — additional endpoint coverage', () => {
  test('GET /api/state returns the runtime/project envelope', async ({ request }) => {
    const res = await request.get('/api/state');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.projectRoot).toBe('/work/getrich-v2');
    expect(body.projectId).toBe('getrich-v2');
    expect(typeof body.runtime).toBe('object');
    expect(typeof body.runtime.status).toBe('string');
  });

  test('GET /api/events returns a chronologically-keyed event list', async ({ request }) => {
    const res = await request.get('/api/events');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
    if (body.events.length > 0) {
      const ev = body.events[0];
      expect(typeof ev.id).toBe('string');
      expect(typeof ev.kind).toBe('string');
      expect(typeof ev.timestamp).toBe('string');
    }
  });

  test('GET /api/processes returns a processes array', async ({ request }) => {
    const res = await request.get('/api/processes');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.processes)).toBe(true);
  });

  test('GET /api/mcp/status returns servers and serverAvailability', async ({ request }) => {
    const res = await request.get('/api/mcp/status');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.servers)).toBe(true);
    expect(typeof body.serverAvailability).toBe('object');
    expect(typeof body.serverAvailability.components).toBe('object');
  });

  test('GET /api/mcp/tools returns a non-empty tool list with descriptors', async ({ request }) => {
    const res = await request.get('/api/mcp/tools');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    const t = body.tools[0];
    expect(typeof t.name).toBe('string');
    expect(typeof t.inputSchema).toBe('object');
  });

  test('GET /api/control-actions returns the control-actions audit list', async ({ request }) => {
    const res = await request.get('/api/control-actions');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.control_actions)).toBe(true);
  });

  test('GET /api/debug/errors returns the error buffer with total', async ({ request }) => {
    const res = await request.get('/api/debug/errors');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.errors)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  test('GET /api/debug/state mirrors the runtime envelope', async ({ request }) => {
    const res = await request.get('/api/debug/state');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.runtime).toBe('object');
    expect(typeof body.runtime.status).toBe('string');
  });

  test('GET /api/debug/doctor returns a doctor report', async ({ request }) => {
    const res = await request.get('/api/debug/doctor');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  test('GET /api/debug/supervision returns a supervision snapshot', async ({ request }) => {
    const res = await request.get('/api/debug/supervision');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  test('GET /api/runtime/card-runs returns card-run plumbing snapshot', async ({ request }) => {
    const res = await request.get('/api/runtime/card-runs');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('active_card_run');
    expect(Array.isArray(body.active_breadcrumb)).toBe(true);
    expect(Array.isArray(body.dormant_planners)).toBe(true);
    expect(Array.isArray(body.cards_with_pending_corrections)).toBe(true);
  });

  test('GET /api/agents/:id returns the per-session envelope', async ({ request }) => {
    const res = await request.get('/api/agents/analyst');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.session.id).toBe('analyst');
    expect(body.session.role).toBe('analyst');
    expect(typeof body.session.message_count).toBe('number');
  });

  test('GET /api/agents/:id/conversation returns session entries', async ({ request }) => {
    const res = await request.get('/api/agents/analyst/conversation');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.session.id).toBe('analyst');
    expect(Array.isArray(body.entries)).toBe(true);
    if (body.entries.length > 0) {
      const e = body.entries[0];
      expect(typeof e.id).toBe('string');
      expect(typeof e.session_id).toBe('string');
      expect(typeof e.role).toBe('string');
    }
  });

  test('GET /api/agents/:id/llm-exchange returns the latest captured exchange', async ({ request }) => {
    const res = await request.get('/api/agents/analyst/llm-exchange');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.exchange.sessionId).toBe('analyst');
    expect(typeof body.exchange.capturedAt).toBe('string');
    expect(Array.isArray(body.exchange.attempts)).toBe(true);
  });

  test('GET /api/cards/:id returns the card envelope', async ({ request }) => {
    const res = await request.get('/api/cards/project');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.card.id).toBe('project');
    expect(body.card.type).toBe('project');
    expect(typeof body.card.version_seq).toBe('number');
  });

  test('GET /api/cards/:id/history returns the history buffer with total', async ({ request }) => {
    const res = await request.get('/api/cards/project/history');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.history)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  test('GET /api/cards/:id/diff returns the diff envelope', async ({ request }) => {
    const res = await request.get('/api/cards/project/diff');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.diff)).toBe(true);
    expect(body.card_id).toBe('project');
    expect(typeof body.from).toBe('number');
    expect(typeof body.to).toBe('number');
  });

  test('GET /api/files/content returns file content for an in-project path', async ({ request }) => {
    const res = await request.get('/api/files/content?path=pyproject.toml');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.path).toBe('pyproject.toml');
    expect(typeof body.size).toBe('number');
    expect(typeof body.content).toBe('string');
    expect(body.content).toContain('getrich-v2');
  });
});

test.describe('saivage-v3 live deployment — failure-mode coverage', () => {
  test('POST /api/chats/:id with missing content returns 400', async ({ request }) => {
    const res = await request.post('/api/chats/analyst', { data: {} });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  test('POST /api/chats/:id for a non-canonical session returns 404', async ({ request }) => {
    const res = await request.post('/api/chats/does-not-exist', { data: { content: 'hi' } });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.sessionId).toBe('does-not-exist');
  });

  test('GET /api/cards/:id for an unknown card returns 404', async ({ request }) => {
    const res = await request.get('/api/cards/this-card-does-not-exist');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.cardId).toBe('this-card-does-not-exist');
  });

  test('GET /api/agents/:id for an unknown session returns 404', async ({ request }) => {
    const res = await request.get('/api/agents/nope');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.sessionId).toBe('nope');
  });

  test('GET /api/files/content without ?path returns 400', async ({ request }) => {
    const res = await request.get('/api/files/content');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  test('GET /api/files/content with traversal path is rejected with 403', async ({ request }) => {
    const res = await request.get('/api/files/content?path=../../../etc/passwd');
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/traversal/i);
  });

  test('POST to a non-existent route returns a JSON 404', async ({ request }) => {
    const res = await request.post('/api/this-does-not-exist', { data: { x: 1 } });
    expect([404, 405]).toContain(res.status());
    const text = await res.text();
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
