import { expect, test } from '@playwright/test';
import WebSocket from 'ws';

const analystSessionId = 'agent:analyst:global';
const analystSessionPath = encodeURIComponent(analystSessionId);
const analystChatPath = '/api/chat';

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

  test('GET /api/mcp/tools returns a non-empty narrowed tool list', async ({ request }) => {
    const res = await request.get('/api/mcp/tools');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    const t = body.tools[0];
    expect(typeof t.name).toBe('string');
    expect(Object.keys(t)).toEqual(['name']);
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

  test('GET /api/debug/doctor returns a doctor report', async ({ request }) => {
    const res = await request.get('/api/debug/doctor');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  test('GET /api/runtime/card-runs returns card-run plumbing snapshot', async ({ request }) => {
    const res = await request.get('/api/runtime/card-runs');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('current_card_id');
    expect(Array.isArray(body.active_breadcrumb)).toBe(true);
    expect(Array.isArray(body.dormant_agents)).toBe(true);
    expect(body).not.toHaveProperty('cards_with_pending_corrections');
  });

  test('GET /api/agents/:id returns the per-session envelope', async ({ request }) => {
    const res = await request.get(`/api/agents/${analystSessionPath}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.session.id).toBe(analystSessionId);
    expect(body.session.agent_name).toBe('analyst');
    expect(body.session.session_scope).toBe('global');
    expect(typeof body.session.message_count).toBe('number');
  });

  test('GET /api/agents/:id/conversation returns session entries', async ({ request }) => {
    const res = await request.get(`/api/agents/${analystSessionPath}/conversation`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.session.id).toBe(analystSessionId);
    expect(Array.isArray(body.entries)).toBe(true);
    if (body.entries.length > 0) {
      const e = body.entries[0];
      expect(typeof e.id).toBe('string');
      expect(typeof e.session_id).toBe('string');
      expect(typeof e.role).toBe('string');
    }
  });

  test('GET /api/agents/:id/llm-exchange returns the latest captured exchange', async ({ request }) => {
    const res = await request.get(`/api/agents/${analystSessionPath}/llm-exchange`);
    if (res.status() === 404) {
      const body = await res.json();
      expect(body.error).toContain('No LLM exchange recorded');
      return;
    }
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.exchange.sessionId).toBe(analystSessionId);
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
    expect(body).not.toHaveProperty('children');
  });

  test('GET /api/cards/project/children returns the bounded root slice', async ({ request }) => {
    const res = await request.get('/api/cards/project/children');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.card.id).toBe('project');
    expect(Array.isArray(body.children)).toBe(true);
    expect(body.children.every((child: { parent: string }) => child.parent === 'project')).toBe(true);
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
    const res = await request.get('/api/files/content?path=docs/SPEC.md');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.path).toBe('docs/SPEC.md');
    expect(typeof body.size).toBe('number');
    expect(typeof body.content).toBe('string');
    expect(body.content).toContain('GetRich v2');
  });
});

test.describe('saivage-v3 live deployment — failure-mode coverage', () => {
  test('POST /api/chat with missing content returns 400', async ({ request }) => {
    const res = await request.post(analystChatPath, { data: {} });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  test('removed session-addressed chat route is not accepted', async ({ request }) => {
    const res = await request.post('/api/chats/does-not-exist', { data: { content: 'hi' } });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  test('GET /api/cards/:id for an unknown card returns 404', async ({ request }) => {
    const res = await request.get('/api/cards/card-zzzzzz');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body).toEqual({ error: 'Card not found', cardId: 'card-zzzzzz' });
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

  test('POST /api/chat with non-string content returns 400 ValidationError', async ({ request }) => {
    const res = await request.post(analystChatPath, { data: { content: 12345 } });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('ValidationError');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.some((i: { path: string }) => i.path === 'content')).toBe(true);
  });

  test('GET /api/files/content on a directory returns 400', async ({ request }) => {
    const res = await request.get('/api/files/content?path=.saivage');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/directory/i);
    expect(body.path).toBe('.saivage');
  });

  test('GET /api/files/content for a nonexistent file returns 404', async ({ request }) => {
    const res = await request.get('/api/files/content?path=no-such-file.txt');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
    expect(body.path).toBe('no-such-file.txt');
  });

  test('GET /api/cards/:id/history/:seq for an unknown seq returns 404', async ({ request }) => {
    const res = await request.get('/api/cards/project/history/999999');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/history entry not found/i);
    expect(body.cardId).toBe('project');
    expect(body.version_seq).toBe(999999);
  });

  test('PUT on a GET-only route returns API-route-not-found 404', async ({ request }) => {
    const res = await request.put('/api/cards/project/children', { data: {} });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/route not found/i);
  });

  test('POST on a GET-only /api/control-actions returns 404', async ({ request }) => {
    const res = await request.post('/api/control-actions', { data: {} });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/route not found/i);
  });

  test('POST /api/auth/ws-ticket issues a WS ticket with an expiry', async ({ request }) => {
    const res = await request.post('/api/auth/ws-ticket');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.ticket).toBe('string');
    expect(body.ticket).toMatch(/^wst_/);
    expect(typeof body.expiresAt).toBe('string');
    expect(Number.isFinite(Date.parse(body.expiresAt))).toBe(true);
  });

  test('WS /ws delivers a connected envelope on open', async ({ baseURL }) => {
    const wsURL = (baseURL ?? 'http://10.0.3.170:8080').replace(/^http/i, 'ws') + '/ws';
    const ws = new WebSocket(wsURL);
    const frames: unknown[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS open timeout')), 10_000);
        ws.once('open', () => { clearTimeout(timer); resolve(); });
        ws.once('error', (err) => { clearTimeout(timer); reject(err); });
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`WS did not deliver connected frame; got ${frames.length}`)), 10_000);
        ws.on('message', (raw: Buffer) => {
          try { frames.push(JSON.parse(raw.toString('utf-8'))); } catch { /* keep raw */ }
          if (frames.some((f) => (f as { type?: string; content?: { event?: string } }).content?.event === 'connected')) { clearTimeout(timer); resolve(); }
        });
      });
    } finally {
      ws.close();
    }
    const events = frames.map((f) => (f as { type?: string; content?: { event?: string } }).content?.event);
    expect(events).toContain('connected');
  });

  test('POST /api/chat with malformed JSON body returns a clean 400', async ({ request }) => {
    const res = await request.post(analystChatPath, {
      headers: { 'content-type': 'application/json' },
      data: 'not-json',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(typeof body).toBe('object');
    expect(body).not.toBeNull();
    expect(typeof (body.error ?? body.message)).toBe('string');
  });

  test('chats.send round-trip with two messages preserves both in chats.get', async ({ request }) => {
    const before = await request.get(analystChatPath);
    expect(before.status()).toBe(200);
    const beforeCount = (await before.json()).entries.length;

    const marker = `live-e2e-multi-${Date.now()}`;
    for (const suffix of ['a', 'b']) {
      const res = await request.post(analystChatPath, {
        data: { content: `${marker}-${suffix}`, workspaceContext: { view: 'dashboard', entityId: null, refinement: null } },
        timeout: 120_000,
      });
      expect(res.status(), `POST ${suffix} — body=${await res.text().catch(() => '<unreadable>')}`).toBe(200);
    }

    const after = await request.get(analystChatPath);
    expect(after.status()).toBe(200);
    const afterBody = await after.json();
    expect(afterBody.entries.length).toBeGreaterThanOrEqual(beforeCount + 2);
    const texts: string[] = afterBody.entries.map((e: { content?: string; text?: string }) => e.content ?? e.text ?? '');
    expect(texts.some((t) => t.includes(`${marker}-a`))).toBe(true);
    expect(texts.some((t) => t.includes(`${marker}-b`))).toBe(true);
  });

  test('GET /api/cards/project/children returns immediate descriptors without a global inventory', async ({ request }) => {
    const res = await request.get('/api/cards/project/children');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.card.id).toBe('project');
    expect(Array.isArray(body.children)).toBe(true);
    for (const card of body.children) {
      expect(typeof card.id).toBe('string');
      expect(typeof card.type).toBe('string');
      expect(typeof card.version_seq).toBe('number');
    }
    expect(body).not.toHaveProperty('total');
  });

  test('GET /api/state exposes minimal runtime state without runtime ledgers', async ({ request }) => {
    const res = await request.get('/api/state');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.runtime).toBe('object');
    expect(body).not.toHaveProperty('cardIndex');
    expect(body.runtime).not.toHaveProperty('runtime_runs');
    expect(body.runtime).not.toHaveProperty('runtime_activations');
    expect(body.runtime).not.toHaveProperty('runtime_commands');
    expect(typeof body.serverAvailability).toBe('object');
    expect(typeof body.serverAvailability.components).toBe('object');
  });

  test('GET /api/files lists the project root with name/path/type descriptors', async ({ request }) => {
    const res = await request.get('/api/files');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.path).toBe('string');
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files.length).toBeGreaterThan(0);
    for (const f of body.files) {
      expect(typeof f.name).toBe('string');
      expect(typeof f.path).toBe('string');
      expect(['file', 'directory']).toContain(f.type);
    }
  });

  test('GET /api/files with a traversal path is rejected with 403', async ({ request }) => {
    const res = await request.get('/api/files?path=../../etc');
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(typeof (body.error ?? body.message)).toBe('string');
  });

  test('GET /api/config returns the config envelope with providers/models and a warnings list', async ({ request }) => {
    const res = await request.get('/api/config');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.config).toBe('object');
    expect(typeof body.config.providers).toBe('object');
    expect(typeof body.config.models).toBe('object');
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  test('WS /ws closes cleanly after receiving an initial frame', async ({ baseURL }) => {
    const wsURL = (baseURL ?? 'http://10.0.3.170:8080').replace(/^http/i, 'ws') + '/ws';
    const ws = new WebSocket(wsURL);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS open timeout')), 10_000);
        ws.once('open', () => { clearTimeout(timer); resolve(); });
        ws.once('error', (err) => { clearTimeout(timer); reject(err); });
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS first frame timeout')), 10_000);
        ws.once('message', () => { clearTimeout(timer); resolve(); });
      });
      const closed = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS close timeout')), 10_000);
        ws.once('close', (code: number) => { clearTimeout(timer); resolve(code); });
      });
      ws.close(1000, 'test-complete');
      const code = await closed;
      expect([1000, 1005, 1006]).toContain(code);
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
  });
});
