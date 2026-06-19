import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { SlaveActor } from '../micro-actor/index.js';
import { processActorId } from './ids.js';
import { saveActorSnapshot } from './snapshots.js';

export interface ProcessRunnerStartInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProcessOutputSnapshot {
  stdout: string;
  stderr: string;
}

export type ProcessWaitResult =
  | { status: 'running'; timedOut: true; output: ProcessOutputSnapshot }
  | { status: 'done'; exitCode: number | null; signal: NodeJS.Signals | null; output: ProcessOutputSnapshot };

export interface ProcessRunnerContext {
  projectRoot: string;
  processId: string;
  command: string | null;
  args: string[];
  pid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

type StartedArgs = { command: string; args: string[]; pid: number | null };
type OutputArgs = { stdout?: string; stderr?: string };
type ExitedArgs = { exitCode: number | null; signal: NodeJS.Signals | null };

export class ProcessRunnerActor extends SlaveActor {
  static _actor = {
    initial: 'done',
    states: {
      done: {
        on: { started: 'running' },
      },
      running: {
        on: { exited: 'done' },
      },
    },
  };

  command: string | null = null;
  args: string[] = [];
  pid: number | null = null;
  exitCode: number | null = null;
  signal: NodeJS.Signals | null = null;
  stdout = '';
  stderr = '';

  constructor(readonly projectRoot: string, readonly processId: string) {
    super();
  }

  recordStarted(args: StartedArgs): void {
    this.command = args.command;
    this.args = args.args;
    this.pid = args.pid;
    this.exitCode = null;
    this.signal = null;
    this.stdout = '';
    this.stderr = '';
    this.sendEvent('started');
  }

  recordOutput(args: OutputArgs): void {
    this.stdout += args.stdout ?? '';
    this.stderr += args.stderr ?? '';
  }

  recordExited(args: ExitedArgs): void {
    this.exitCode = args.exitCode;
    this.signal = args.signal;
    this.pid = null;
    this.sendEvent('exited');
  }

  _on_enter__running(): void {
    this.persist();
  }

  _on_enter__done(): void {
    this.persist();
  }

  context(): ProcessRunnerContext {
    return {
      projectRoot: this.projectRoot,
      processId: this.processId,
      command: this.command,
      args: this.args,
      pid: this.pid,
      exitCode: this.exitCode,
      signal: this.signal,
      stdout: this.stdout,
      stderr: this.stderr,
    };
  }

  snapshot() {
    return {
      actor_id: processActorId(this.processId),
      actor_kind: 'process' as const,
      state_value: this.state(),
      context: this.context() as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    };
  }

  private persist(): void {
    saveActorSnapshot(this.projectRoot, this.snapshot());
  }
}

export class ProcessRunnerController {
  private readonly actor: ProcessRunnerActor;
  private child: ChildProcessWithoutNullStreams | null = null;
  private exitPromise: Promise<ProcessWaitResult> | null = null;

  constructor(projectRoot: string, readonly processId: string) {
    const actor = new ProcessRunnerActor(projectRoot, processId);
    actor.start();
    this.actor = actor;
  }

  async start(input: ProcessRunnerStartInput): Promise<void> {
    if (this.state === 'running') throw new Error(`ProcessRunner ${this.processId} is already running.`);
    this.child = spawn(input.command, input.args ?? [], {
      cwd: input.cwd,
      env: input.env,
      stdio: 'pipe',
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.actor.recordOutput({ stdout: chunk });
    });
    this.child.stderr.on('data', (chunk: string) => {
      this.actor.recordOutput({ stderr: chunk });
    });
    this.exitPromise = new Promise((resolve) => {
      this.child?.once('exit', async (exitCode, signal) => {
        this.actor.recordExited({ exitCode, signal });
        await waitForActorState(this.actor, 'done');
        resolve({ status: 'done', exitCode, signal, output: this.readOutput() });
      });
    });
    this.actor.recordStarted({ command: input.command, args: input.args ?? [], pid: this.child.pid ?? null });
    await waitForActorState(this.actor, 'running');
  }

  async wait(timeoutMs: number): Promise<ProcessWaitResult> {
    if (this.state !== 'running') {
      await waitForActorState(this.actor, 'done');
      const context = this.actor.context();
      return { status: 'done', exitCode: context.exitCode, signal: context.signal, output: this.readOutput() };
    }
    if (!this.exitPromise) throw new Error(`ProcessRunner ${this.processId} is running without an exit promise.`);
    const timeout = new Promise<ProcessWaitResult>((resolve) => {
      setTimeout(() => resolve({ status: 'running', timedOut: true, output: this.readOutput() }), timeoutMs);
    });
    return Promise.race([this.exitPromise, timeout]);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.child && this.state === 'running') this.child.kill(signal);
  }

  readOutput(): ProcessOutputSnapshot {
    const context = this.actor.context();
    return { stdout: context.stdout, stderr: context.stderr };
  }

  get state(): 'running' | 'done' {
    return this.actor.state() as 'running' | 'done';
  }

  snapshot() {
    return {
      actor_id: processActorId(this.processId),
      actor_kind: 'process' as const,
      state_value: this.actor.state(),
      context: this.actor.context() as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    };
  }

  private persist(): void {
    saveActorSnapshot(this.actor.projectRoot, this.snapshot());
  }
}

async function waitForActorState(actor: { state(): string }, state: string): Promise<void> {
  while (actor.state() !== state) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
