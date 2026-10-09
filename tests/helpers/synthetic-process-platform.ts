import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { ManagedProcessPlatform } from '../../src/runtime/managed-process-group-registry.js';

export function processErrno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** No OS children or signals. Each exact synthetic PGID has independently controlled truth. */
export class SyntheticProcessPlatform implements ManagedProcessPlatform {
  readonly children: Array<
    ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }
  > = [];
  readonly states = new Map<number, 'live' | 'EPERM' | 'ESRCH'>();
  readonly operations: string[] = [];
  dispatchError: string | null = null;
  onSpawn?: (
    child: ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough },
  ) => void;
  spawn(): ChildProcess {
    const pid = 4200 + this.children.length;
    const child = Object.assign(new EventEmitter(), {
      pid,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    }) as unknown as ChildProcess & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    this.children.push(child);
    this.states.set(pid, 'live');
    this.onSpawn?.(child);
    return child;
  }
  probe(pgid: number): void {
    this.operations.push(`probe:${pgid}`);
    const state = this.states.get(pgid)!;
    if (state !== 'live') throw processErrno(state);
  }
  signal(pgid: number, signal: NodeJS.Signals): void {
    this.operations.push(`${signal}:${pgid}`);
    if (this.dispatchError) throw processErrno(this.dispatchError);
    this.states.set(pgid, 'ESRCH');
    const child = this.children.find((child) => child.pid === pgid)!;
    child.emit('exit', 0, null);
    child.stdout.end();
    child.stderr.end();
  }
  destroy(): void {
    for (const child of this.children) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
}
