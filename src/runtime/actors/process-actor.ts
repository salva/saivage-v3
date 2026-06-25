import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BaseActor } from '../micro-actor/index.js';
import type { ActorDefinition } from '../micro-actor/index.js';
import { processActorId } from './ids.js';
import { removeActorSnapshot, saveActorSnapshot } from './snapshots.js';
import { writeFileSyncDurable } from '../../persistence/index.js';

export const PROCESS_OUTPUT_TAIL_BYTES = 65536;

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

const processEvidenceSchema = z.object({
  schema_version: z.literal(1),
  processId: z.string().min(1),
  actorId: z.string().min(1),
  command: z.string().nullable(),
  args: z.array(z.string()),
  cwd: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  killReason: z.string().nullable(),
  output: z.object({ stdout: z.string(), stderr: z.string() }),
  recordedAt: z.string().datetime(),
});

export type ProcessEvidenceRecord = z.infer<typeof processEvidenceSchema>;

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
  #resolveSettled: ((outcome: ProcessWaitOutcome) => void) | null = null;
  #settledPromise: Promise<ProcessWaitOutcome> | null = null;

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
    this.#settledPromise = new Promise<ProcessWaitOutcome>((resolve) => { this.#resolveSettled = resolve; });
    this.#child = spawn(spec.command, this.args, { cwd: spec.cwd, env: spec.env, stdio: 'pipe' });
    this.pid = this.#child.pid ?? null;
    this.#child.stdout.setEncoding('utf8');
    this.#child.stderr.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => { this.stdout = boundedTail(this.stdout + chunk); });
    this.#child.stderr.on('data', (chunk: string) => { this.stderr = boundedTail(this.stderr + chunk); });
    this.#childExitPromise = new Promise<MonitorOutcome>((resolve) => {
      this.#child?.once('exit', (exitCode, signal) => resolve({ kind: 'exit', exitCode, signal }));
      this.#child?.once('error', (error) => {
        this.stderr = boundedTail(this.stderr + error.message);
        resolve({ kind: 'exit', exitCode: null, signal: null });
      });
    });
    const killPromise = new Promise<MonitorOutcome>((resolve) => { this.#requestKill = () => resolve({ kind: 'kill_requested' }); });
    this.#exitPromise = Promise.race([this.#childExitPromise, killPromise]);
    this.parkedSendEvent('launch');
  }

  async wait(timeoutMs = 0): Promise<ProcessWaitOutcome> {
    if (this.state() === 'settled') return this.settledOutcome();
    const settled = this.waitForSettled();
    if (timeoutMs <= 0) return settled;
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        settled,
        new Promise<ProcessWaitOutcome>((resolve) => { timer = setTimeout(() => resolve({ status: 'running', timedOut: true, output: this.inspect() }), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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

  _on_enter__settled(): void {
    writeProcessEvidence(this.projectRoot, this.evidence());
    removeActorSnapshot(this.projectRoot, processActorId(this.processId));
    this.releaseRuntimeHandles();
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
        stdout: boundedTail(this.stdout),
        stderr: boundedTail(this.stderr),
      },
      updated_at: new Date().toISOString(),
    };
  }

  evidence(): ProcessEvidenceRecord {
    return {
      schema_version: 1,
      processId: this.processId,
      actorId: processActorId(this.processId),
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      exitCode: this.exitCode,
      signal: this.signal,
      killReason: this.killReason,
      output: this.inspect({ stdoutTail: PROCESS_OUTPUT_TAIL_BYTES, stderrTail: PROCESS_OUTPUT_TAIL_BYTES }),
      recordedAt: new Date().toISOString(),
    };
  }

  private recordExit(outcome: MonitorOutcome): void {
    if (outcome.kind !== 'exit') throw new Error(`ProcessActor '${this.processId}' expected exit outcome.`);
    this.exitCode = outcome.exitCode;
    this.signal = outcome.signal;
    this.pid = null;
    this.completedAt = new Date().toISOString();
    this.#resolveSettled?.(this.settledOutcome());
    this.#resolveSettled = null;
    this.sendEvent('exited');
  }

  private async waitForSettled(): Promise<ProcessWaitOutcome> {
    if (!this.#settledPromise) throw new Error(`ProcessActor '${this.processId}' has no settled promise.`);
    return this.#settledPromise;
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

  private releaseRuntimeHandles(): void {
    this.#child?.stdout.removeAllListeners();
    this.#child?.stderr.removeAllListeners();
    this.#child?.removeAllListeners();
    this.#child = null;
    this.#childExitPromise = null;
    this.#exitPromise = null;
    this.#requestKill = null;
    this.#settledPromise = null;
    this.#resolveSettled = null;
  }
}

function tail(value: string, max: number | undefined): string {
  if (max === undefined || value.length <= max) return value;
  return value.slice(value.length - max);
}

function boundedTail(value: string): string {
  return tail(value, PROCESS_OUTPUT_TAIL_BYTES);
}

export function processEvidencePath(projectRoot: string, processId: string): string {
  return join(projectRoot, '.saivage', 'runtime', 'process-output', `${encodeURIComponent(processId)}.json`);
}

export function readProcessEvidence(projectRoot: string, processId: string): ProcessEvidenceRecord | null {
  const path = processEvidencePath(projectRoot, processId);
  if (!existsSync(path)) return null;
  return processEvidenceSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

function writeProcessEvidence(projectRoot: string, evidence: ProcessEvidenceRecord): void {
  processEvidenceSchema.parse(evidence);
  writeFileSyncDurable(processEvidencePath(projectRoot, evidence.processId), JSON.stringify(evidence, null, 2) + '\n');
}
