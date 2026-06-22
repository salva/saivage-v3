import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { BaseActor } from '../micro-actor/index.js';
import type { ActorDefinition } from '../micro-actor/index.js';
import { processActorId } from './ids.js';
import { saveActorSnapshot } from './snapshots.js';

export interface ProcessLaunchSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProcessOutputProjection {
  stdout: string;
  stderr: string;
}

export type ProcessWaitOutcome =
  | { status: 'running'; timedOut: true; output: ProcessOutputProjection }
  | { status: 'settled'; exitCode: number | null; signal: NodeJS.Signals | null; output: ProcessOutputProjection };

type MonitorOutcome =
  | { kind: 'exit'; exitCode: number | null; signal: NodeJS.Signals | null }
  | { kind: 'kill_requested' };

export class ProcessActor extends BaseActor {
  static _actor: ActorDefinition = {
    initial: 'idle',
    states: {
      idle: { parked: true, on: { launch: 'running' } },
      running: { on: { kill: 'killing', exited: 'settled' } },
      killing: { on: { exited: 'settled' } },
      settled: { terminal: true },
    },
  };

  readonly projectRoot: string;
  readonly processId: string;
  command: string | null = null;
  args: string[] = [];
  cwd: string | null = null;
  pid: number | null = null;
  startedAt: string | null = null;
  completedAt: string | null = null;
  exitCode: number | null = null;
  signal: NodeJS.Signals | null = null;
  killReason: string | null = null;
  stdout = '';
  stderr = '';
  #child: ChildProcessWithoutNullStreams | null = null;
  #childExitPromise: Promise<MonitorOutcome> | null = null;
  #exitPromise: Promise<MonitorOutcome> | null = null;
  #requestKill: (() => void) | null = null;

  constructor(args: { projectRoot: string; processId: string }) {
    super();
    this.projectRoot = args.projectRoot;
    this.processId = args.processId;
  }

  launch(spec: ProcessLaunchSpec): void {
    if (this.state() !== 'idle') throw new Error(`ProcessActor '${this.processId}' cannot launch from '${this.state()}'.`);
    this.command = spec.command;
    this.args = spec.args ?? [];
    this.cwd = spec.cwd ?? null;
    this.startedAt = new Date().toISOString();
    this.completedAt = null;
    this.exitCode = null;
    this.signal = null;
    this.killReason = null;
    this.stdout = '';
    this.stderr = '';
    this.#child = spawn(spec.command, this.args, { cwd: spec.cwd, env: spec.env, stdio: 'pipe' });
    this.pid = this.#child.pid ?? null;
    this.#child.stdout.setEncoding('utf8');
    this.#child.stderr.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => { this.stdout += chunk; this.persist(); });
    this.#child.stderr.on('data', (chunk: string) => { this.stderr += chunk; this.persist(); });
    this.#childExitPromise = new Promise<MonitorOutcome>((resolve) => {
      this.#child?.once('exit', (exitCode, signal) => resolve({ kind: 'exit', exitCode, signal }));
      this.#child?.once('error', (error) => {
        this.stderr += error.message;
        resolve({ kind: 'exit', exitCode: null, signal: null });
      });
    });
    const killPromise = new Promise<MonitorOutcome>((resolve) => { this.#requestKill = () => resolve({ kind: 'kill_requested' }); });
    this.#exitPromise = Promise.race([this.#childExitPromise, killPromise]);
    this.parkedSendEvent('launch');
    this.persist();
  }

  async wait(timeoutMs = 0): Promise<ProcessWaitOutcome> {
    if (this.state() === 'settled') return this.settledOutcome();
    const settled = this.waitForSettled();
    if (timeoutMs <= 0) return settled;
    return Promise.race([
      settled,
      new Promise<ProcessWaitOutcome>((resolve) => setTimeout(() => resolve({ status: 'running', timedOut: true, output: this.inspect() }), timeoutMs)),
    ]);
  }

  inspect(range?: { stdoutTail?: number; stderrTail?: number }): ProcessOutputProjection {
    return {
      stdout: tail(this.stdout, range?.stdoutTail),
      stderr: tail(this.stderr, range?.stderrTail),
    };
  }

  kill(reason: string, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.state() === 'settled') return;
    if (!this.#child || this.#child.killed) return;
    this.killReason = reason;
    this.#child.kill(signal);
    this.#requestKill?.();
    this.persist();
  }

  _on_enter__running(): void {
    this.runTask(async () => this.requireExitPromise(), {
      on_done: (outcome) => {
        if (outcome.kind === 'kill_requested') this.sendEvent('kill');
        else this.recordExit(outcome);
      },
    });
  }

  _on_enter__killing(): void {
    this.#exitPromise = this.#childExitPromise;
    this.runTask(async () => this.requireExitPromise(), { on_done: (outcome) => this.recordExit(outcome) });
  }

  protected override _on_state_changed(_oldState: string | undefined, _newState: string): void {
    this.persist();
  }

  snapshot() {
    return {
      actor_id: processActorId(this.processId),
      actor_kind: 'process' as const,
      state_value: this.state(),
      context: {
        projectRoot: this.projectRoot,
        processId: this.processId,
        command: this.command,
        args: this.args,
        cwd: this.cwd,
        pid: this.pid,
        startedAt: this.startedAt,
        completedAt: this.completedAt,
        exitCode: this.exitCode,
        signal: this.signal,
        killReason: this.killReason,
        stdout: this.stdout,
        stderr: this.stderr,
      },
      updated_at: new Date().toISOString(),
    };
  }

  private recordExit(outcome: MonitorOutcome): void {
    if (outcome.kind !== 'exit') throw new Error(`ProcessActor '${this.processId}' expected exit outcome.`);
    this.exitCode = outcome.exitCode;
    this.signal = outcome.signal;
    this.pid = null;
    this.completedAt = new Date().toISOString();
    this.sendEvent('exited');
  }

  private async waitForSettled(): Promise<ProcessWaitOutcome> {
    while (this.state() !== 'settled') await new Promise((resolve) => setTimeout(resolve, 0));
    return this.settledOutcome();
  }

  private settledOutcome(): ProcessWaitOutcome {
    return { status: 'settled', exitCode: this.exitCode, signal: this.signal, output: this.inspect() };
  }

  private requireExitPromise(): Promise<MonitorOutcome> {
    if (!this.#exitPromise) throw new Error(`ProcessActor '${this.processId}' has no monitor promise.`);
    return this.#exitPromise;
  }

  private persist(): void {
    saveActorSnapshot(this.projectRoot, this.snapshot());
  }
}

function tail(value: string, max: number | undefined): string {
  if (max === undefined || value.length <= max) return value;
  return value.slice(value.length - max);
}
