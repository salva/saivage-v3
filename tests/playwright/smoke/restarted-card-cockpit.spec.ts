import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { CardService } from '../../../src/cards/card-service.js';
import { compileProjectWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { appOrigin, initializeProject, productionTestConfig, startProductionApp, writeProductionConfig } from '../../helpers/production-composition-e2e.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const token = 'isolated-browser-restart-token';

test('restarted descendant cockpit renders canonical stopped lifecycle and no executing participant before Run', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'saivage-browser-restarted-'));
  const originalConfig = process.env.SAIVAGE_CONFIG;
  const originalProjectRoot = process.env.SAIVAGE_PROJECT_ROOT;
  const staleProjectRoot = join(root, 'synthetic-nonexistent-stale-project');
  const staleConfig = join(staleProjectRoot, '.saivage', 'saivage.yaml');
  try {
    process.env.SAIVAGE_CONFIG = staleConfig;
    process.env.SAIVAGE_PROJECT_ROOT = staleProjectRoot;
    const config = productionTestConfig(1, (value) => {
      value.card_types.project.permitted_child_types = ['goal'];
      value.card_types.goal.permitted_child_types = ['code'];
    });
    writeProductionConfig(root, config);
    initializeProject(root);
    const cards = new CardService(root, compileProjectWorkflows(config, { projectRoot: root }));
    const goal = cards.create({ type: 'goal', parent: 'project', title: 'Restarted goal', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    const leaf = cards.create({ type: 'code', parent: goal.id, title: 'Restarted descendant', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    const initial = await startProductionApp(root, token);
    try {
      expect(process.env.SAIVAGE_CONFIG).toBe(staleConfig);
      expect(process.env.SAIVAGE_PROJECT_ROOT).toBe(staleProjectRoot);
    } finally { await initial.stop(); }
    // Model durable interrupted state while no lifecycle owner is active.
    for (const id of ['project', goal.id, leaf.id]) cards.setStatus(id, 'running');
    const app = await startProductionApp(root, token);
    try {
      expect(process.env.SAIVAGE_CONFIG).toBe(staleConfig);
      expect(process.env.SAIVAGE_PROJECT_ROOT).toBe(staleProjectRoot);
      const origin = appOrigin(app);
      const headers = { authorization: `Bearer ${token}` };
      const get = async (path: string) => {
        const response = await fetch(`${origin}${path}`, { headers });
        expect(response.status).toBe(200);
        return response.json() as Promise<any>;
      };
      expect((await fetch(`${origin}/health/ready`)).status).toBe(200);
      const runtime = await get('/api/runtime/status');
      const detail = await get(`/api/cards/${leaf.id}`);
      const history = await get(`/api/cards/${leaf.id}/history`);
      expect(runtime).toMatchObject({ runtime: 'stopped', currentCardId: null, actorRuntime: { cards: [] } });
      expect(detail.card.lifecycle.status).toBe('stopped');
      expect(history.versions.at(-1).change).toMatchObject({ summary: 'recovery stopped lifecycle', changed_fields: ['lifecycle'] });
      await installOperatorWebSocketShim(page);
      await page.addInitScript((value) => localStorage.setItem('saivage_api_token', value), token);
      await page.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}`, headers: { ...route.request().headers(), ...headers } });
        await route.fulfill({ response });
      });
      await page.goto(`/cards/${leaf.id}`);
      await expect(page.getByTestId('card-flow-title')).toHaveText(detail.card.title);
      await expect(page.locator('.card-flow-header .status-badge')).toHaveText(detail.card.lifecycle.status);
      await expect(page.getByTestId('strip-lifecycle')).toContainText('Stopped');
      await expect(page.getByTestId('facet-overview')).toContainText('No published sessions');
      await expect(page.getByTestId('facet-overview')).not.toContainText('Executing');
      expect(cards.read(leaf.id)?.lifecycle.status).toBe(detail.card.lifecycle.status);
      const canonical = cards.listCardVersions(leaf.id);
      expect(canonical.kind).toBe('found');
      if (canonical.kind !== 'found') throw new Error('Expected canonical leaf history.');
      expect(canonical.value.at(-1)?.change?.change_reason).toBe(history.versions.at(-1).change.summary);
    } finally { await app.stop(); }
  } finally {
    if (originalConfig === undefined) delete process.env.SAIVAGE_CONFIG;
    else process.env.SAIVAGE_CONFIG = originalConfig;
    if (originalProjectRoot === undefined) delete process.env.SAIVAGE_PROJECT_ROOT;
    else process.env.SAIVAGE_PROJECT_ROOT = originalProjectRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
