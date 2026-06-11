import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { assign, createActor, createMachine } from 'xstate';
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

interface ProcessRunnerContext {
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

type ProcessRunnerEvent =
  | { type: 'STARTED'; command: string; args: string[]; pid: number | null }
  | { type: 'OUTPUT'; stdout?: string; stderr?: string }
  | { type: 'EXITED'; exitCode: number | null; signal: NodeJS.Signals | null };

const processRunnerMachine = createMachine({
  types: {} as {
    context: ProcessRunnerContext;
    events: ProcessRunnerEvent;
  },
  id: 'processRunner',
  initial: 'done',
  context: ({ input }: { input: { projectRoot: string; processId: string } }) => ({
    projectRoot: input.projectRoot,
    processId: input.processId,
    command: null,
    args: [],
    pid: null,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
  }),
  states: {
    done: {
      on: {
        STARTED: {
          target: 'running',
          actions: assign({
            command: ({ event }) => event.command,
            args: ({ event }) => event.args,
            pid: ({ event }) => event.pid,
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: '',
          }),
        },
      },
    },
    running: {
      on: {
        OUTPUT: {
          actions: assign({
            stdout: ({ context, event }) => context.stdout + (event.stdout ?? ''),
            stderr: ({ context, event }) => context.stderr + (event.stderr ?? ''),
          }),
        },
        EXITED: {
          target: 'done',
          actions: assign({
            exitCode: ({ event }) => event.exitCode,
            signal: ({ event }) => event.signal,
            pid: null,
          }),
        },
      },
    },
  },
});

export class ProcessRunnerController {
  private readonly actor;
  private child: ChildProcessWithoutNullStreams | null = null;
  private exitPromise: Promise<ProcessWaitResult> | null = null;

  constructor(projectRoot: string, readonly processId: string) {
    this.actor = createActor(processRunnerMachine, { input: { projectRoot, processId } });
    this.actor.start();
  }

  start(input: ProcessRunnerStartInput): void {
    if (this.state === 'running') throw new Error(`ProcessRunner ${this.processId} is already running.`);
    this.child = spawn(input.command, input.args ?? [], {
      cwd: input.cwd,
      env: input.env,
      stdio: 'pipe',
    });
    this.actor.send({ type: 'STARTED', command: input.command, args: input.args ?? [], pid: this.child.pid ?? null });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.actor.send({ type: 'OUTPUT', stdout: chunk });
      this.persist();
    });
    this.child.stderr.on('data', (chunk: string) => {
      this.actor.send({ type: 'OUTPUT', stderr: chunk });
      this.persist();
    });
    this.exitPromise = new Promise((resolve) => {
      this.child?.once('exit', (exitCode, signal) => {
        this.actor.send({ type: 'EXITED', exitCode, signal });
        this.persist();
        resolve({ status: 'done', exitCode, signal, output: this.readOutput() });
      });
    });
    this.persist();
  }

  async wait(timeoutMs: number): Promise<ProcessWaitResult> {
    if (this.state !== 'running') {
      const context = this.actor.getSnapshot().context;
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
    const context = this.actor.getSnapshot().context;
    return { stdout: context.stdout, stderr: context.stderr };
  }

  get state(): 'running' | 'done' {
    return this.actor.getSnapshot().value as 'running' | 'done';
  }

  snapshot() {
    const snapshot = this.actor.getSnapshot();
    return {
      actor_id: processActorId(this.processId),
      actor_kind: 'process' as const,
      state_value: snapshot.value,
      context: snapshot.context as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    };
  }

  private persist(): void {
    saveActorSnapshot(this.actor.getSnapshot().context.projectRoot, this.snapshot());
  }
}
