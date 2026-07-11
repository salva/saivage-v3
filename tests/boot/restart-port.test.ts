import { describe, expect, it, jest } from '@jest/globals';

import { createRestartPort } from '../../src/boot/restart-port.js';

describe('RestartPort', () => {
  it('does not dispose or exit until the scheduled restart is acknowledged', async () => {
    const dispose = jest.fn(async () => undefined);
    const exit = jest.fn((code: number): never => { throw new Error(`exit ${code}`); });
    const port = createRestartPort({ dispose, exit });

    expect(() => port.acknowledge()).toThrow('has not been scheduled');
    port.schedule();
    await expect(port.acknowledge()).rejects.toThrow('exit 75');

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(75);
  });

  it('shares one disposal and exit when acknowledgement is repeated', async () => {
    const dispose = jest.fn(async () => undefined);
    const exit = jest.fn((code: number): never => { throw new Error(`exit ${code}`); });
    const port = createRestartPort({ dispose, exit });

    port.schedule();
    const first = port.acknowledge();
    const second = port.acknowledge();

    expect(first).toBe(second);
    await expect(first).rejects.toThrow('exit 75');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
