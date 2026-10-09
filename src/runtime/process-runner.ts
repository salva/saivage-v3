import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import type { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import { cardProcessOutputRoot, nonCardProcessOutputRoot } from '../persistence/index.js';
import { writeAllExact } from '../persistence/index.js';
import type { ProcessEvidence, ProcessObservationStatus } from '../contracts/index.js';
import { now } from '../utils/index.js';
import { sanitizedCommandEnv } from './command-policy.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { replaceFile, type ReplacementFileIo } from '../persistence/index.js';
import { PublicationOutcomeUnknownError, type ApplicationFatalPort } from '../contracts/index.js';
import {
  ManagedProcessGroupRegistry,
  type ManagedProcessScope,
  type ProcessCategory,
  type ProcessStopReport,
} from './managed-process-group-registry.js';

interface ProcessSpawnSpec {
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

interface InteractiveProcessSpawnSpec extends Omit<ProcessSpawnSpec, 'command' | 'env'> {
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
  status: ProcessObservationStatus;
  evidence: ProcessEvidence;
  started_at: string;
  completed_at: string | null;
  exit_code: number | null;
  signal: string | null;
  stdout_path: string;
  stderr_path: string;
}

interface InteractiveProcessLaunch {
  record: ProcessRecord;
  process: ChildProcess;
}

export interface ProcessWaitResult {
  id: string;
  status: ProcessObservationStatus;
  exitCode: number | null;
  timedOut: boolean;
  waitDurationMs: number;
  record: ProcessRecord;
}

interface ProcessListFilter {
  cardId?: string;
  status?: ProcessObservationStatus | ProcessObservationStatus[];
}

interface ProcessPresentation {
  record: ProcessRecord;
  directScope: ManagedProcessScope;
  leaderOutcome: Pick<ProcessRecord, 'status' | 'exit_code' | 'signal'> | null;
  terminationReason: string | null | undefined;
  terminalSettlement: Promise<void>;
  captureFailure: Error | null;
}

export class ProcessEvidenceUnavailableError extends Error {
  constructor(
    readonly processId: string,
    readonly diagnostic: string,
  ) {
    super(`Process '${processId}' evidence unavailable: ${diagnostic}`);
    this.name = 'ProcessEvidenceUnavailableError';
  }
}

function isTerminal(status: ProcessObservationStatus): boolean {
  return status === 'exited' || status === 'failed' || status === 'killed';
}

function snapshot(record: ProcessRecord): ProcessRecord {
  return {
    ...record,
    evidence: {
      ...record.evidence,
      leader_exit: record.evidence.leader_exit && { ...record.evidence.leader_exit },
      leader_error: record.evidence.leader_error && { ...record.evidence.leader_error },
    },
  };
}

export interface ProcessOutputIo {
  open: typeof openSync;
  stat: typeof fstatSync;
  write: typeof writeSync;
  fsync: typeof fsyncSync;
  close: typeof closeSync;
}
const processOutputIo: ProcessOutputIo = {
  open: openSync,
  stat: fstatSync,
  write: writeSync,
  fsync: fsyncSync,
  close: closeSync,
};

export function appendProcessOutputChunk(
  path: string,
  chunk: Uint8Array,
  io: ProcessOutputIo = processOutputIo,
): void {
  const bytes = Buffer.from(chunk);
  if (bytes.byteLength === 0) return;
  const fd = io.open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!io.stat(fd).isFile())
      throw new Error(`Process output target '${path}' must be a regular file.`);
  } catch (error) {
    try {
      io.close(fd);
    } catch {
      /* pre-publication admission failure remains authoritative */
    }
    throw error;
  }
  try {
    writeAllExact(fd, bytes, io.write, () => new Error('zero progress'));
    io.fsync(fd);
    io.close(fd);
  } catch (error) {
    throw new PublicationOutcomeUnknownError(error);
  }
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

  constructor(
    readonly projectRoot: string,
    registry: ManagedProcessGroupRegistry,
    readonly fatalPort: ApplicationFatalPort,
    io: { readonly output?: ProcessOutputIo; readonly replacement?: ReplacementFileIo } = {},
  ) {
    this.#registry = registry;
    this.#outputIo = io.output;
    this.#replacementIo = io.replacement;
  }

  spawn(spec: ProcessSpawnSpec): ProcessRecord {
    return this.launch(spec, 'bash', ['-c', spec.command], ['ignore', 'pipe', 'pipe'], true, {
      ...sanitizedCommandEnv(),
      PROJECT_ROOT: this.projectRoot,
      SAIVAGE_ROOT: this.projectRoot,
      ...spec.env,
    }).record;
  }

  spawnInteractive(spec: InteractiveProcessSpawnSpec): InteractiveProcessLaunch {
    const command = [spec.file, ...spec.args].join(' ');
    return this.launch(
      { ...spec, command, env: undefined },
      spec.file,
      spec.args,
      spec.stdio,
      false,
      spec.env,
    );
  }

  async wait(procId: string, timeoutMs = 0): Promise<ProcessWaitResult> {
    const started = Date.now();
    const presentation = this.presentations.get(procId);
    if (!presentation) throw new Error(`Unknown process '${procId}'.`);
    this.assertEvidenceAvailable(presentation);
    if (presentation.record.status !== 'running') {
      await presentation.terminalSettlement;
      return this.waitResult(presentation, false, started);
    }
    if (timeoutMs === 0) return this.waitResult(presentation, false, started);
    const result = await Promise.race([
      presentation.terminalSettlement.then(() => 'settled' as const),
      delay(timeoutMs).then(() => 'timeout' as const),
    ]);
    this.assertEvidenceAvailable(presentation);
    if (result === 'timeout') return this.waitResult(presentation, true, started);
    return this.waitResult(presentation, false, started);
  }

  async waitForSettlement(procId: string): Promise<ProcessWaitResult> {
    const started = Date.now();
    const presentation = this.presentations.get(procId);
    if (!presentation) throw new Error(`Unknown process '${procId}'.`);
    this.assertEvidenceAvailable(presentation);
    await presentation.terminalSettlement;
    return this.waitResult(presentation, false, started);
  }

  async kill(
    procId: string,
    authority: {
      directScope: ManagedProcessScope;
      category: ProcessCategory;
      reason?: string;
      graceMs?: number;
    },
  ): Promise<ProcessRecord | null> {
    const presentation = this.presentations.get(procId);
    if (!presentation) return null;
    const report = await this.#registry.terminateGroup({
      groupId: procId,
      directScope: authority.directScope,
      category: authority.category,
      reason: authority.reason ?? 'process killed',
      graceMs: authority.graceMs,
    });
    if (report.failed.length === 0) await presentation.terminalSettlement;
    else await this.#joinStopped(report, new Map([[procId, presentation]]));
    this.assertStopSucceeded(report);
    return snapshot(presentation.record);
  }

  async terminateScopeTree(input: {
    rootScope: ManagedProcessScope;
    categories: readonly ProcessCategory[];
    reason: string;
    graceMs?: number;
  }): Promise<ProcessStopReport> {
    const presentations = new Map(this.presentations);
    const report = await this.#registry.terminateScopeTree(input);
    const stopped = report.stopped.map((id) => {
      const presentation = presentations.get(id);
      if (!presentation)
        throw new Error(
          `Registry-confirmed stopped process '${id}' has no ProcessRunner presentation.`,
        );
      return { id, presentation };
    });
    const settlements = await Promise.allSettled(
      stopped.map(({ presentation }) => presentation.terminalSettlement),
    );
    for (const settlement of settlements) {
      if (
        settlement.status === 'rejected' &&
        settlement.reason instanceof PublicationOutcomeUnknownError
      )
        this.fatalPort.publicationOutcomeUnknown(settlement.reason);
    }
    for (const { id, presentation } of stopped) this.retireSettled(id, presentation.directScope);
    const rejection = settlements.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected',
    );
    if (rejection) throw rejection.reason;
    return report;
  }

  async closeAndTerminateDirectScope(input: {
    directScope: ManagedProcessScope;
    category: ProcessCategory;
    reason: string;
    graceMs?: number;
  }): Promise<ProcessStopReport> {
    const presentations = new Map(
      [...this.presentations].filter(
        ([, presentation]) => presentation.directScope === input.directScope,
      ),
    );
    let report: ProcessStopReport;
    try {
      report = await this.#registry.closeAndTerminateDirectScope(input);
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError)
        this.fatalPort.publicationOutcomeUnknown(error);
      const alreadyTerminal = [...presentations.values()].filter((presentation) =>
        isTerminal(presentation.record.status),
      );
      const settlements = await Promise.allSettled(
        alreadyTerminal.map((presentation) => presentation.terminalSettlement),
      );
      for (const settlement of settlements) {
        if (
          settlement.status === 'rejected' &&
          settlement.reason instanceof PublicationOutcomeUnknownError
        )
          this.fatalPort.publicationOutcomeUnknown(settlement.reason);
      }
      for (const [id, presentation] of presentations) {
        if (isTerminal(presentation.record.status)) this.retireSettled(id, input.directScope);
      }
      throw error;
    }
    const joinable = [...presentations.entries()].filter(
      ([id, presentation]) => report.stopped.includes(id) || isTerminal(presentation.record.status),
    );
    const settlements = await Promise.allSettled(
      joinable.map(([, presentation]) => presentation.terminalSettlement),
    );
    for (const settlement of settlements) {
      if (
        settlement.status === 'rejected' &&
        settlement.reason instanceof PublicationOutcomeUnknownError
      )
        this.fatalPort.publicationOutcomeUnknown(settlement.reason);
    }
    for (const [id, presentation] of presentations) {
      if (isTerminal(presentation.record.status)) this.retireSettled(id, input.directScope);
    }
    const rejection = settlements.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected',
    );
    if (rejection) throw rejection.reason;
    return report;
  }

  retireSettled(procId: string, directScope: ManagedProcessScope): void {
    const presentation = this.presentations.get(procId);
    if (!presentation) return;
    if (presentation.directScope !== directScope)
      throw new Error(`Process '${procId}' is not bound to the invoking direct scope.`);
    if (!isTerminal(presentation.record.status)) return;
    this.presentations.delete(procId);
  }

  closeLaunchAdmission(): void {
    this.#registry.closeLaunchAdmission();
  }

  createContainerScope(parent: ManagedProcessScope, label: string): ManagedProcessScope {
    return this.#registry.createContainerScope(parent, label);
  }

  createDirectScope(
    parent: ManagedProcessScope,
    label: string,
    category: ProcessCategory,
  ): ManagedProcessScope {
    return this.#registry.createDirectScope(parent, label, category);
  }

  list(filter?: ProcessListFilter): ProcessRecord[] {
    let records = [...this.presentations.values()].map(({ record }) => snapshot(record));
    if (filter?.cardId) records = records.filter((record) => record.card_id === filter.cardId);
    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      records = records.filter((record) => statuses.includes(record.status));
    }
    return records;
  }

  get(procId: string): ProcessRecord | null {
    const record = this.presentations.get(procId)?.record;
    return record ? snapshot(record) : null;
  }

  private launch(
    spec: ProcessSpawnSpec,
    file: string,
    args: readonly string[],
    stdio: SpawnOptions['stdio'],
    captureOutput: boolean,
    childEnv: NodeJS.ProcessEnv,
  ): InteractiveProcessLaunch {
    if (!spec.command) throw new Error('command must not be empty');
    if (!spec.ownerId || !spec.ownerKind)
      throw new Error('process spawn requires explicit ownerId and ownerKind.');
    const id = generateId();
    const cwd = spec.cwd ? resolve(spec.cwd) : this.projectRoot;
    const cardId = spec.cardId ?? null;
    const outputDir = cardId
      ? cardProcessOutputRoot(this.projectRoot, cardId, id)
      : nonCardProcessOutputRoot(this.projectRoot, id);
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
      command: redactTextForOutbound(spec.command),
      cwd,
      status: 'running',
      evidence: {
        group: 'tracked',
        group_diagnostic: null,
        leader_exit: null,
        leader_error: null,
        stdout: captureOutput ? 'open' : 'not_captured',
        stderr: captureOutput ? 'open' : 'not_captured',
        stdout_error: null,
        stderr_error: null,
      },
      started_at: now(),
      completed_at: null,
      exit_code: null,
      signal: null,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
    };
    let resolveAbsence!: () => void;
    const absence = new Promise<void>((resolveAbsent) => {
      resolveAbsence = resolveAbsent;
    });
    const recordCaptureFailure = (error: Error): void => {
      presentation.captureFailure ??= error;
    };
    const presentation: ProcessPresentation = {
      record,
      directScope: spec.directScope,
      leaderOutcome: null,
      terminationReason: undefined,
      terminalSettlement: Promise.resolve(),
      captureFailure: null,
    };
    let resolveSettlement!: () => void;
    let rejectSettlement!: (error: Error) => void;
    presentation.terminalSettlement = new Promise<void>((resolve, reject) => {
      resolveSettlement = resolve;
      rejectSettlement = reject;
    });
    void presentation.terminalSettlement.catch(() => undefined);
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
        onAbsent: (reason) => {
          record.evidence.group = 'absent';
          presentation.terminationReason = reason;
          resolveAbsence();
        },
        onUnverifiable: (diagnostic) => {
          record.evidence.group = 'unverifiable';
          record.evidence.group_diagnostic = diagnostic;
          record.status = 'unavailable';
          rejectSettlement(
            presentation.captureFailure ?? new ProcessEvidenceUnavailableError(id, diagnostic),
          );
        },
      });
    } catch (error) {
      this.presentations.delete(id);
      throw error;
    }
    const stdoutDrain = captureOutput
      ? this.#captureReadable(child.stdout, stdoutPath, record, 'stdout', recordCaptureFailure)
      : Promise.resolve();
    const stderrDrain = captureOutput
      ? this.#captureReadable(child.stderr, stderrPath, record, 'stderr', recordCaptureFailure)
      : Promise.resolve();
    void Promise.all([absence, stdoutDrain, stderrDrain]).then(() => {
      this.finalize(
        presentation,
        presentation.terminationReason ?? null,
        presentation.captureFailure,
      );
      if (presentation.captureFailure) rejectSettlement(presentation.captureFailure);
      else resolveSettlement();
    });
    child.once('exit', (exitCode, signalCode) => {
      record.evidence.leader_exit = {
        exit_code: exitCode,
        signal: signalCode ?? null,
        observed_at: now(),
      };
      presentation.leaderOutcome = {
        status:
          signalCode === 'SIGKILL' || signalCode === 'SIGTERM'
            ? 'killed'
            : exitCode === 0
              ? 'exited'
              : 'failed',
        exit_code: exitCode,
        signal: signalCode ?? null,
      };
    });
    child.once('error', (error) => {
      try {
        appendProcessOutputChunk(
          stderrPath,
          Buffer.from(`[process-runner] spawn error: ${error.message}\n`),
          this.#outputIo,
        );
      } catch (failure) {
        if (failure instanceof PublicationOutcomeUnknownError)
          this.fatalPort.publicationOutcomeUnknown(failure);
        record.evidence.stderr_error ??=
          failure instanceof Error ? failure.message : String(failure);
        recordCaptureFailure(failure instanceof Error ? failure : new Error(String(failure)));
      }
      record.evidence.leader_error ??= { diagnostic: error.message, observed_at: now() };
      presentation.leaderOutcome ??= { status: 'failed', exit_code: null, signal: null };
    });
    return { record: snapshot(record), process: child };
  }

  private finalize(
    presentation: ProcessPresentation,
    terminationReason: string | null,
    captureFailure: Error | null,
  ): void {
    if (presentation.record.status !== 'running') return;
    const outcome = captureFailure
      ? {
          ...(presentation.leaderOutcome ?? { exit_code: null, signal: null }),
          status: 'failed' as const,
        }
      : terminationReason
        ? { status: 'killed' as const, exit_code: null, signal: 'SIGTERM' }
        : (presentation.leaderOutcome ?? {
            status: 'failed' as const,
            exit_code: null,
            signal: null,
          });
    presentation.record = { ...presentation.record, ...outcome, completed_at: now() };
  }

  #captureReadable(
    readable: Readable | null,
    path: string,
    record: ProcessRecord,
    stream: 'stdout' | 'stderr',
    recordFailure: (error: Error) => void,
  ): Promise<void> {
    if (!readable) {
      record.evidence[stream] = 'not_captured';
      return Promise.resolve();
    }
    const captureFailure = (error: Error): void => {
      record.evidence[`${stream}_error`] ??= error.message;
      recordFailure(error);
    };
    readable.on('data', (chunk: Buffer | string) => {
      try {
        appendProcessOutputChunk(
          path,
          typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
          this.#outputIo,
        );
      } catch (error) {
        if (error instanceof PublicationOutcomeUnknownError)
          this.fatalPort.publicationOutcomeUnknown(error);
        captureFailure(error instanceof Error ? error : new Error(String(error)));
        readable.destroy();
      }
    });
    readable.on('error', captureFailure);
    return new Promise<void>((resolveDrain) => {
      let settled = false;
      const settle = (): void => {
        if (!settled) {
          settled = true;
          resolveDrain();
        }
      };
      readable.once('end', () => {
        record.evidence[stream] = 'eof';
        settle();
      });
      readable.once('close', () => {
        if (record.evidence[stream] !== 'eof') record.evidence[stream] = 'closed';
        settle();
      });
    });
  }

  async #joinStopped(
    report: ProcessStopReport,
    presentations: ReadonlyMap<string, ProcessPresentation>,
  ): Promise<void> {
    await Promise.all(
      report.stopped.map((id) => {
        const presentation = presentations.get(id);
        if (!presentation)
          throw new Error(
            `Registry-confirmed stopped process '${id}' has no ProcessRunner presentation.`,
          );
        return presentation.terminalSettlement;
      }),
    );
  }

  private waitResult(
    presentation: ProcessPresentation,
    timedOut: boolean,
    started: number,
  ): ProcessWaitResult {
    const record = snapshot(presentation.record);
    return {
      id: record.id,
      status: record.status,
      exitCode: record.exit_code ?? null,
      timedOut,
      waitDurationMs: Date.now() - started,
      record,
    };
  }

  private assertStopSucceeded(report: ProcessStopReport): void {
    if (report.failed.length === 0) return;
    throw new Error(
      report.failed
        .map((failure) => `${failure.groupId}: ${failure.state}: ${failure.diagnostic}`)
        .join('; '),
    );
  }

  private assertEvidenceAvailable(presentation: ProcessPresentation): void {
    if (presentation.record.status !== 'unavailable') return;
    throw (
      presentation.captureFailure ??
      new ProcessEvidenceUnavailableError(
        presentation.record.id,
        presentation.record.evidence.group_diagnostic!,
      )
    );
  }
}

export type {
  ManagedProcessScope,
  ProcessCategory,
  ProcessStopReport,
} from './managed-process-group-registry.js';
