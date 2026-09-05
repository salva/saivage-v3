import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { StartInputs } from '../../src/boot/index.js';

const startApp = jest.fn<(inputs: StartInputs) => Promise<{ environment: { server: { host: string; port: number } } }>>(async () => ({ environment: { server: { host: '127.0.0.1', port: 0 } } }));
jest.unstable_mockModule('../../src/boot/index.js', () => ({
  publishInitialProjectRuntime: jest.fn(),
  startApp,
}));

const { run } = await import('../../src/cli.js');

afterEach(() => {
  startApp.mockClear();
  jest.restoreAllMocks();
});

describe('start command typed inputs', () => {
  it('passes every accepted start option from the one CLI parse without argv', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await run([
      'node', 'saivage', 'start',
      '--host=127.0.0.1', '--port', '0', '--config=selected.yaml',
      '--project-root', '/work/project', '--create-runtime',
    ]);

    expect(startApp).toHaveBeenCalledTimes(1);
    expect(startApp).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: '0',
      config: 'selected.yaml',
      projectRoot: '/work/project',
      createRuntime: true,
    });
    expect(startApp.mock.calls[0]![0]).not.toHaveProperty('argv');
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
    });
  });
});
