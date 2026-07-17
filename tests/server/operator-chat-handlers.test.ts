import { describe, expect, it, jest } from '@jest/globals';

import { buildChatOperatorContractHandlers } from '../../src/server/routes/operator-chat-handlers.js';

const invalid = ['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'] as const;

describe('operator chat handlers singleton rejection', () => {
  it.each(invalid)('rejects GET %s before card or conversation reads', async (sessionId) => {
    const read = jest.fn(() => { throw new Error('must not read'); });
    const handlers = buildChatOperatorContractHandlers({ projectRoot: '/nonexistent', cardStore: { read } } as never);
    const result = await handlers['chats.get']!({ params: { sessionId } } as never);
    expect(result).toMatchObject({ statusCode: 404, body: { sessionId } });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(invalid)('rejects POST %s before singleton runtime submission', async (sessionId) => {
    const submit = jest.fn();
    const handlers = buildChatOperatorContractHandlers({ projectRoot: '/nonexistent', cardStore: { read: jest.fn() }, runtimeApplication: { analystRuntime: { submit } }, saivageConfig: {} } as never);
    const result = await handlers['chats.send']!({ params: { sessionId }, body: { content: 'hello' }, reply: { raw: { once: jest.fn() } } } as never);
    expect(result).toMatchObject({ statusCode: 404, body: { sessionId } });
    expect(submit).not.toHaveBeenCalled();
  });
});
