import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes, smokeCardId } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { seedTokenBeforeNavigation } from './fixtures/operator-preview-sync.js';

const token = 'synthetic-cockpit-conversation-token';
const executor = `agent:executor:${smokeCardId}`;
const reviewer = `agent:reviewer:${smokeCardId}`;
const marker = '99999999-9999-4999-8999-999999999999';
const now = '2026-09-28T12:00:00.000Z';

async function setup(page: Page, chatBack = false) {
  await seedTokenBeforeNavigation(page, token);
  await installOperatorWebSocketShim(page);
  return installOperatorRestRoutes(page, chatBack ? {
    chatToolInvocations: [{ tool: 'navigate_back', params: {}, result: { success: true, data: { intent: 'navigate_back' } } }],
  } : {});
}

async function sendAnalyst(page: Page, text: string): Promise<void> {
  const input = page.getByLabel('Analyst chat composer');
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toBeEnabled();
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: false });
}

test('card conversations retain cockpit context through automatic, explicit, facet, and browser navigation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rest = await setup(page);
  await page.goto('/');
  await expect(page.getByTestId('facet-overview')).toBeVisible();
  const siblingToggle = page.getByRole('button', { name: 'Expand Synthetic sibling goal', exact: true });
  await siblingToggle.focus();
  await expect(siblingToggle).toBeFocused();
  await siblingToggle.click();
  const expandedSibling = page.locator('.tree-node').filter({ hasText: 'Expanded sibling child' });
  await expect(expandedSibling).toBeVisible();
  const conversationsTab = page.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Conversations', exact: true });
  await conversationsTab.focus();
  await expect(conversationsTab).toBeFocused();
  await conversationsTab.press('Enter');

  await expect(page).toHaveURL(`/agents/${executor}`);
  const cockpit = page.getByTestId('route-cockpit');
  await expect(cockpit).toHaveCount(1);
  await expect(cockpit.getByTestId('card-flow-id')).toHaveText(smokeCardId);
  await expect(cockpit.getByTestId('cockpit-facet-nav')).toContainText('OverviewConversationsRecords & HistoryEvidence');
  await expect(cockpit.locator('.conversation-container')).toHaveCount(1);
  await expect(cockpit.locator('.tree-node.selected')).toContainText('Synthetic dashboard smoke card');
  await expect(expandedSibling).toBeVisible();
  await expect(cockpit.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Conversations', exact: true })).toHaveClass(/active/);
  await expect(page.getByLabel('Analyst chat composer')).toBeVisible();

  const reviewerButton = cockpit.getByRole('button', { name: new RegExp(reviewer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  await reviewerButton.focus();
  await expect(reviewerButton).toBeFocused();
  await reviewerButton.press('Enter');
  await expect(page).toHaveURL(`/agents/${reviewer}`);
  await expect(cockpit.locator('.conversation-container')).toHaveCount(1);
  await expect(expandedSibling).toBeVisible();

  await cockpit.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.getByTestId('facet-overview')).toBeVisible();
  await cockpit.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Records & History', exact: true }).click();
  await expect(page.getByTestId('facet-records')).toBeVisible();
  await cockpit.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Evidence', exact: true }).click();
  await expect(page.getByTestId('facet-evidence')).toBeVisible();
  const executorEvidence = page.getByTestId('facet-evidence').locator('.evidence-record').filter({ hasText: executor });
  await executorEvidence.getByRole('button', { name: 'Load segment catalog' }).click();
  await executorEvidence.getByRole('link', { name: /Segment 1/ }).click();
  await expect(page).toHaveURL(`/agents/${executor}`);
  await expect(expandedSibling).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp('facet=evidence'));
  await page.goForward();
  await expect(page).toHaveURL(`/agents/${executor}`);

  await screenshot(page, testInfo, 'cockpit-conversation-1440x900.png');
  expect(rest.unknown).toEqual([]);
});

test('exact entry reload, unavailable card, global scope, narrow controls, and Analyst Back stay truthful', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const rest = await setup(page, true);
  await page.route(`**/api/agents/${encodeURIComponent(executor)}/conversation`, async (route: Route) => {
    const entry = { id: marker, session_id: executor, role: 'assistant', kind: 'text', content: 'Exact marker transcript row', context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true }, round_id: 'r-assistant-99999999999949998999999999999999', message_index: 0, block_index: 0, timestamp: now };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(parseOperatorResponse('agents.conversation', 200, { session_id: executor, segment_version: 1, segment_context: null, entries: [entry], cursor: { segment_version: 1, message_id: marker } })) });
  });
  await page.goto(`/agents/${encodeURIComponent(executor)}?entry=${marker}`);
  await expect(page.getByText('Exact marker transcript row')).toBeVisible();
  await expect(page.locator(`[data-entry-id="${marker}"]`)).toHaveClass(/targeted-conversation-entry/);
  await expect(page.getByTestId('cockpit-facet-nav')).toBeVisible();
  await page.reload();
  await expect(page.locator(`[data-entry-id="${marker}"]`)).toHaveClass(/targeted-conversation-entry/);

  const toolbarButtons = page.locator('.conv-toolbar button');
  await expect(toolbarButtons).toHaveCount(3);
  for (const button of await toolbarButtons.all()) await expect(button).toBeVisible();
  const toolbarFitsReader = await page.locator('.focused-reader').evaluate((reader) => {
    const boundary = reader.getBoundingClientRect();
    return [...reader.querySelectorAll<HTMLElement>('.conv-toolbar button')].every((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left >= boundary.left && rect.right <= boundary.right && rect.top >= boundary.top && rect.bottom <= boundary.bottom;
    });
  });
  expect(toolbarFitsReader).toBe(true);
  await expect(page.getByTestId('back-to-card')).toHaveCount(0);
  await screenshot(page, testInfo, 'cockpit-conversation-900x700.png');

  await page.goto(`/agents/${encodeURIComponent(executor)}?entry=88888888-8888-4888-8888-888888888888`);
  await expect(page.getByText('The requested conversation entry was not found in this session.')).toBeVisible();

  await page.route(`**/api/cards/${smokeCardId}`, async (route: Route) => {
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Card not found', cardId: smokeCardId }) });
  });
  await page.goto(`/agents/${encodeURIComponent(executor)}`);
  await expect(page.getByTestId('card-flow-unavailable')).toHaveText('Card flow unavailable');
  await expect(page.locator('.conversation-container')).toHaveCount(1);
  await expect(page.getByTestId('cockpit-facet-nav').locator('[aria-disabled="true"]')).toHaveCount(3);

  await page.goto('/agents/agent:oversight:global');
  await expect(page.getByTestId('session-global-header')).toContainText('Global session');
  await expect(page.getByTestId('cockpit-facet-nav')).toHaveCount(0);
  await expect(page.locator('.conversation-container')).toHaveCount(1);

  await page.unroute(`**/api/cards/${smokeCardId}`);
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link').filter({ hasText: 'Files' }).click();
  await expect(page).toHaveURL('/files');
  await page.getByTestId('strip-current-work').getByRole('link').click();
  await expect(page).toHaveURL(`/cards/${smokeCardId}`);
  await page.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Conversations', exact: true }).click();
  await expect(page).toHaveURL(`/agents/${executor}`);
  await page.getByRole('button', { name: new RegExp(reviewer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
  await sendAnalyst(page, 'Back one');
  await expect(page).toHaveURL(`/agents/${executor}`);
  await sendAnalyst(page, 'Back two');
  await expect(page).toHaveURL(`/cards/${smokeCardId}`);
  await sendAnalyst(page, 'Back three');
  await expect(page).toHaveURL('/files');
  expect(rest.unknown).toEqual([]);
});
