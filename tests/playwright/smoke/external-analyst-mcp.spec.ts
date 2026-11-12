import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startApp } from '../../../src/boot/app.js';
import { appendConversationBatch, readConversation } from '../../../src/persistence/conversation-file.js';
import { buildGlobalAgentIngressRows } from '../../../src/runtime/actors/conversation-session.js';
import { globalAgentConversationVersionIndexFile } from '../../../src/persistence/layout.js';
import { productionTestConfig, writeProductionConfig, initializeProject, listen, closeServer, appOrigin } from '../../helpers/production-composition-e2e.js';
import { seedTokenBeforeNavigation } from './fixtures/operator-preview-sync.js';
import { currentConversationSegmentPath } from '../../helpers/current-conversation-segment-path.js';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';

test.describe.configure({ timeout: 120_000, retries: 0 });

test('selected MCP observation and manual reselection show scope and containment without lifecycle controls or remote refresh', async ({ page }) => {
  await installOperatorWebSocketShim(page);
  await installOperatorRestRoutes(page);
  let reads = 0;
  const posts: string[] = [];
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname.startsWith('/api/mcp/')) posts.push(req.url()); });
  await page.route('**/api/mcp/tools', route => {
    reads++;
    const body = parseOperatorResponse('mcp.tools', 200, { servers: [{
      name: 'scoped-peer', transport: 'stdio', status: reads === 1 ? 'stopping' : 'error',
      bindingId: null, definitionSource: null, policy: { controllerCardId: 'project', exposure: 'subtree' },
      availableActions: ['mcp_server_control'], ready: false, containment: reads === 1 ? 'pending' : 'failed',
      failureReason: reads === 1 ? null : 'containment_failed', containmentBoundary: 'local_process_group',
      processId: 'fixture-launch', toolCount: 0, tools: [],
    }] });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/system?tab=state');
  expect(reads).toBe(0);
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  const panel = page.locator('.mcp-content');
  await expect(panel).toContainText('Project-wide');
  await expect(panel).toContainText('stopping');
  await expect(panel).toContainText('pending');
  await expect(panel).toContainText('Absent · retained owner');
  await expect(panel).toContainText('Not ready');
  await expect(panel.getByRole('button')).toHaveCount(0);
  expect(reads).toBe(1);
  await page.getByRole('button', { name: 'State', exact: true }).click();
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  await expect(panel).toContainText('failed · name blocked');
  await expect(panel).toContainText('containment_failed');
  expect(reads).toBe(2);
  expect(posts).toEqual([]);
});

test('external SDK effects refresh into ordinary records/actions while disabled historical inspection has no composer', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'external-analyst-browser-'));
  const reservation = createServer(); const port = await listen(reservation); await closeServer(reservation);
  const config = productionTestConfig(1, config => {
    config.models.routes[config.agents[config.analyst_agent]!.model_route]!.candidates = ['unavailable-analyst-model'];
  });
  writeProductionConfig(root, config); initializeProject(root);
  const session = 'agent:analyst:global' as const;
  // Explicit retained synthetic operator history, not a transcript of MCP effects.
  appendConversationBatch({ projectRoot: root }, buildGlobalAgentIngressRows(session,
    '11111111-1111-4111-8111-111111111111', 'Retained operator history before external mode',
    { kind: 'not_applicable', reason: 'non_model_ingress' }));
  const history = readConversation(root, session);
  const body = currentConversationSegmentPath(root, session);
  const bodyBefore = readFileSync(body);
  const index = globalAgentConversationVersionIndexFile(root, config.analyst_agent);
  const before = readFileSync(index);
  const app = await startApp({ projectRoot: root, createRuntime: false, analystMode: 'external',
    analystMcpPort: String(port), analystMcpPrincipal: 'browser-operator', analystMcpTools: 'read,write,get_status',
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', SAIVAGE_HOST: '127.0.0.1', SAIVAGE_PORT: '0',
      SAIVAGE_API_TOKEN: 'synthetic-browser-rest', SAIVAGE_ANALYST_MCP_TOKEN: 'synthetic-browser-mcp' } });
  const client = new Client({ name: 'disposable-browser-test-client', version: '1' });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(app.server.analystMcpEndpoint!), {
      requestInit: { headers: { authorization: 'Bearer synthetic-browser-mcp' } },
    }));
    const origin = appOrigin(app);
    await seedTokenBeforeNavigation(page, 'synthetic-browser-rest');
    await page.goto(`${origin}/cards/project?facet=records`);
    await expect(page.getByTestId('facet-records')).toBeVisible();
    await expect(page.locator('.app-shell')).toHaveClass(/analyst-pane-suppressed/);
    await expect(page.locator('#analyst-pane, a[href="#analyst-pane"], .mobile-pane-switch, textarea')).toHaveCount(0);
    const accepted = 'Requirements accepted by the real external SDK call';
    expect(await client.callTool({ name: 'write', arguments: { path: 'record:///brief.md?card=project', content: accepted } })).toMatchObject({ isError: false });
    // Ordinary browser refresh, no fabricated websocket/transcript result.
    await page.reload();
    await expect(page.getByTestId('facet-records')).toContainText(accepted);
    await expect(page.getByTestId('facet-records')).toContainText('browser-operator');
    await page.goto(`${origin}/system?tab=actions`);
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByTestId('actions-refresh').click();
    await expect(page.getByTestId('actions-list')).toContainText('external:browser-operator');
    await expect(page.getByTestId('actions-list')).toContainText('mcp');
    await page.goto(`${origin}/agents/${encodeURIComponent(session)}`);
    await expect(page.getByText('Retained operator history before external mode', { exact: true })).toBeVisible();
    await expect(page.getByText(/Internal Analyst interaction is disabled/)).toBeVisible();
    await expect(page.locator('textarea, #analyst-pane')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('/');
    await expect(page.locator('.mobile-pane-switch, .activity-dot, textarea')).toHaveCount(0);
    expect(await page.locator('.workspace-shell').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(380);
    expect(readFileSync(index)).toEqual(before);
    expect(readFileSync(body)).toEqual(bodyBefore);
    expect(readConversation(root, session)).toEqual(history);
    expect(errors).toEqual([]);
  } finally {
    await client.close(); await app.stop(); rmSync(root, { recursive: true, force: true });
  }
});
