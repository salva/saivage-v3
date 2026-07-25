import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let authEventSequence = 0;

function installBootstrapMocks() {
  const authEvent = `saivage-test-auth-token-changed-${++authEventSequence}`;
  const registerResource = vi.fn();
  const connect = vi.fn();
  const reconfigure = vi.fn();
  const runtimeRefetch = vi.fn(async () => undefined);
  const markWsSync = vi.fn();
  const ensureRoot = vi.fn(async () => undefined);
  const reset = vi.fn();
  const authRefresh = vi.fn();
  const fetchSessions = vi.fn();
  vi.doMock('../stores/sync', () => ({
    useSyncStore: () => ({ registerResource, connect, reconfigure }),
  }));
  vi.doMock('../stores/runtime', () => ({
    useRuntimeStore: () => ({ refetch: runtimeRefetch, markWsSync }),
  }));
  vi.doMock('../stores/cards', () => ({
    useCardStore: () => ({ ensureRoot, reset, onInvalidate: vi.fn(), onReconnect: vi.fn() }),
  }));
  vi.doMock('../stores/agents', () => ({ useAgentStore: () => ({ fetchSessions }) }));
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
  };
}

describe('application bootstrap live sync', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setActivePinia(createPinia());
  });

  it('starts only runtime and root hierarchy and performs no hidden Agent request', async () => {
    const mocks = installBootstrapMocks();
    const { startAppBootstrap } = await import('../composables/useAppBootstrap');
    startAppBootstrap();
    startAppBootstrap();
    await Promise.resolve();

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeRefetch).toHaveBeenCalledTimes(1);
    expect(mocks.ensureRoot).toHaveBeenCalledTimes(1);
    expect(mocks.fetchSessions).not.toHaveBeenCalled();
    expect(
      mocks.registerResource.mock.calls.map(([registration]) => registration.resource),
    ).toEqual(['cards', 'runtime']);
  });

  it('reconfigures runtime and root without bootstrapping hidden Agent state', async () => {
    const mocks = installBootstrapMocks();
    const { startAppBootstrap } = await import('../composables/useAppBootstrap');
    startAppBootstrap();
    window.dispatchEvent(new Event(mocks.authEvent));
    await Promise.resolve();

    expect(mocks.authRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.reconfigure).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeRefetch).toHaveBeenCalledTimes(2);
    expect(mocks.reset).toHaveBeenCalledTimes(1);
    expect(mocks.ensureRoot).toHaveBeenCalledTimes(2);
    expect(mocks.fetchSessions).not.toHaveBeenCalled();
  });
});
