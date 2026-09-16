import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let authEventSequence = 0;

function installBootstrapMocks() {
  const authEvent = `saivage-test-auth-token-changed-${++authEventSequence}`;
  const registerResource = vi.fn();
  const connect = vi.fn();
  const reconfigure = vi.fn();
  const runtimeRefetch = vi.fn(async () => undefined);
  const ensureRoot = vi.fn(async () => undefined);
  const reset = vi.fn();
  const authRefresh = vi.fn();
  const contentPolicyRefetch = vi.fn(async () => undefined);
  const contentPolicyReset = vi.fn();
  const fetchSessions = vi.fn();
  const resolveIdentity = vi.fn(async () => undefined);
  vi.doMock('../stores/sync', () => ({
    useSyncStore: () => ({ registerResource, connect, reconfigure }),
  }));
  vi.doMock('../stores/runtime', () => ({
    useRuntimeStore: () => ({ refetch: runtimeRefetch }),
  }));
  vi.doMock('../stores/cards', () => ({
    useCardStore: () => ({ ensureRoot, reset, onInvalidate: vi.fn(), onReconnect: vi.fn() }),
  }));
  vi.doMock('../stores/agents', () => ({ useAgentStore: () => ({ fetchSessions }) }));
  vi.doMock('../stores/analystChat', () => ({ useAnalystChat: () => ({ resolveIdentity }) }));
  vi.doMock('../stores/contentPolicy', () => ({ useContentPolicyStore: () => ({ refetch: contentPolicyRefetch, reset: contentPolicyReset }) }));
  vi.doMock('../stores/auth', () => ({
    AUTH_TOKEN_CHANGED_EVENT: authEvent,
    useAuthStore: () => ({ refresh: authRefresh }),
  }));
  return {
    authEvent,
    registerResource,
    connect,
    reconfigure,
    runtimeRefetch,
    ensureRoot,
    reset,
    authRefresh,
    fetchSessions,
    resolveIdentity,
    contentPolicyRefetch,
    contentPolicyReset,
  };
}

describe('application bootstrap live sync', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setActivePinia(createPinia());
  });

  it('starts only runtime and root hierarchy without resolving Analyst identity or hidden Agent inventory', async () => {
    const mocks = installBootstrapMocks();
    const { startAppBootstrap } = await import('../composables/useAppBootstrap');
    startAppBootstrap();
    startAppBootstrap();
    await Promise.resolve();

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeRefetch).toHaveBeenCalledTimes(1);
    expect(mocks.ensureRoot).toHaveBeenCalledTimes(1);
    expect(mocks.contentPolicyRefetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetchSessions).not.toHaveBeenCalled();
    expect(mocks.resolveIdentity).not.toHaveBeenCalled();
    expect(
      mocks.registerResource.mock.calls.map(([registration]) => registration.resource),
    ).toEqual(['cards', 'runtime']);
    expect(mocks.registerResource.mock.calls[1]![0]).toEqual({ resource: 'runtime', refetch: mocks.runtimeRefetch });
  });

  it('reconfigures runtime and root and re-resolves only Analyst identity', async () => {
    const mocks = installBootstrapMocks();
    const { startAppBootstrap } = await import('../composables/useAppBootstrap');
    startAppBootstrap();
    mocks.resolveIdentity.mockRejectedValueOnce(new Error('identity unavailable'));
    window.dispatchEvent(new Event(mocks.authEvent));
    await Promise.resolve();

    expect(mocks.authRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.reconfigure).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeRefetch).toHaveBeenCalledTimes(2);
    expect(mocks.reset).toHaveBeenCalledTimes(1);
    expect(mocks.ensureRoot).toHaveBeenCalledTimes(2);
    expect(mocks.contentPolicyReset).toHaveBeenCalledTimes(1);
    expect(mocks.contentPolicyRefetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetchSessions).not.toHaveBeenCalled();
    expect(mocks.resolveIdentity).toHaveBeenCalledTimes(1);
  });

  it('composes content-policy refresh after card invalidation and reconnect without another resource', async () => {
    const mocks = installBootstrapMocks();
    const { startAppBootstrap } = await import('../composables/useAppBootstrap');
    startAppBootstrap();
    const cards = mocks.registerResource.mock.calls[0]![0];
    mocks.contentPolicyRefetch.mockClear();
    cards.onInvalidate({ scope: 'detail', card_id: 'project' });
    cards.onReconnect();
    await Promise.resolve();
    expect(mocks.contentPolicyRefetch).toHaveBeenCalledTimes(2);
    expect(mocks.registerResource.mock.calls.map(([registration]) => registration.resource)).toEqual(['cards', 'runtime']);
  });
});
