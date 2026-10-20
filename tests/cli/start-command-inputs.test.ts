import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { StartInputs } from '../../src/boot/index.js';
import type { App } from '../../src/boot/app.js';

type StartedApp = Pick<App, 'boundListener'> & { server: Pick<App['server'], 'analystMcpEndpoint'> };
const startApp = jest.fn<(inputs: StartInputs) => Promise<StartedApp>>(async () => ({ boundListener: { host: '127.0.0.1', port: 49152 }, server: { analystMcpEndpoint: null } }));
const withDirectMutationComposition = jest.fn<typeof import('../../src/boot/index.js').withDirectMutationComposition>(() => {
  throw new Error('Unexpected direct mutation composition during start');
});
jest.unstable_mockModule('../../src/boot/index.js', () => ({
  publishInitialProjectRuntime: jest.fn(),
  startApp,
  withDirectMutationComposition,
}));

const { run } = await import('../../src/cli.js');

afterEach(() => {
  startApp.mockClear();
  withDirectMutationComposition.mockClear();
  jest.restoreAllMocks();
});

describe('start command typed inputs', () => {
  it('passes every accepted start option from the one CLI parse without argv', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await run([
      'node', 'saivage', 'start',
      '--host=127.0.0.1', '--port', '0', '--config=selected.yaml',
       '--project-root', '/work/project', '--create-runtime',
        '--failed-provider-diagnostics', '00000000-0000-4000-8000-000000000001',
        '--analyst-mode', 'both', '--analyst-mcp-port', '8090',
        '--analyst-mcp-principal', 'local-client', '--analyst-mcp-tools', 'read,get_status',
    ]);

    expect(startApp).toHaveBeenCalledTimes(1);
    expect(startApp).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: '0',
      config: 'selected.yaml',
      projectRoot: '/work/project',
      createRuntime: true,
      failedProviderDiagnostics: '00000000-0000-4000-8000-000000000001',
      analystMode: 'both', analystMcpPort: '8090', analystMcpPrincipal: 'local-client', analystMcpTools: 'read,get_status',
    });
    expect(startApp.mock.calls[0]![0]).not.toHaveProperty('argv');
    expect(log).toHaveBeenCalledWith('Saivage server listening on http://127.0.0.1:49152');
    expect(withDirectMutationComposition).not.toHaveBeenCalled();
  });
  it.each([
    ['::1', 'http://[::1]:49152'],
    ['0.0.0.0', 'http://0.0.0.0:49152 (wildcard bind; use a reachable host address to connect)'],
    ['::', 'http://[::]:49152 (wildcard bind; use a reachable host address to connect)'],
  ])('formats the observed bind %s', async (host, announcement) => {
    startApp.mockResolvedValueOnce({ boundListener: { host, port: 49152 }, server: { analystMcpEndpoint: null } });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await run(['node', 'saivage', 'start']);
    expect(log).toHaveBeenCalledWith(`Saivage server listening on ${announcement}`);
  });

  it('passes explicit false create intent when start has no options', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await run(['node', 'saivage', 'start']);
    expect(startApp).toHaveBeenCalledWith({
      host: undefined,
      port: undefined,
      config: undefined,
      projectRoot: undefined,
      createRuntime: false,
      failedProviderDiagnostics: undefined,
      analystMode: undefined, analystMcpPort: undefined, analystMcpPrincipal: undefined, analystMcpTools: undefined,
    });
    expect(withDirectMutationComposition).not.toHaveBeenCalled();
  });
  it.each([
    ['start', '--failed-provider-diagnostics', 'invalid'],
    ['start', '--failed-provider-diagnostics'],
    ['start', '--failed-provider-diagnostics', '00000000-0000-4000-8000-000000000001', '--failed-provider-diagnostics', '00000000-0000-4000-8000-000000000002'],
    ['status', '--failed-provider-diagnostics', '00000000-0000-4000-8000-000000000001'],
    ['init', '--failed-provider-diagnostics', '00000000-0000-4000-8000-000000000001'],
  ])('rejects diagnostic option misuse before starting (%j)', async (...args) => {
    await expect(run(['node', 'saivage', ...args])).rejects.toBeDefined();
    expect(startApp).not.toHaveBeenCalled(); expect(withDirectMutationComposition).not.toHaveBeenCalled();
  });
});
