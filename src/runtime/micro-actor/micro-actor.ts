import { getCompiledActorDefinition } from './define-machine.js';
import type { ActorClassWithDefinition } from './define-machine.js';
import type { CompiledActorDefinition } from './types.js';

export class InternalActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalActorError';
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export type RunTaskOptions<Result = unknown> = {
  on_done?: (result: Result) => void;
  on_failed?: (error: Error) => void;
  on_timeout?: (error: TimeoutError) => void;
  on_done_event?: string;
  on_failed_event?: string;
  on_timeout_event?: string;
  timeout?: number;
};

type TaskResult = {
  id: number;
  ok: boolean;
  value: unknown;
  timedOut?: boolean;
};

type Task = {
  id: number;
  controller: AbortController;
  promise: Promise<TaskResult>;
  on_done: (result: unknown) => void;
  on_failed: (error: Error) => void;
  on_timeout?: (error: TimeoutError) => void;
};

export abstract class BaseActor {
  private definition: CompiledActorDefinition | undefined;
  private currentState: string | undefined;
  private nextEvent: string | undefined;
  private nextTaskId = 1;
  private stateTasks = new Map<number, Task>();
  private actorMainPromise: Promise<void> | undefined;

  state(): string {
    return this.currentState!;
  }

  start(): void {
    if (this.currentState !== undefined && !this.definition!.states.get(this.currentState)?.terminal) {
      throw new InternalActorError(`Cannot start actor from non-terminal state "${this.currentState}"`);
    }
    const definition = getCompiledActorDefinition(this.constructor as ActorClassWithDefinition);
    this.definition = definition;
    this.currentState = definition.initial;
    this.callHandler('enter');
    this.actorMainPromise = this.actorMain();
  }

  recover(state: string): void {
    if (this.currentState !== undefined) {
      throw new InternalActorError(`Cannot recover actor after it has entered state "${this.currentState}"`);
    }
    const definition = getCompiledActorDefinition(this.constructor as ActorClassWithDefinition);
    if (!definition.states.has(state)) {
      throw new InternalActorError(`Cannot recover actor to unknown state "${state}"`);
    }
    this.definition = definition;
    this.currentState = state;
    this.callHandler('recover') || this.callHandler('enter');
    this.actorMainPromise = this.actorMain();
  }

  protected _send_event(name: string): void {
    if (this.nextEvent !== undefined) {
      throw new InternalActorError(`Actor already has pending event "${this.nextEvent}", cannot send "${name}"`);
    }
    this.nextEvent = name;
  }

  protected _run_task<Result>(run: (signal: AbortSignal) => Promise<Result>, options?: RunTaskOptions<Result>): void {
    const currentState = this.currentState!;
    if (this.definition!.states.get(currentState)?.terminal) {
      throw new InternalActorError(`Cannot start task in terminal state "${currentState}"`);
    }
    const controller = new AbortController();
    const id = this.nextTaskId++;
    const timeout = options?.timeout === 0 ? undefined : options?.timeout;
    const promise = this.safeTask(id, run, controller, timeout);
    const on_done = options?.on_done ?? (() => this._send_event(options?.on_done_event ?? 'done'));
    const on_failed = options?.on_failed ?? (() => this._send_event(options?.on_failed_event ?? 'failed'));
    const on_timeout = options?.on_timeout ?? (options?.on_timeout_event ? (() => this._send_event(options.on_timeout_event!)) : undefined);
    this.stateTasks.set(id, { id, controller, promise, on_done: on_done as Task['on_done'], on_failed: on_failed as Task['on_failed'], on_timeout });
  }

  private dispatchEvent(eventName: string): string {
    const currentState = this.currentState!;
    const stateDef = this.definition!.states.get(currentState)!;

    const targetState = stateDef.on?.[eventName];
    if (targetState === undefined) return currentState;

    if (targetState === currentState) return currentState;

    this.callHandler('leave');
    for (const task of this.stateTasks.values()) {
      task.controller.abort();
    }
    this.stateTasks.clear();
    this.currentState = targetState;
    this.callHandler('enter');

    return targetState;
  }

  private async actorMain(): Promise<void> {
    for (;;) {
      const event = this.nextEvent;
      if (event !== undefined) {
        this.nextEvent = undefined;
        this.dispatchEvent(event);
        continue;
      }

      if (this.definition!.states.get(this.currentState!)?.terminal) {
        return;
      }

      if (this.stateTasks.size === 0) {
        throw new InternalActorError(`Actor stuck in non-terminal state "${this.currentState!}" with no pending tasks or events`);
      }

      const result = await Promise.race([...this.stateTasks.values()].map((t) => t.promise));
      const task = this.stateTasks.get(result.id)!;
      this.stateTasks.delete(result.id);

      if (result.timedOut && task.on_timeout) {
        task.on_timeout(result.value as TimeoutError);
      } else if (result.ok) {
        task.on_done(result.value);
      } else {
        task.on_failed(result.value as Error);
      }
    }
  }

  private async safeTask(taskId: number, run: (signal: AbortSignal) => Promise<unknown>, controller: AbortController, timeout?: number): Promise<TaskResult> {
    try {
      const task = run(controller.signal);
      const value = timeout === undefined
        ? await task
        : await this.withTimeout(task, controller, timeout);
      return { id: taskId, ok: true, value };
    } catch (error) {
      return { id: taskId, ok: false, value: error, timedOut: error instanceof TimeoutError };
    }
  }

  private async withTimeout<T>(task: Promise<T>, controller: AbortController, timeout: number): Promise<T> {
    let timeoutError: TimeoutError | undefined;
    const timer = setTimeout(() => {
      timeoutError = new TimeoutError(`Task timed out after ${timeout}ms`);
      controller.abort(timeoutError);
    }, timeout);
    try {
      const value = await task;
      if (timeoutError) throw timeoutError;
      return value;
    } catch (error) {
      throw timeoutError ?? error;
    } finally {
      clearTimeout(timer);
    }
  }

  private callHandler(hook: 'enter' | 'leave' | 'recover'): boolean {
    const method = this.getMethod(`_on_${hook}__${this.currentState!}`);
    if (method) {
      method.call(this);
      return true;
    }
    return false;
  }

  private getMethod(methodName: string): Function | undefined {
    const value = (this as unknown as Record<string, unknown>)[methodName];
    return typeof value === 'function' ? value : undefined;
  }
}
