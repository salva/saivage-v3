import type { ChildProcess } from 'node:child_process';

export function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export async function waitForProcessGroupAbsence(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

export async function terminateProcessGroup(pgid: number, graceMs: number): Promise<void> {
  signalProcessGroup(pgid, 'SIGTERM');
  if (await waitForProcessGroupAbsence(pgid, graceMs)) return;
  signalProcessGroup(pgid, 'SIGKILL');
  await waitForProcessGroupAbsence(pgid, graceMs);
}

export function processGroupId(child: ChildProcess): number {
  if (!child.pid) throw new Error('Managed process group requires a child PID.');
  return child.pid;
}
