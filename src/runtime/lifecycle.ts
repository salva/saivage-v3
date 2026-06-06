import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';

export type RuntimeResourceKind = 'timer' | 'listener' | 'child_process' | 'stream' | 'disposable';
export type RuntimeDisposeStatus = 'cleared' | 'removed' | 'killed' | 'closed' | 'detached' | 'failed' | 'noop';

export interface RuntimeDisposeReportEntry {
  id: string;
  kind: RuntimeResourceKind;
  status: RuntimeDisposeStatus;
  label?: string;
  error?: string;
}

export interface RuntimeLifecycleSnapshot {
  scopeId: string;
  disposed: boolean;
  resources: Array<{ id: string; kind: RuntimeResourceKind; label?: string }>;
}

export interface RuntimeResourceHandle {
  id: string;
  kind: RuntimeResourceKind;
  label?: string;
  unregister(): void;
  dispose(): Promise<RuntimeDisposeReportEntry>;
}

interface RuntimeResourceRegistration {
  id?: string;
  kind: RuntimeResourceKind;
  label?: string;
  dispose: () => RuntimeDisposeStatus | RuntimeDisposeReportEntry | Promise<RuntimeDisposeStatus | RuntimeDisposeReportEntry>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RuntimeLifecycleScope {
  private readonly resources = new Map<string, RuntimeResourceRegistration & { id: string }>();
  private disposed = false;
  private counter = 0;

  constructor(readonly scopeId: string) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  register(registration: RuntimeResourceRegistration): RuntimeResourceHandle {
    if (this.disposed) {
      throw new Error(`runtime lifecycle scope ${this.scopeId} is disposed`);
    }
    const id = registration.id ?? `${registration.kind}-${++this.counter}`;
    const stored = { ...registration, id };
    this.resources.set(id, stored);
    const disposeOne = async (): Promise<RuntimeDisposeReportEntry> => {
      if (!this.resources.has(id)) {
        return { id, kind: stored.kind, label: stored.label, status: 'noop' };
      }
      this.resources.delete(id);
      try {
        const result = await stored.dispose();
        if (typeof result === 'string') {
          return { id, kind: stored.kind, label: stored.label, status: result };
        }
        return { ...result, id: result.id || id, kind: result.kind || stored.kind, label: result.label ?? stored.label };
      } catch (error) {
        return { id, kind: stored.kind, label: stored.label, status: 'failed', error: errorMessage(error) };
      }
    };
    return {
      id,
      kind: stored.kind,
      label: stored.label,
      unregister: () => {
        this.resources.delete(id);
      },
      dispose: disposeOne,
    };
  }

  registerTimer(timer: NodeJS.Timeout, label?: string, id?: string): RuntimeResourceHandle {
    return this.register({
      id,
      kind: 'timer',
      label,
      dispose: () => {
        clearTimeout(timer);
        return 'cleared';
      },
    });
  }

  registerListener(emitter: EventEmitter, eventName: string | symbol, listener: (...args: unknown[]) => void, label?: string, id?: string): RuntimeResourceHandle {
    return this.register({
      id,
      kind: 'listener',
      label,
      dispose: () => {
        emitter.removeListener(eventName, listener);
        return 'removed';
      },
    });
  }

  registerChildProcess(child: ChildProcess, policy: 'kill' | 'detach' = 'kill', label?: string, id?: string): RuntimeResourceHandle {
    return this.register({
      id,
      kind: 'child_process',
      label,
      dispose: () => {
        if (policy === 'detach') return 'detached';
        if (child.killed || child.exitCode !== null || child.signalCode !== null) return 'noop';
        try {
          if (child.pid) {
            try {
              process.kill(-child.pid, 'SIGTERM');
            } catch {
              child.kill('SIGTERM');
            }
            return 'killed';
          }
          return child.kill('SIGTERM') ? 'killed' : 'noop';
        } catch (error) {
          return { id: id ?? '', kind: 'child_process', label, status: 'failed', error: errorMessage(error) };
        }
      },
    });
  }

  registerStream(stream: Writable, label?: string, id?: string): RuntimeResourceHandle {
    return this.register({
      id,
      kind: 'stream',
      label,
      dispose: () => new Promise<RuntimeDisposeStatus>((resolve) => {
        if (stream.destroyed) {
          resolve('noop');
          return;
        }
        const done = () => resolve('closed');
        stream.once('close', done);
        const safety = setTimeout(() => {
          stream.removeListener('close', done);
          resolve('closed');
        }, 5000);
        safety.unref();
        stream.once('close', () => clearTimeout(safety));
        try {
          stream.end();
        } catch {
          try {
            stream.destroy();
          } catch { void 0; }
          resolve('closed');
        }
      }),
    });
  }

  snapshot(): RuntimeLifecycleSnapshot {
    return {
      scopeId: this.scopeId,
      disposed: this.disposed,
      resources: Array.from(this.resources.values()).map(({ id, kind, label }) => ({ id, kind, label })),
    };
  }

  async dispose(): Promise<RuntimeDisposeReportEntry[]> {
    if (this.disposed && this.resources.size === 0) return [];
    this.disposed = true;
    const report: RuntimeDisposeReportEntry[] = [];
    const resources = Array.from(this.resources.values()).reverse();
    for (const resource of resources) {
      report.push(await this.disposeRegisteredResource(resource));
    }
    return report;
  }

  private async disposeRegisteredResource(resource: RuntimeResourceRegistration & { id: string }): Promise<RuntimeDisposeReportEntry> {
    this.resources.delete(resource.id);
    try {
      const result = await resource.dispose();
      if (typeof result === 'string') return { id: resource.id, kind: resource.kind, label: resource.label, status: result };
      return { ...result, id: result.id || resource.id, kind: result.kind || resource.kind, label: result.label ?? resource.label };
    } catch (error) {
      return { id: resource.id, kind: resource.kind, label: resource.label, status: 'failed', error: errorMessage(error) };
    }
  }

}

export function createRuntimeLifecycleScope(scopeId: string): RuntimeLifecycleScope {
  return new RuntimeLifecycleScope(scopeId);
}
