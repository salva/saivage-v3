import type { RestartPort } from '../../src/boot/restart-port.js';

export function createTestRestartPort(): RestartPort {
  let scheduled = false;
  return {
    schedule(): void {
      scheduled = true;
    },
    async acknowledge(): Promise<void> {
      if (!scheduled) throw new Error('Server restart has not been scheduled.');
    },
  };
}
