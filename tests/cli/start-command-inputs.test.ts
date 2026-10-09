import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { StartInputs } from '../../src/boot/index.js';

const startApp = jest.fn<(inputs: StartInputs) => Promise<{ environment: { server: { host: string; port: number } } }>>(async () => ({ environment: { server: { host: '127.0.0.1', port: 0 } } }));
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
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await run([
      'node', 'saivage', 'start',
      '--host=127.0.0.1', '--port', '0', '--config=selected.yaml',
       '--project-root', '/work/project', '--create-runtime',
       '--failed-provider-diagnostics', '00000000-0000-4000-8000-000000000001',
    ]);

    expect(startApp).toHaveBeenCalledTimes(1);
    expect(startApp).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: '0',
      config: 'selected.yaml',
      projectRoot: '/work/project',
      createRuntime: true,
      failedProviderDiagnostics: '00000000-0000-4000-8000-000000000001',
    });
    expect(startApp.mock.calls[0]![0]).not.toHaveProperty('argv');
    expect(withDirectMutationComposition).not.toHaveBeenCalled();
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
