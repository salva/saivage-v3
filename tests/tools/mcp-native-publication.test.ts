import { afterEach, expect, it, jest } from '@jest/globals';
import sharp from 'sharp';
const publish = jest.fn<(...args: unknown[]) => never>();
const actual = await import('../../src/persistence/session-api.js');
jest.unstable_mockModule('../../src/persistence/session-api.js', () => ({ ...actual, publishConversationImage: publish }));
const { PublicationOutcomeUnknownError } = await import('../../src/contracts/index.js');
const { projectNativeMcpResult } = await import('../../src/tools/mcp-native-result.js');
afterEach(() => { publish.mockReset(); });
it('stops at first publication uncertainty without later publication or cleanup', async () => {
  const bytes = await sharp({ create: { width: 2, height: 1, channels: 3, background: '#abc' } }).png().toBuffer();
  const block = { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' };
  const failure = new PublicationOutcomeUnknownError(); publish.mockImplementation(() => { throw failure; });
  await expect(projectNativeMcpResult({ content: [block, block] }, '/unused', 'agent:analyst:global', new AbortController().signal)).rejects.toBe(failure);
  expect(publish).toHaveBeenCalledTimes(1);
});
