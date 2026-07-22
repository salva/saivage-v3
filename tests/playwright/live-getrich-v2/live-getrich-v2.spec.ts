import { expect, test, type Page, type Request } from '@playwright/test';

const analystSessionId = 'agent:analyst:global';

/**
 * Live end-to-end suite against the saivage-v3 deployment serving the
 * `getrich-v2` project (container `saivage-v3-getrich-v2`, default
 * http://10.0.3.170:8080). No fixtures: the server, runtime, and any
 * provider calls are real.
 *
 * Override the target with `SAIVAGE_LIVE_BASE_URL`.
 */

type ConsoleErr = { type: string; text: string };
type FailedReq = { method: string; url: string; reason: string };

function attachDiagnostics(page: Page): { consoleErrors: ConsoleErr[]; pageErrors: string[]; failed: FailedReq[] } {
  const consoleErrors: ConsoleErr[] = [];
  const pageErrors: string[] = [];
  const failed: FailedReq[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleErrors.push({ type: msg.type(), text: msg.text() });
    }
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('requestfailed', (req: Request) =>
    failed.push({ method: req.method(), url: req.url(), reason: req.failure()?.errorText ?? 'unknown' }),
  );
  return { consoleErrors, pageErrors, failed };
}

function pickJsonErrors(failed: FailedReq[]): FailedReq[] {
  return failed.filter((f) => !f.url.endsWith('/favicon.ico'));
}

test.describe('saivage-v3 live deployment — getrich-v2', () => {
  test('health and config endpoints expose the configured providers and routing', async ({ request }) => {
    const health = await request.get('/health');
    expect(health.status(), 'GET /health').toBe(200);
    const healthBody = await health.json();
    expect(healthBody.status).toBe('ok');

    const providers = await request.get('/api/providers');
    expect(providers.status(), 'GET /api/providers').toBe(200);
    const providersBody = await providers.json();
    expect(providersBody.providers).toHaveProperty('openai-codex');
    expect(providersBody.providers).toHaveProperty('opencode-go');
    expect(providersBody.providers['opencode-go'].models).toEqual(
      expect.arrayContaining(['glm-5.1', 'kimi-k2.6', 'deepseek-v4-pro']),
    );

    const cfg = await request.get('/api/config');
    expect(cfg.status(), 'GET /api/config').toBe(200);
    const cfgBody = await cfg.json();
    const models = cfgBody.config.models as Record<string, unknown>;
    expect(models.default).toEqual(['gpt-5.4']);
    expect(models.planner).toEqual(['gpt-5.5']);
  });

  test('dashboard renders the project header and live updates connect', async ({ page }) => {
    const diag = attachDiagnostics(page);
    await page.goto('/dashboard');
    await expect(page.getByText('saivage-v3').first()).toBeVisible();
    await expect(page.getByText(/Live updates connected/i).first()).toBeVisible({ timeout: 15_000 });
    expect(diag.pageErrors).toEqual([]);
    expect(pickJsonErrors(diag.failed)).toEqual([]);
  });

  test('operator navigates Dashboard → Cards → Agents → Files → Debug without errors', async ({ page }) => {
    const diag = attachDiagnostics(page);
    await page.goto('/dashboard');
    await expect(page.getByText('saivage-v3').first()).toBeVisible();

    for (const route of ['cards', 'agents', 'files', 'debug'] as const) {
      await page.getByRole('link', { name: new RegExp(`^${route}$`, 'i') }).first().click();
      await expect(page).toHaveURL(new RegExp(`/${route}(\\?|$)`));
    }

    expect(diag.pageErrors).toEqual([]);
    expect(pickJsonErrors(diag.failed)).toEqual([]);
  });

  test('Agents view lists the canonical analyst session from the live runtime', async ({ page }) => {
    await page.goto('/agents');
    await expect(page.getByRole('heading', { name: /^Agents$/i })).toBeVisible();
    await expect(page.getByText('analyst').first()).toBeVisible();
  });

  test('chats.send responds with a contract-valid success body for the analyst session', async ({ request }) => {
    const res = await request.post('/api/chat', {
      data: { content: 'live e2e ping — please reply with the single word OK', workspaceContext: { view: 'dashboard', entityId: null, refinement: null } },
      timeout: 120_000,
    });

    expect(res.status(), `chats.send status — body=${await res.text().catch(() => '<unreadable>')}`).toBe(200);

    const body = await res.json();
    expect(body.sessionId).toBe(analystSessionId);
    expect(body.message).toMatchObject({
      role: 'assistant',
      kind: 'text',
      content: expect.any(String),
      timestamp: expect.any(String),
      id: expect.any(String),
    });
    expect(Array.isArray(body.toolInvocations)).toBe(true);
  });
});
