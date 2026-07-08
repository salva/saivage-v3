import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { ChildProcess } from 'node:child_process';

import { createRuntimeLifecycleScope } from '../../src/runtime/lifecycle.js';

describe('RuntimeLifecycleScope child processes', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('kill policy signals only the ChildProcess handle', async () => {
    const processKill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const childKill = jest.fn<ChildProcess['kill']>().mockReturnValue(true);
    const child = {
      pid: 12345,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: childKill,
    } as unknown as ChildProcess;
    const scope = createRuntimeLifecycleScope('test-child-kill');

    scope.registerChildProcess(child, 'kill', 'child');
    const report = await scope.dispose();

    expect(processKill).not.toHaveBeenCalled();
    expect(childKill).toHaveBeenCalledWith('SIGTERM');
    expect(report).toEqual([expect.objectContaining({ status: 'killed' })]);
  });
});
