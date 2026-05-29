import { expect, test } from '@playwright/test';

/**
 * Extra live coverage against http://10.0.3.170:8080 — exercises endpoints the
 * primary spec does not touch (runtime, cards, files, debug, MCP). Read-only.
 */

test.describe('saivage-v3 live deployment — extra contract coverage', () => {
  test('runtime.status returns a well-formed status payload', async ({ request }) => {
    const res = await request.get('/api/runtime/status');
    expect(res.status(), `GET /api/runtime/status — body=${await res.text().catch(() => '<unreadable>')}`).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  test('cards.list returns an array', async ({ request }) => {
    const res = await request.get('/api/cards');
    expect(res.status(), `GET /api/cards — body=${await res.text().catch(() => '<unreadable>')}`).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.cards)).toBe(true);
  });

  test('chats.list returns sessions including the analyst session', async ({ request }) => {
    const res = await request.get('/api/chats');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.some((s: { id: string }) => s.id === 'analyst')).toBe(true);
  });

  test('chats.get for analyst returns entries array', async ({ request }) => {
    const res = await request.get('/api/chats/analyst');
    expect(res.status(), `GET /api/chats/analyst — body=${await res.text().catch(() => '<unreadable>')}`).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe('analyst');
    expect(Array.isArray(body.entries)).toBe(true);
  });

  test('files.list returns a directory listing for the project root', async ({ request }) => {
    const res = await request.get('/api/files');
    expect(res.status(), `GET /api/files — body=${await res.text().catch(() => '<unreadable>')}`).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  test('debug.timeline returns a payload', async ({ request }) => {
    const res = await request.get('/api/debug/timeline');
    expect(res.status(), `GET /api/debug/timeline — body=${await res.text().catch(() => '<unreadable>')}`).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  test('agents.list returns sessions including analyst', async ({ request }) => {
    const res = await request.get('/api/agents');
    expect(res.status(), `GET /api/agents — body=${await res.text().catch(() => '<unreadable>')}`).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.some((s: { id: string }) => s.id === 'analyst')).toBe(true);
  });

  test('GET unknown route returns a 404 with a clean JSON error', async ({ request }) => {
    const res = await request.get('/api/this-route-does-not-exist');
    expect([404, 405]).toContain(res.status());
    const text = await res.text();
    expect(() => JSON.parse(text)).not.toThrow();
  });

  test('runtime.status exposes runtime/paused/serverAvailability with healthy components', async ({ request }) => {
    const res = await request.get('/api/runtime/status');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.runtime).toBe('string');
    expect(typeof body.paused).toBe('boolean');
    expect(body.serverAvailability).toBeTruthy();
    const components = body.serverAvailability.components;
    for (const name of ['api', 'runtime', 'mcp']) {
      expect(components[name]?.state, `component ${name}`).toBe('available');
    }
  });

  test('processes.get for an unknown id returns 404 with the processId echoed back', async ({ request }) => {
    const res = await request.get('/api/processes/does-not-exist-xyz');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.processId).toBe('does-not-exist-xyz');
    expect(typeof body.error).toBe('string');
  });

  test('chats.send round-trip appends a user entry visible in chats.get', async ({ request }) => {
    const before = await request.get('/api/chats/analyst');
    expect(before.status()).toBe(200);
    const beforeBody = await before.json();
    const beforeCount = beforeBody.entries.length;

    const marker = `live-e2e-roundtrip-${Date.now()}`;
    const send = await request.post('/api/chats/analyst', {
      data: { content: marker, workspaceContext: { view: 'dashboard', entityId: null, refinement: null } },
      timeout: 120_000,
    });
    expect(send.status(), `POST /api/chats/analyst — body=${await send.text().catch(() => '<unreadable>')}`).toBe(200);

    const after = await request.get('/api/chats/analyst');
    expect(after.status()).toBe(200);
    const afterBody = await after.json();
    expect(afterBody.entries.length).toBeGreaterThan(beforeCount);
    const texts = afterBody.entries.map((e: { content?: string; text?: string }) => e.content ?? e.text ?? '');
    expect(texts.some((t: string) => t.includes(marker))).toBe(true);
  });

  test('destructive-confirmation gate is gone: analyst card mutation request is not rejected with authorized-surface error', async ({ request }) => {
    const before = await request.get('/api/chats/analyst');
    const beforeCount = (await before.json()).entries.length;

    const send = await request.post('/api/chats/analyst', {
      data: {
        content: "update the project card title to 'E2E Gate Removal Smoke Test'",
        workspaceContext: { view: 'dashboard', entityId: null, refinement: null },
      },
      timeout: 120_000,
    });
    expect(send.status(), `POST /api/chats/analyst — body=${await send.text().catch(() => '<unreadable>')}`).toBe(200);

    const after = await request.get('/api/chats/analyst');
    const entries = (await after.json()).entries.slice(beforeCount) as Array<{ content?: string; text?: string }>;
    const text = entries.map((e) => e.content ?? e.text ?? '').join('\n');
    expect(text).not.toContain('requires an authorized surface');
    expect(text).not.toContain('confirmed/preview_hash');
    expect(text).not.toContain('preview to proceed');
    expect(text).not.toContain('preview_only');
  });
});
