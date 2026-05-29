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
});
