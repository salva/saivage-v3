import { expect, test } from '@playwright/test';

type ObservedChatRequest = {
  method: string;
  pathname: string;
  body: unknown;
};

test('production chat API client emits only canonical Analyst requests', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('Playwright baseURL is required.');

  const canonicalUrl = `${baseURL}/api/chat`;
  const observedRequests: ObservedChatRequest[] = [];
  const pageErrors: string[] = [];
  const moduleFailures: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') moduleFailures.push(message.text());
  });
  page.on('requestfailed', (request) => moduleFailures.push(request.url()));
  page.on('response', (response) => {
    if (response.status() >= 400) moduleFailures.push(`${response.status()} ${response.url()}`);
  });

  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    throw new Error(`Unexpected API request: ${route.request().method()} ${new URL(route.request().url()).pathname}`);
  });

  await page.route('**/api/chat', async (route) => {
    throw new Error(`Unexpected chat request: ${route.request().method()} ${route.request().url()}`);
  });

  await page.route(canonicalUrl, async (route) => {
    const request = route.request();
    const method = request.method();
    observedRequests.push({
      method,
      pathname: new URL(request.url()).pathname,
      body: method === 'POST' ? request.postDataJSON() : null,
    });

    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ session_id: 'agent:analyst:global' }),
      });
      return;
    }

    if (method === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ toolInvocations: [], restart: null }),
      });
      return;
    }

    throw new Error(`Unexpected canonical chat request method: ${method}`);
  });

  await page.goto('/src/api/types.ts');
  const routeChain = await page.evaluate(async () => {
    // @ts-expect-error The callback runs in Vite's browser root; NodeNext cannot resolve this URL.
    const client = await import('/src/api/client.ts');
    // @ts-expect-error The callback runs in Vite's browser root; NodeNext cannot resolve this URL.
    const cards = await import('/src/stores/cards.ts');
    const workspaceContext = {
      view: 'cards',
      entityId: 'project',
      refinement: { tab: 'history' },
    };

    await client.getChatEntries();
    await client.sendChatMessage('inspect this', workspaceContext);
    return cards.cardRouteChain('card-a-b');
  });

  expect(routeChain).toEqual(['project', 'card-a', 'card-a-b']);
  expect(pageErrors).toEqual([]);
  expect(moduleFailures).toEqual([]);

  expect(observedRequests).toEqual([
    {
      method: 'GET',
      pathname: '/api/chat',
      body: null,
    },
    {
      method: 'POST',
      pathname: '/api/chat',
      body: {
        content: 'inspect this',
        workspaceContext: {
          view: 'cards',
          entityId: 'project',
          refinement: { tab: 'history' },
        },
      },
    },
  ]);
});
