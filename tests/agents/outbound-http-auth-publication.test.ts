import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as auth from '../../src/auth/index.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { capturedHttp, assertLifecycles, assertPrivateMetadata } from '../helpers/http-lifecycle.js';

const fatal = new PublicationOutcomeUnknownError();
let failPublication = false;
jest.unstable_mockModule('../../src/auth/index.js', () => ({ ...auth,
  replaceAuthProfiles: (...args: Parameters<typeof auth.replaceAuthProfiles>) => {
    if (failPublication) throw fatal;
    return auth.replaceAuthProfiles(...args);
  },
}));
const { resolveLlmTransportConfig } = await import('../../src/agents/llm-transport.js');
const { ProviderRegistry } = await import('../../src/agents/provider.js');
const { makeCodexJwt } = await import('../helpers/llm-test-helpers.js');

describe('auth HTTP terminal is outside credential publication', () => {
  it.each(['openai-codex', 'github-copilot'] as const)('%s successful HTTP then unknown credential publication has no later observation or cleanup', async provider => {
    const root = mkdtempSync(join(tmpdir(), 'auth-http-publication-')); const capture = capturedHttp();
    const token = provider === 'openai-codex' ? makeCodexJwt('private-account') : 'secret-access';
    const file = { version: 1, profiles: { 'secret-profile': { type: 'oauth' as const, provider, accessToken: token, refreshToken: 'secret-refresh', expiresAt: Date.now() - 1 } } };
    auth.replaceAuthProfiles(root, file);
    const registry = new ProviderRegistry({ providers: { [provider]: { models: ['secret-model'], authProfile: 'secret-profile' } } } as never);
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(provider === 'openai-codex'
      ? { access_token: token, refresh_token: 'secret-replacement', expires_in: 3600 } : { token, expires_at: Math.floor(Date.now() / 1000) + 3600 })));
    try {
      failPublication = true;
      await expect(resolveLlmTransportConfig(root, registry, { provider, account: null, model: 'secret-model' }, 'standard', undefined,
        { context: { service: 'provider', purpose: 'primary', endpoint: 'provider.chat', method: 'POST' }, emitter: capture.sink })).rejects.toBe(fatal);
      assertLifecycles(capture.records, 1); expect(capture.records.at(-1)).toMatchObject({ outcome: 'completed', body_disposition: 'consumed', status: 200 });
      expect(fetch).toHaveBeenCalledTimes(1); expect(auth.readAuthProfiles(root)).toEqual(file);
      assertPrivateMetadata(capture.records, [token, 'secret-profile', 'secret-model', 'secret-refresh', 'secret-replacement', 'private-account']);
    } finally { failPublication = false; jest.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); }
  });
});
