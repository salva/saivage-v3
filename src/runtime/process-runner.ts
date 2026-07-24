import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import { cardProcessOutputRoot, nonCardProcessOutputRoot } from '../persistence/layout.js';
import type { ProcessStatus } from '../schemas/index.js';
import { now } from '../utils/clock.js';
import { redactCommandForPolicy, sanitizedCommandEnv } from './command-policy.js';
import { replaceFile, type ReplacementFileIo } from '../persistence/replace-file.js';
import { PublicationOutcomeUnknownError, type ApplicationFatalPort } from '../contracts/index.js';
import {
  ManagedProcessGroupRegistry,
  type ManagedProcessScope,
  type ProcessCategory,
  type ProcessStopReport,
} from './managed-process-group-registry.js';

export interface ProcessSpawnSpec {
  command: string;
  directScope: ManagedProcessScope;
  category: ProcessCategory;
  cardId?: string | null;
  ownerId: string;
  ownerKind: 'agent' | 'operator' | 'runtime';
  cwd?: string;
  env?: Record<string, string>;
  agentSessionId?: string;
}

export interface InteractiveProcessSpawnSpec extends Omit<ProcessSpawnSpec, 'command' | 'env'> {
  file: string;
  args: readonly string[];
  stdio: SpawnOptions['stdio'];
  env: NodeJS.ProcessEnv;
}

export interface ProcessRecord {
  id: string;
  card_id: string | null;
  owner_id: string;
  owner_kind: 'agent' | 'operator' | 'runtime';
  agent_session_id: string | null;
  command: string;
  cwd: string;
  status: ProcessStatus;
  started_at: string;
  completed_at: string | null;
  exit_code: number | null;
  signal: string | null;
  stdout_path: string;
  stderr_path: string;
}

export interface InteractiveProcessLaunch {
  record: ProcessRecord;
  process: ChildProcess;
}

export interface ProcessWaitResult {
  id: string;
  status: ProcessStatus;
  exitCode: number | null;
  timedOut: boolean;
  waitDurationMs: number;
}

export interface ProcessListFilter {
  cardId?: string;
  status?: ProcessStatus | ProcessStatus[];
}

interface ProcessPresentation {
  record: ProcessRecord;
  leaderOutcome: Pick<ProcessRecord, 'status' | 'exit_code' | 'signal'> | null;
  terminationReason: string | null | undefined;
  terminalSettlement: Promise<void>;
}

export interface ProcessOutputIo { open: typeof openSync; stat: typeof fstatSync; write: typeof writeSync; fsync: typeof fsyncSync; close: typeof closeSync }
const processOutputIo: ProcessOutputIo = { open: openSync, stat: fstatSync, write: writeSync, fsync: fsyncSync, close: closeSync };

export function appendProcessOutputChunk(path: string, chunk: Uint8Array, io: ProcessOutputIo = processOutputIo): void {
  const bytes = Buffer.from(chunk);
  if (bytes.byteLength === 0) return;
  const fd = io.open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!io.stat(fd).isFile()) throw new Error(`Process output target '${path}' must be a regular file.`); }
  catch (error) { try { io.close(fd); } catch { /* pre-publication admission failure remains authoritative */ } throw error; }
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      let written: number;
      try { written = io.write(fd, bytes, offset, bytes.byteLength - offset); }
      catch (error) {
        if (offset === 0 && (error as NodeJS.ErrnoException & { bytesWritten?: number }).code === 'EINTR' && (error as { bytesWritten?: number }).bytesWritten === 0) continue;
        throw error;
      }
      if (written === 0) throw new Error('zero progress');
      offset += written;
    }
    io.fsync(fd);
    io.close(fd);
  } catch { throw new PublicationOutcomeUnknownError(); }
}

