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
        body: JSON.stringify({ sessionId: 'agent:analyst:global', toolInvocations: [], restart: null }),
      });
      return;
    }

    throw new Error(`Unexpected canonical chat request method: ${method}`);
  });

  await page.goto('/src/api/types.ts');
  await page.evaluate(async () => {
    const clientModulePath = '/src/api/client.ts';
    const client = await import(/* @vite-ignore */ clientModulePath);
    const workspaceContext = {
      view: 'cards',
      entityId: 'project',
      refinement: { tab: 'history' },
    };

    await client.getChatEntries();
    await client.sendChatMessage('inspect this', workspaceContext);
  });

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
