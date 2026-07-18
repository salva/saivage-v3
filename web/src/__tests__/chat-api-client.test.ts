import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/auth', () => ({ getAuthToken: () => null }));

import { getChatEntries, sendChatMessage } from '../api/client';
import type { ChatWorkspaceContext } from '../api/types';

type Equal<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

const getChatEntriesSignatureIsExact: Equal<Parameters<typeof getChatEntries>, [signal?: AbortSignal]> = true;
const sendChatMessageSignatureIsExact: Equal<
  Parameters<typeof sendChatMessage>,
  [content: string, workspaceContext?: ChatWorkspaceContext]
> = true;

describe('Analyst chat API client', () => {
  const originalFetch = globalThis.fetch;
  const request = vi.fn();
  const canonicalUrl = `${window.location.origin}/api/chats/analyst%3Aglobal`;

  beforeEach(() => {
    request.mockReset();
    globalThis.fetch = request;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses the identity-free GET signature and exact canonical route', async () => {
    const signal = new AbortController().signal;
    request.mockResolvedValue(new Response(JSON.stringify({ sessionId: 'analyst:global', entries: [] }), { status: 200 }));

    await expect(getChatEntries(signal)).resolves.toEqual({ sessionId: 'analyst:global', entries: [] });

    expect(getChatEntriesSignatureIsExact).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(canonicalUrl, {
      method: 'GET',
      headers: {},
      signal,
    });
  });

  it('uses the identity-free POST signature, exact canonical route, and exact body', async () => {
    const workspaceContext: ChatWorkspaceContext = {
      view: 'cards',
      entityId: 'project',
      refinement: { tab: 'history' },
    };
    request.mockResolvedValue(new Response(JSON.stringify({ sessionId: 'analyst:global', toolInvocations: [], restart: null }), { status: 200 }));

    await expect(sendChatMessage('inspect this', workspaceContext)).resolves.toEqual({
      sessionId: 'analyst:global',
      toolInvocations: [],
      restart: null,
    });

    expect(sendChatMessageSignatureIsExact).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(canonicalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: undefined,
      body: JSON.stringify({ content: 'inspect this', workspaceContext }),
    });
  });
});
