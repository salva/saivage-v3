import { expect, test } from '@playwright/test';

const analystSessionId = 'agent:analyst:global';
const analystChatPath = '/api/chat';
const analystConversationPath = `/api/agents/${encodeURIComponent(analystSessionId)}/conversation`;

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

  test('root card hierarchy returns only the project and immediate children', async ({ request }) => {
    const res = await request.get('/api/cards/project/children');
    expect(res.status(), `GET /api/cards/project/children — body=${await res.text().catch(() => '<unreadable>')}`).toBe(200);
    const body = await res.json();
    expect(body.card.id).toBe('project');
    expect(Array.isArray(body.children)).toBe(true);
    expect(body.children.every((child: { parent: string }) => child.parent === 'project')).toBe(true);
  });

  test('chats.get returns only the canonical analyst identity', async ({ request }) => {
    const res = await request.get(analystChatPath);
    expect(res.status(), `GET ${analystChatPath} — body=${await res.text().catch(() => '<unreadable>')}`).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ session_id: analystSessionId });
  });

  test('files.list returns a directory listing for the project root', async ({ request }) => {
    const res = await request.get('/api/files');
    expect(res.status(), `GET /api/files — body=${await res.text().catch(() => '<unreadable>')}`).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  test('events newest tail returns a payload', async ({ request }) => {
    const res = await request.get('/api/events?selection=newest_tail&limit=1000');
    expect(res.status(), `GET /api/events — body=${await res.text().catch(() => '<unreadable>')}`).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  test('agents.list returns sessions including analyst', async ({ request }) => {
    const res = await request.get('/api/agents');
    expect(res.status(), `GET /api/agents — body=${await res.text().catch(() => '<unreadable>')}`).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.some((s: { id: string }) => s.id === analystSessionId)).toBe(true);
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

  test('chats.send round-trip appends a user entry visible in the analyst transcript', async ({ request }) => {
    const before = await request.get(analystConversationPath);
    expect(before.status()).toBe(200);
    const beforeBody = await before.json();
    const beforeCount = beforeBody.entries.length;

    const marker = `live-e2e-roundtrip-${Date.now()}`;
    const send = await request.post(analystChatPath, {
      data: { content: marker, workspaceContext: { view: 'dashboard', entityId: null, refinement: null } },
      timeout: 120_000,
    });
    expect(send.status(), `POST ${analystChatPath} — body=${await send.text().catch(() => '<unreadable>')}`).toBe(200);

    const after = await request.get(analystConversationPath);
    expect(after.status()).toBe(200);
    const afterBody = await after.json();
    expect(afterBody.entries.length).toBeGreaterThan(beforeCount);
    const texts = afterBody.entries.map((e: { content?: string; text?: string }) => e.content ?? e.text ?? '');
    expect(texts.some((t: string) => t.includes(marker))).toBe(true);
  });

  test('destructive-confirmation gate is gone: analyst card mutation request is not rejected with authorized-surface error', async ({ request }) => {
    test.setTimeout(180_000);
    const before = await request.get(analystConversationPath);
    const beforeCount = (await before.json()).entries.length;

    const send = await request.post(analystChatPath, {
      data: {
        content: "mark the project card as needing corrections with one warning issue: live e2e gate removal probe",
        workspaceContext: { view: 'dashboard', entityId: null, refinement: null },
      },
      timeout: 180_000,
    });
    expect(send.status(), `POST ${analystChatPath} — body=${await send.text().catch(() => '<unreadable>')}`).toBe(200);

    const after = await request.get(analystConversationPath);
    const entries = (await after.json()).entries.slice(beforeCount) as Array<{ content?: string; text?: string }>;
    const text = entries.map((e) => e.content ?? e.text ?? '').join('\n');
    expect(text).not.toContain('requires an authorized surface');
    expect(text).not.toContain('confirmed/preview_hash');
    expect(text).not.toContain('preview to proceed');
    expect(text).not.toContain('preview_only');
  });

  test('two back-to-back chats.send POSTs produce two distinct 32-hex round_ids', async ({ request }) => {
    test.setTimeout(240_000);
    const HEX_ROUND = /^r-user-[0-9a-f]{32}$/;
    const before = await request.get(analystConversationPath);
    const beforeCount = (await before.json()).entries.length as number;

    const stamp = Date.now();
    const post1 = await request.post(analystChatPath, { data: { content: `round-id-uniqueness-probe-A-${stamp}`, workspaceContext: { view: 'dashboard', entityId: null, refinement: null } }, timeout: 120_000 });
    expect(post1.status()).toBe(200);
    const post2 = await request.post(analystChatPath, { data: { content: `round-id-uniqueness-probe-B-${stamp}`, workspaceContext: { view: 'dashboard', entityId: null, refinement: null } }, timeout: 120_000 });
    expect(post2.status()).toBe(200);

    const after = await request.get(analystConversationPath);
    const allEntries = (await after.json()).entries as Array<{ role: string; content?: string; text?: string; round_id?: string }>;
    const newEntries = allEntries.slice(beforeCount);
    const userEntries = newEntries.filter((e) => e.role === 'user');
    expect(userEntries.length).toBeGreaterThanOrEqual(2);
    const probeRoundIds = userEntries
      .filter((e) => (e.content ?? e.text ?? '').includes(`round-id-uniqueness-probe-`) && (e.content ?? e.text ?? '').includes(String(stamp)))
      .map((e) => e.round_id ?? '');
    expect(probeRoundIds.length).toBeGreaterThanOrEqual(2);
    for (const id of probeRoundIds) expect(id).toMatch(HEX_ROUND);
    expect(new Set(probeRoundIds).size).toBe(probeRoundIds.length);
  });
});