function generateId(): string {
  return `proc-${randomBytes(6).toString('hex')}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ProcessRunner {
  private readonly presentations = new Map<string, ProcessPresentation>();
  readonly #registry: ManagedProcessGroupRegistry;
  readonly #outputIo: ProcessOutputIo | undefined;
  readonly #replacementIo: ReplacementFileIo | undefined;

  constructor(readonly projectRoot: string, registry: ManagedProcessGroupRegistry, readonly fatalPort: ApplicationFatalPort, io: { readonly output?: ProcessOutputIo; readonly replacement?: ReplacementFileIo } = {}) {
    this.#registry = registry;
    this.#outputIo = io.output;
    this.#replacementIo = io.replacement;
  }

  spawn(spec: ProcessSpawnSpec): ProcessRecord {
    return this.launch(spec, 'bash', ['-c', spec.command], ['ignore', 'pipe', 'pipe'], true, { ...sanitizedCommandEnv(), PROJECT_ROOT: this.projectRoot, SAIVAGE_ROOT: this.projectRoot, ...spec.env }).record;
  }

  spawnInteractive(spec: InteractiveProcessSpawnSpec): InteractiveProcessLaunch {
    const command = [spec.file, ...spec.args].join(' ');
    return this.launch({ ...spec, command, env: undefined }, spec.file, spec.args, spec.stdio, false, spec.env);
  }

  async wait(procId: string, timeoutMs = 0): Promise<ProcessWaitResult> {
    const started = Date.now();
    const presentation = this.presentations.get(procId);
    if (!presentation) return { id: procId, status: 'failed', exitCode: null, timedOut: false, waitDurationMs: Date.now() - started };
    if (presentation.record.status !== 'running') return this.waitResult(procId, false, started);
    if (timeoutMs === 0) return this.waitResult(procId, false, started);
    const result = await Promise.race([presentation.terminalSettlement.then(() => 'settled' as const), delay(timeoutMs).then(() => 'timeout' as const)]);
    if (result === 'timeout') return this.waitResult(procId, true, started);
    return this.waitResult(procId, false, started);
  }

  async waitForSettlement(procId: string): Promise<ProcessWaitResult> {
    const started = Date.now();
    const presentation = this.presentations.get(procId);
    if (!presentation) return { id: procId, status: 'failed', exitCode: null, timedOut: false, waitDurationMs: 0 };
    await presentation.terminalSettlement;
    return this.waitResult(procId, false, started);
  }

  async kill(procId: string, authority: { directScope: ManagedProcessScope; category: ProcessCategory; reason?: string; graceMs?: number }): Promise<ProcessRecord | null> {
    const record = this.get(procId);
    if (!record) return null;
    const report = await this.#registry.terminateGroup({
      groupId: procId,
      directScope: authority.directScope,
      category: authority.category,
      reason: authority.reason ?? 'process killed',
      graceMs: authority.graceMs,
    });
    await this.#joinStopped(report);
    this.assertStopSucceeded(report);
    return this.get(procId);
  }

  async terminateScopeTree(input: { rootScope: ManagedProcessScope; categories: readonly ProcessCategory[]; reason: string; graceMs?: number }): Promise<ProcessStopReport> {
    const report = await this.#registry.terminateScopeTree(input);
    await this.#joinStopped(report);
    return report;
  }

  async closeAndTerminateDirectScope(input: { directScope: ManagedProcessScope; category: ProcessCategory; reason: string; graceMs?: number }): Promise<ProcessStopReport> {
    const report = await this.#registry.closeAndTerminateDirectScope(input);
    await this.#joinStopped(report);
    return report;
  }

  closeLaunchAdmission(): void { this.#registry.closeLaunchAdmission(); }

  closeScope(scope: ManagedProcessScope): void {
    this.#registry.closeScope(scope);
  }

  createContainerScope(parent: ManagedProcessScope, label: string): ManagedProcessScope {
    return this.#registry.createContainerScope(parent, label);
  }

  createDirectScope(parent: ManagedProcessScope, label: string, category: ProcessCategory): ManagedProcessScope {
    return this.#registry.createDirectScope(parent, label, category);
  }

  list(filter?: ProcessListFilter): ProcessRecord[] {
    let records = [...this.presentations.values()].map(({ record }) => ({ ...record }));
    if (filter?.cardId) records = records.filter((record) => record.card_id === filter.cardId);
    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      records = records.filter((record) => statuses.includes(record.status));
    }
    return records;
  }

  get(procId: string): ProcessRecord | null {
    const record = this.presentations.get(procId)?.record;
    return record ? { ...record } : null;
  }

  private launch(spec: ProcessSpawnSpec, file: string, args: readonly string[], stdio: SpawnOptions['stdio'], captureOutput: boolean, childEnv: NodeJS.ProcessEnv): InteractiveProcessLaunch {
    if (!spec.command) throw new Error('command must not be empty');
    if (!spec.ownerId || !spec.ownerKind) throw new Error('process spawn requires explicit ownerId and ownerKind.');
    const id = generateId();
    const cwd = spec.cwd ? resolve(spec.cwd) : this.projectRoot;
    const cardId = spec.cardId ?? null;
    const outputDir = cardId ? cardProcessOutputRoot(this.projectRoot, cardId, id) : nonCardProcessOutputRoot(this.projectRoot, id);
    mkdirSync(outputDir, { recursive: true });
    const stdoutPath = join(outputDir, 'stdout.log');
    const stderrPath = join(outputDir, 'stderr.log');
    replaceFile(stdoutPath, Buffer.alloc(0), undefined, this.#replacementIo);
    replaceFile(stderrPath, Buffer.alloc(0), undefined, this.#replacementIo);
    const record: ProcessRecord = {
      id,
      card_id: cardId,
      owner_id: spec.ownerId,
      owner_kind: spec.ownerKind,
      agent_session_id: spec.agentSessionId ?? null,
      command: redactCommandForPolicy(spec.command),
      cwd,
      status: 'running',
      started_at: now(),
      completed_at: null,
      exit_code: null,
      signal: null,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
    };
    let resolveAbsence!: () => void;
    const absence = new Promise<void>((resolveAbsent) => { resolveAbsence = resolveAbsent; });
    const presentation: ProcessPresentation = { record, leaderOutcome: null, terminationReason: undefined, terminalSettlement: Promise.resolve() };
    this.presentations.set(id, presentation);
    let child: ChildProcess;
    try {
      child = this.#registry.launch({
        groupId: id,
        directScope: spec.directScope,
        category: spec.category,
        file,
        args,
        options: {
          cwd,
          env: childEnv,
          stdio,
        },
         onAbsent: (reason) => { presentation.terminationReason = reason; resolveAbsence(); },
      });
    } catch (error) {
      this.presentations.delete(id);
      throw error;
    }
    const stdoutDrain = captureOutput ? this.#captureReadable(child.stdout, stdoutPath) : Promise.resolve();
    const stderrDrain = captureOutput ? this.#captureReadable(child.stderr, stderrPath) : Promise.resolve();
    presentation.terminalSettlement = Promise.all([absence, stdoutDrain, stderrDrain]).then(() => { this.finalize(id, presentation.terminationReason ?? null); });
    child.once('exit', (exitCode, signalCode) => {
      presentation.leaderOutcome = {
        status: signalCode === 'SIGKILL' || signalCode === 'SIGTERM' ? 'killed' : exitCode === 0 ? 'exited' : 'failed',
        exit_code: exitCode,
        signal: signalCode ?? null,
      };
    });
    child.once('error', (error) => {
      try { appendProcessOutputChunk(stderrPath, Buffer.from(`[process-runner] spawn error: ${error.message}\n`), this.#outputIo); }
      catch (failure) { if (failure instanceof PublicationOutcomeUnknownError) this.fatalPort.publicationOutcomeUnknown(failure); throw failure; }
      presentation.leaderOutcome = { status: 'failed', exit_code: -1, signal: null };
    });
    return { record: { ...record }, process: child };
  }

  private finalize(procId: string, terminationReason: string | null): void {
    const presentation = this.presentations.get(procId);
    if (!presentation || presentation.record.status !== 'running') return;
    const outcome = terminationReason
      ? { status: 'killed' as const, exit_code: null, signal: 'SIGTERM' }
      : presentation.leaderOutcome ?? { status: 'failed' as const, exit_code: null, signal: null };
    presentation.record = { ...presentation.record, ...outcome, completed_at: now() };
  }

  #captureReadable(readable: Readable | null, path: string): Promise<void> {
    if (!readable) return Promise.resolve();
    readable.on('data', (chunk: Buffer | string) => {
      try { appendProcessOutputChunk(path, typeof chunk === 'string' ? Buffer.from(chunk) : chunk, this.#outputIo); }
      catch (error) { if (error instanceof PublicationOutcomeUnknownError) this.fatalPort.publicationOutcomeUnknown(error); throw error; }
    });
    readable.on('error', (error) => { throw error; });
    return new Promise<void>((resolveDrain) => {
      let settled = false;
      const settle = (): void => { if (!settled) { settled = true; resolveDrain(); } };
      readable.once('end', settle);
      readable.once('close', settle);
    });
  }

  async #joinStopped(report: ProcessStopReport): Promise<void> {
    await Promise.all(report.stopped.map((id) => {
      const presentation = this.presentations.get(id);
      if (!presentation) throw new Error(`Registry-confirmed stopped process '${id}' has no ProcessRunner presentation.`);
      return presentation.terminalSettlement;
    }));
  }

  private waitResult(procId: string, timedOut: boolean, started: number): ProcessWaitResult {
    const record = this.presentations.get(procId)!.record;
    return { id: procId, status: record.status, exitCode: record.exit_code ?? null, timedOut, waitDurationMs: Date.now() - started };
  }

  private assertStopSucceeded(report: ProcessStopReport): void {
    if (report.failed.length === 0) return;
    throw new Error(report.failed.map((failure) => `${failure.groupId}: ${failure.state}: ${failure.diagnostic}`).join('; '));
  }
}

export type { ManagedProcessScope, ProcessCategory, ProcessStopReport } from './managed-process-group-registry.js';
