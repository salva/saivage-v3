import { watch as nodeWatch, type FSWatcher, type WatchOptions } from 'node:fs';
import type { EventEmitter } from 'node:events';

export interface Disposable {
  dispose(): Promise<void> | void;
}

export interface NamedDisposable extends Disposable {
  readonly name?: string;
}

export interface DisposalReport {
  scopeId: string;
  disposed: { name: string; durationMs: number }[];
  errors: { name: string; error: unknown }[];
}

export interface ScopedInterval extends Disposable { readonly name: string; }
export interface ScopedTimeout extends Disposable { readonly name: string; }
export interface ScopedListener extends Disposable { readonly name: string; }
export interface ScopedSignalHandler extends Disposable { readonly name: string; }
export interface ScopedFsWatch extends Disposable { readonly name: string; readonly watcher: FSWatcher; }

export type WatchHandler = (eventType: string, filename: string | Buffer | null) => void;

export interface ResourceScope {
  readonly id: string;
  add<T extends Disposable>(resource: T, opts?: { name?: string; timeoutMs?: number }): T;
  child(name: string): ResourceScope;
  setInterval(handler: () => void, ms: number, opts?: { name?: string; timeoutMs?: number }): ScopedInterval;
  setTimeout(handler: () => void, ms: number, opts?: { name?: string; timeoutMs?: number }): ScopedTimeout;
  on(emitter: EventEmitter, event: string | symbol, handler: (...args: unknown[]) => void, opts?: { name?: string; timeoutMs?: number }): ScopedListener;
  onSignal(signal: NodeJS.Signals, handler: () => Promise<void> | void, opts?: { name?: string; timeoutMs?: number }): ScopedSignalHandler;
  watch(path: string, handler: WatchHandler, opts?: WatchOptions & { name?: string; timeoutMs?: number }): ScopedFsWatch;
  dispose(): Promise<DisposalReport>;
  isDisposed(): boolean;
}

const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000;

export class ScopeDisposed extends Error {
  constructor(readonly scopeId: string) {
    super(`ResourceScope '${scopeId}' is disposed`);
    this.name = 'ScopeDisposed';
  }
}

interface RegisteredResource {
  name: string;
  timeoutMs: number;
  dispose: () => Promise<void> | void;
}

function resourceName(resource: Disposable, fallback: string): string {
  const candidate = (resource as NamedDisposable).name;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : fallback;
}

function timeoutError(name: string, timeoutMs: number): Error {
  return new Error(`Timed out disposing '${name}' after ${timeoutMs}ms`);
}

export function createResourceScope(id: string, opts?: { disposeTimeoutMs?: number }): ResourceScope {
  return new DefaultResourceScope(id, opts?.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS);
}

class DefaultResourceScope implements ResourceScope {
  private readonly resources: RegisteredResource[] = [];
  private readonly children: DefaultResourceScope[] = [];
  private disposed = false;
  private resourceCounter = 0;
  private childCounter = 0;
  private disposePromise: Promise<DisposalReport> | undefined;

  constructor(readonly id: string, private readonly defaultDisposeTimeoutMs: number) {}

  add<T extends Disposable>(resource: T, opts?: { name?: string; timeoutMs?: number }): T {
    this.assertOpen();
    const name = opts?.name ?? resourceName(resource, `resource-${++this.resourceCounter}`);
    this.resources.push({
      name,
      timeoutMs: opts?.timeoutMs ?? this.defaultDisposeTimeoutMs,
      dispose: () => resource.dispose(),
    });
    return resource;
  }

  child(name: string): ResourceScope {
    this.assertOpen();
    const child = new DefaultResourceScope(`${this.id}/${name || `child-${++this.childCounter}`}`, this.defaultDisposeTimeoutMs);
    this.children.push(child);
    return child;
  }

  setInterval(handler: () => void, ms: number, opts?: { name?: string; timeoutMs?: number }): ScopedInterval {
    this.assertOpen();
    const timer = setInterval(handler, ms);
    timer.unref?.();
    return this.add({
      name: opts?.name ?? 'interval',
      dispose: () => clearInterval(timer),
    }, opts);
  }

  setTimeout(handler: () => void, ms: number, opts?: { name?: string; timeoutMs?: number }): ScopedTimeout {
    this.assertOpen();
    const timer = setTimeout(handler, ms);
    timer.unref?.();
    return this.add({
      name: opts?.name ?? 'timeout',
      dispose: () => clearTimeout(timer),
    }, opts);
  }

  on(emitter: EventEmitter, event: string | symbol, handler: (...args: unknown[]) => void, opts?: { name?: string; timeoutMs?: number }): ScopedListener {
    this.assertOpen();
    emitter.on(event, handler);
    return this.add({
      name: opts?.name ?? `listener:${String(event)}`,
      dispose: () => { emitter.removeListener(event, handler); },
    }, opts);
  }

  onSignal(signal: NodeJS.Signals, handler: () => Promise<void> | void, opts?: { name?: string; timeoutMs?: number }): ScopedSignalHandler {
    this.assertOpen();
    process.on(signal, handler);
    return this.add({
      name: opts?.name ?? `signal:${signal}`,
      dispose: () => { process.removeListener(signal, handler); },
    }, opts);
  }

  watch(path: string, handler: WatchHandler, opts?: WatchOptions & { name?: string; timeoutMs?: number }): ScopedFsWatch {
    this.assertOpen();
    const { name, timeoutMs, ...watchOpts } = opts ?? {};
    const watcher = nodeWatch(path, watchOpts, handler);
    return this.add({
      name: name ?? `watch:${path}`,
      watcher,
      dispose: () => watcher.close(),
    }, { name: name ?? `watch:${path}`, timeoutMs });
  }

  async dispose(): Promise<DisposalReport> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.disposeOnce();
    return this.disposePromise;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  private async disposeOnce(): Promise<DisposalReport> {
    const report: DisposalReport = { scopeId: this.id, disposed: [], errors: [] };

    for (const child of [...this.children].reverse()) {
      const childStarted = Date.now();
      const childReport = await child.dispose();
      report.disposed.push({ name: child.id, durationMs: Date.now() - childStarted });
      report.disposed.push(...childReport.disposed);
      report.errors.push(...childReport.errors);
    }

    for (const resource of [...this.resources].reverse()) {
      const started = Date.now();
      try {
        await this.disposeWithTimeout(resource);
      } catch (error) {
        report.errors.push({ name: resource.name, error });
      }
      report.disposed.push({ name: resource.name, durationMs: Date.now() - started });
    }

    this.children.length = 0;
    this.resources.length = 0;
    return report;
  }

  private async disposeWithTimeout(resource: RegisteredResource): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve(resource.dispose()),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(timeoutError(resource.name, resource.timeoutMs)), resource.timeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new ScopeDisposed(this.id);
  }
}
