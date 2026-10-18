import type { ManagedProcessScope, ProcessRunner } from '../runtime/runtime-api.js';
import { ProcessEvidenceUnavailableError } from '../runtime/runtime-api.js';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  PublicationOutcomeUnknownError,
  throwIfPublicationOutcomeUnknown,
  type OutboundHttpEmitter,
  type OutboundObservationSource,
} from '../contracts/index.js';
import type { StdioMcpServerConfig } from '../schemas/index.js';
import { sanitizedCommandEnv } from '../runtime/runtime-api.js';
import {
  compileMcpArgumentValidator,
  fingerprintMcpInputSchema,
  validateMcpArguments,
  type CachedMcpArgumentValidator,
} from './mcp-argument-validator.js';
import {
  InvalidArgumentsError,
  McpLifecycleError,
  McpInvokeError,
  ServerNotRunningError,
  ToolNotFoundError,
  TimeoutError,
} from './errors.js';
import {
  MCP_INVOKE_TIMEOUT_MS,
  MCP_START_TIMEOUT_MS,
  MCP_REFRESH_TIMEOUT_MS,
  type McpCatalogSnapshot,
  type McpCatalogRefreshResult,
  type McpServerStatus,
  type McpStatus,
  type McpToolDefinition,
} from './protocol.js';
import type { McpServerConfig, McpServerHandle } from './server-registry.js';
import { McpInvocationStatsRecorder } from './invocation-stats.js';
import { buildMcpServerStatus } from './status-projection.js';
import {
  initializeStreamableHttp,
  listStreamableHttpTools,
  invokeStreamableHttpTool,
} from './streamable-http-transport.js';
import { StdioMcpConnection } from './stdio-transport.js';
import type { NativeMcpResult } from './native-result.js';

interface McpJsonRpcIdProvider {
  next(): number | string;
}

interface McpServerRuntimeOptions {
  outboundHttp?: OutboundHttpEmitter;
  name: string;
  config: McpServerConfig;
  revision: string;
  processRunner: ProcessRunner;
  processScope: ManagedProcessScope;
  ids: McpJsonRpcIdProvider;
  invocationStats: McpInvocationStatsRecorder;
  projectRoot?: string;
}

export class McpServerRuntime {
  readonly #outboundHttp?: OutboundHttpEmitter;
  readonly bindingId = randomUUID();
  readonly #processRunner: ProcessRunner;
  readonly #processScope: ManagedProcessScope;
  readonly #ids: McpJsonRpcIdProvider;
  readonly #invocationStats: McpInvocationStatsRecorder;
  readonly #name: string;
  readonly #config: McpServerConfig;
  readonly #revision: string;
  readonly #projectRoot?: string;
  #directContainment?: Promise<void>;
  private handle?: McpServerHandle;
  private stdioConnection?: StdioMcpConnection;
  private observerController?: AbortController;
  private closureCause?: 'intentional' | 'transport';
  private observedCaptureError?: unknown;
  private containmentFailed = false;
  private statusOverride?: { status: McpStatus; error?: string };
  private startedAt?: string;
  private catalog?: McpCatalogSnapshot;
  private refreshing = false;
  private readonly argumentValidatorCache = new Map<string, CachedMcpArgumentValidator>();
  private stdioExchangeQueue?: Promise<void>;
  private admissionOpen = true;
  private contained = false;
  private ready = false;
  private readonly controllers = new Set<AbortController>();
  private readonly operations = new Set<Promise<void>>();

  constructor({
    name,
    config,
    revision,
    processRunner,
    processScope,
    ids,
    invocationStats,
    projectRoot,
    outboundHttp,
  }: McpServerRuntimeOptions) {
    this.#name = name;
    this.#outboundHttp = outboundHttp;
    this.#config = config;
    this.#revision = revision;
    this.#processRunner = processRunner;
    this.#processScope = processScope;
    this.#ids = ids;
    this.#invocationStats = invocationStats;
    this.#projectRoot = projectRoot;
  }

  get name(): string {
    return this.#name;
  }
  get config(): McpServerConfig {
    return this.#config;
  }
  get revision(): string {
    return this.#revision;
  }
  isReady(): boolean {
    return this.ready;
  }
  isContained(): boolean {
    return this.contained;
  }
  isAdmissionOpen(): boolean {
    return this.admissionOpen;
  }

  start(options?: {
    signal?: AbortSignal;
    observationSource?: OutboundObservationSource;
  }): Promise<void> {
    const callerSignal = options?.signal;
    if (callerSignal?.aborted) return Promise.reject(callerSignal.reason);
    if (this.operations.size || this.handle)
      return Promise.reject(new McpLifecycleError(`MCP server '${this.name}' is busy.`, 409));
    let joinStop = false;
    const inner = this.admit(async (signal, controller) => {
      const invalidate = () => {
        throwIfPublicationOutcomeUnknown(signal.reason);
        this.closeAdmission();
      };
      signal.addEventListener('abort', invalidate, { once: true });
      const deadline = setTimeout(
        () => controller.abort(new TimeoutError(this.name, 'start', MCP_START_TIMEOUT_MS)),
        MCP_START_TIMEOUT_MS,
      );
      let publicationUnknown = false;
      try {
        const cfg = this.config;
        if (cfg.disabled) return;
        this.statusOverride = undefined;
        if (cfg.transport === 'stdio') this.startStdio(cfg, signal);
        else this.startStreamableHttp();
        this.assertAdmissionOpen(signal);
        await this.initializeTransport(signal, options?.observationSource);
        const tools = await this.listTools(signal, options?.observationSource);
        this.assertAdmissionOpen(signal);
        this.publishCatalog(tools);
        this.ready = true;
      } catch (error) {
        publicationUnknown = error instanceof PublicationOutcomeUnknownError;
        throwIfPublicationOutcomeUnknown(error);
        try {
          this.closeAdmission();
          await this.directContainment();
        } catch (containmentError) {
          publicationUnknown = containmentError instanceof PublicationOutcomeUnknownError;
          throw containmentError;
        }
        joinStop = true;
        throw error;
      } finally {
        if (!publicationUnknown) {
          clearTimeout(deadline);
          signal.removeEventListener('abort', invalidate);
        }
      }
    }, callerSignal);
    // Only this untracked completion joins stop; inner startup never joins itself.
    return inner.then(
      async () => {
        if (joinStop) await this.stop();
      },
      async (error) => {
        if (joinStop) await this.stop();
        throw error;
      },
    );
  }

  closeAdmission(cause: 'intentional' | 'transport' = 'intentional'): void {
    if (this.#directContainment) return;
    this.closureCause = cause;
    this.disposeStdio(new ServerNotRunningError(this.name));
    this.admissionOpen = false;
    this.ready = false;
    this.catalog = undefined;
    this.argumentValidatorCache.clear();
    this.statusOverride = { status: 'stopped' };
    let containment: Promise<import('../runtime/runtime-api.js').ProcessStopReport>;
    try {
      containment = this.#processRunner.closeAndTerminateDirectScope({
        directScope: this.#processScope,
        category: 'service_infrastructure',
        reason: `MCP server '${this.name}' stopped`,
      });
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      containment = Promise.reject(error);
    }
    const directContainment = containment.then(
      (report) => {
        if (report.failed.length > 0) {
          this.containmentFailed = true;
          this.observerController?.abort();
          this.statusOverride = { status: 'error', error: 'Process containment failed' };
          throw new Error(`MCP server '${this.name}' process containment failed.`);
        }
      },
      (error) => {
        throwIfPublicationOutcomeUnknown(error);
        this.containmentFailed = true;
        this.observerController?.abort();
        if (error !== this.observedCaptureError)
          this.statusOverride = { status: 'error', error: 'Process containment failed' };
        throw error;
      },
    );
    this.#directContainment = directContainment;
    void directContainment.catch(() => undefined);
    if (cause === 'intentional') this.observerController?.abort();
    for (const controller of this.controllers)
      controller.abort(new ServerNotRunningError(this.name));
  }

  directContainment(): Promise<void> {
    if (!this.#directContainment)
      throw new Error(`MCP server '${this.name}' admission has not been closed.`);
    return this.#directContainment;
  }

  async stop(): Promise<void> {
    if (this.contained) return;
    if (!this.#directContainment) this.closeAdmission();
    const directContainment = this.directContainment();
    const operations = [...this.operations];
    const settlements = await Promise.allSettled([...operations, directContainment]);
    for (const settlement of settlements)
      if (settlement.status === 'rejected') throwIfPublicationOutcomeUnknown(settlement.reason);
    const directSettlement = settlements[settlements.length - 1]!;
    if (directSettlement.status === 'rejected') throw directSettlement.reason;
    this.handle?.abortController?.abort();
    this.disposeStdio(new ServerNotRunningError(this.name));
    this.handle = undefined;
    if (this.closureCause !== 'transport') this.statusOverride = { status: 'stopped' };
    this.ready = false;
    this.clearCaches();
    this.contained = true;
  }

  dispose(): Promise<void> {
    return this.stop();
  }

  refreshCatalog(
    bindingId: string,
    options?: { signal?: AbortSignal; observationSource?: OutboundObservationSource },
  ): Promise<McpCatalogRefreshResult> {
    if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
    if (!this.admissionOpen || !this.ready)
      return Promise.reject(new ServerNotRunningError(this.name));
    if (bindingId !== this.bindingId)
      return Promise.reject(
        new McpLifecycleError('Stale MCP binding; discover tools again before refreshing.', 409),
      );
    if (this.refreshing)
      return Promise.reject(
        new McpLifecycleError(`MCP server '${this.name}' catalog refresh is busy.`, 409),
      );
    this.refreshing = true;
    let joinStop = false;
    let onBoundedAbort!: () => void;
    let operationSignal!: AbortSignal;
    let rejectBounded!: (reason: unknown) => void;
    let published = false;
    let listStarted = false;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectBounded = reject;
    });
    const inner = this.admit(async (signal, controller) => {
      operationSignal = signal;
      onBoundedAbort = () => {
        throwIfPublicationOutcomeUnknown(signal.reason);
        if (!published && !listStarted) {
          const reason = signal.reason;
          rejectBounded(
            reason instanceof TimeoutError
              ? new McpInvokeError(
                  `${reason.message}; last successful catalog unchanged.`,
                  reason.code,
                  reason.statusCode,
                )
              : reason,
          );
        }
      };
      signal.addEventListener('abort', onBoundedAbort, { once: true });
      const deadline = setTimeout(
        () =>
          controller.abort(new TimeoutError(this.name, 'catalog refresh', MCP_REFRESH_TIMEOUT_MS)),
        MCP_REFRESH_TIMEOUT_MS,
      );
      let publicationUnknown = false;
      const list = async () => {
        this.assertAdmissionOpen(signal);
        if (!this.ready) throw new ServerNotRunningError(this.name);
        listStarted = true;
        const invalidate = () => {
          throwIfPublicationOutcomeUnknown(signal.reason);
          if (this.config.transport === 'stdio') this.closeAdmission();
        };
        signal.addEventListener('abort', invalidate, { once: true });
        let listPublicationUnknown = false;
        try {
          return await this.listTools(signal, options?.observationSource);
        } catch (error) {
          listPublicationUnknown = error instanceof PublicationOutcomeUnknownError;
          throw error;
        } finally {
          // Fatal publication uncertainty forbids follow-up cleanup.
          if (!listPublicationUnknown) {
            throwIfPublicationOutcomeUnknown(signal.reason);
            signal.removeEventListener('abort', invalidate);
          }
        }
      };
      try {
        const tools =
          this.config.transport === 'stdio' ? await this.enqueueStdioExchange(list) : await list();
        this.assertAdmissionOpen(signal);
        if (!this.ready) throw new ServerNotRunningError(this.name);
        this.publishCatalog(tools);
        published = true;
        const catalog = this.catalog!;
        return {
          serverName: this.name,
          bindingId: this.bindingId,
          catalogId: catalog.catalogId,
          toolCount: tools.length,
        };
      } catch (error) {
        publicationUnknown = error instanceof PublicationOutcomeUnknownError;
        throwIfPublicationOutcomeUnknown(error);
        if (!this.admissionOpen) {
          try {
            await this.directContainment();
          } catch (containmentError) {
            publicationUnknown = containmentError instanceof PublicationOutcomeUnknownError;
            throw containmentError;
          }
          joinStop = true;
        }
        if (error instanceof McpInvokeError)
          throw new McpInvokeError(
            `${error.message}; ${this.admissionOpen ? 'last successful catalog unchanged' : 'connection closed'}.`,
            error.code,
            error.statusCode,
          );
        throw error;
      } finally {
        if (!publicationUnknown) {
          clearTimeout(deadline);
          signal.removeEventListener('abort', onBoundedAbort);
          this.refreshing = false;
        }
      }
    }, options?.signal);
    // The caller may leave on deadline while the queued no-op is still owned and busy.
    // Only an untracked completion may join stop, which itself joins inner.
    const completion = inner.then(
      async (value) => {
        if (joinStop) await this.stop();
        return value;
      },
      async (error) => {
        if (joinStop) await this.stop();
        throw error;
      },
    );
    return Promise.race([completion, aborted]).finally(() => {
      throwIfPublicationOutcomeUnknown(operationSignal.reason);
    });
  }

  private publishCatalog(tools: McpToolDefinition[]): void {
    this.catalog = {
      serverName: this.name,
      bindingId: this.bindingId,
      catalogId: randomUUID(),
      tools,
    };
    this.argumentValidatorCache.clear();
  }

  private assertCatalog(bindingId: string, catalogId: string): void {
    if (!this.ready || !this.catalog) throw new ServerNotRunningError(this.name);
    if (bindingId !== this.bindingId)
      throw new McpLifecycleError(
        'Stale MCP binding; call was not dispatched. Discover tools again.',
        409,
      );
    if (catalogId !== this.catalog.catalogId)
      throw new McpLifecycleError(
        'Stale MCP catalog; call was not dispatched. Discover tools again.',
        409,
      );
  }

  invokeTool(
    bindingId: string,
    catalogId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      observationSource?: OutboundObservationSource;
    },
  ): Promise<NativeMcpResult> {
    let joinStop = false;
    const inner = this.admit(async (signal, controller) => {
      const cfg = this.config;
      const handle = this.handle;
      let startTime = 0;
      let dispatched = false;
      const admitDispatch = () => {
        this.assertAdmissionOpen(signal);
        this.assertCatalog(bindingId, catalogId);
        if (!handle) throw new ServerNotRunningError(this.name);
        if (cfg.transport === 'stdio') {
          if (
            !handle.process ||
            !handle.processId ||
            this.#processRunner.get(handle.processId)?.status !== 'running'
          )
            throw new ServerNotRunningError(this.name);
        } else if (!handle.abortController || handle.abortController.signal.aborted)
          throw new ServerNotRunningError(this.name);
        const toolDefinition = this.catalog!.tools.find((tool) => tool.name === toolName);
        if (!toolDefinition) throw new ToolNotFoundError(this.name, toolName);
        this.validateToolArguments(toolName, toolDefinition.inputSchema, args);
        startTime = Date.now();
        dispatched = true;
      };
      const timeoutMs = options?.timeoutMs ?? MCP_INVOKE_TIMEOUT_MS;
      let result: NativeMcpResult;
      let responseCompleted = false;
      try {
        if (cfg.transport === 'stdio') {
          result = await this.enqueueStdioExchange(async () => {
            admitDispatch();
            const invalidate = () => {
              throwIfPublicationOutcomeUnknown(signal.reason);
              this.closeAdmission();
            };
            signal.addEventListener('abort', invalidate, { once: true });
            const deadline = setTimeout(
              () => controller.abort(new TimeoutError(this.name, toolName, timeoutMs)),
              timeoutMs,
            );
            let publicationUnknown = false;
            try {
              return await this.stdioConnection!.invoke({
                toolName,
                args,
                signal,
                onResponse: () => {
                  responseCompleted = true;
                  clearTimeout(deadline);
                  signal.removeEventListener('abort', invalidate);
                },
              });
            } catch (error) {
              publicationUnknown = error instanceof PublicationOutcomeUnknownError;
              throwIfPublicationOutcomeUnknown(error);
              if (!responseCompleted) {
                try {
                  this.closeAdmission();
                  await this.directContainment();
                } catch (containmentError) {
                  publicationUnknown = containmentError instanceof PublicationOutcomeUnknownError;
                  throw containmentError;
                }
                joinStop = true;
              }
              throw error;
            } finally {
              if (!publicationUnknown) {
                clearTimeout(deadline);
                signal.removeEventListener('abort', invalidate);
              }
            }
          });
        } else {
          admitDispatch();
          result = await invokeStreamableHttpTool({
            outboundHttp: this.#outboundHttp,
            observationSource: options?.observationSource,
            serverName: this.name,
            toolName,
            args,
            config: cfg,
            handle,
            timeoutMs,
            ids: this.#ids,
            signal,
          });
        }
        // A dispatched HTTP call retains its own response even after catalog replacement.
        if (cfg.transport === 'stdio') {
          if (responseCompleted) options?.signal?.throwIfAborted();
          else this.assertAdmissionOpen(signal);
        }
      } catch (err) {
        throwIfPublicationOutcomeUnknown(err);
        if (!dispatched) throw err;
        if (responseCompleted) options?.signal?.throwIfAborted();
        if (!responseCompleted && !this.admissionOpen) throw err;
        if (
          (!responseCompleted && signal.aborted && err === signal.reason) ||
          !(err instanceof McpInvokeError)
        )
          throw err;
        const durationMs = Date.now() - startTime;
        this.#invocationStats.record(this.name, toolName, false);
        this.#invocationStats.publish(this.name, toolName, false, durationMs, err);
        throw err;
      }
      const durationMs = Date.now() - startTime;
      const success = result.isError !== true;
      this.#invocationStats.record(this.name, toolName, success);
      this.#invocationStats.publish(this.name, toolName, success, durationMs);
      return result;
    }, options?.signal);
    // This completion is deliberately not an admitted operation: stop joins inner work.
    return inner.then(
      async (value) => {
        if (joinStop) await this.stop();
        return value;
      },
      async (error) => {
        if (joinStop) await this.stop();
        throw error;
      },
    );
  }

  getStatus(): McpServerStatus {
    return {
      ...buildMcpServerStatus({
        name: this.name,
        config: this.config,
        handle: this.handle,
        override: this.statusOverride,
        startedAt: this.startedAt,
        tools: this.catalog?.tools,
        ready: this.ready,
        starting: this.admissionOpen && this.operations.size > 0 && !this.ready,
      }),
      bindingId: this.bindingId,
      definitionSource: null,
      containmentFailed: this.containmentFailed,
      processId: this.handle?.processId ?? null,
    };
  }
  getTools(): McpToolDefinition[] | undefined {
    return this.getCatalog()?.tools;
  }
  getCatalog(): McpCatalogSnapshot | undefined {
    return this.catalog ? structuredClone(this.catalog) : undefined;
  }
  isRunning(): boolean {
    return Boolean(this.handle);
  }

  private admit<T>(
    operation: (signal: AbortSignal, controller: AbortController) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (callerSignal?.aborted) return Promise.reject(callerSignal.reason);
    if (!this.admissionOpen) return Promise.reject(new ServerNotRunningError(this.name));
    const controller = new AbortController();
    const onCallerAbort = () => {
      throwIfPublicationOutcomeUnknown(callerSignal!.reason);
      controller.abort(callerSignal!.reason);
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    this.controllers.add(controller);
    const result = operation(controller.signal, controller);
    let publicationUnknown = false;
    const tracked = result
      .then(
        () => undefined,
        (error) => {
          publicationUnknown = error instanceof PublicationOutcomeUnknownError;
        },
      )
      .finally(() => {
        if (publicationUnknown) return;
        this.controllers.delete(controller);
        callerSignal?.removeEventListener('abort', onCallerAbort);
        this.operations.delete(tracked);
      });
    this.operations.add(tracked);
    return result;
  }

  private assertAdmissionOpen(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (!this.admissionOpen) throw new ServerNotRunningError(this.name);
  }

  private startStdio(cfg: StdioMcpServerConfig, signal: AbortSignal): void {
    this.assertAdmissionOpen(signal);
    const launch = this.#processRunner.spawnInteractive({
      file: cfg.command,
      args: cfg.args ?? [],
      directScope: this.#processScope,
      category: 'service_infrastructure',
      ownerId: `mcp:${this.name}`,
      ownerKind: 'runtime',
      env: { ...sanitizedCommandEnv(), ...(cfg.env ?? {}) },
      cwd: this.#projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    launch.process.stderr!.on('error', () => undefined);
    launch.process.stderr!.resume();
    this.handle = {
      process: launch.process,
      processId: launch.record.id,
    };
    this.startedAt = new Date().toISOString();
    launch.process.stdin?.on('error', () => undefined);
    if (!launch.process.stdin || !launch.process.stdout)
      throw new Error('Server process has no stdin/stdout');
    this.stdioConnection = new StdioMcpConnection({
      serverName: this.name,
      stdin: launch.process.stdin,
      stdout: launch.process.stdout,
      ids: this.#ids,
      rootUri: this.#projectRoot ? pathToFileURL(this.#projectRoot).href : undefined,
      onFailure: (error) => {
        throwIfPublicationOutcomeUnknown(error);
        this.closeAdmission('transport');
      },
    });
    const observedHandle = this.handle;
    const observerController = new AbortController();
    this.observerController = observerController;
    let publicationUnknown = false;
    let onObserverAbort!: () => void;
    const settlement = Promise.race([
      this.#processRunner.waitForSettlement(launch.record.id),
      new Promise<null>((resolve) => {
        onObserverAbort = () => resolve(null);
        observerController.signal.addEventListener('abort', onObserverAbort, { once: true });
      }),
    ]).then(
      (result) => {
        if (
          !result ||
          this.handle !== observedHandle ||
          this.containmentFailed ||
          (this.closureCause !== 'transport' && !this.admissionOpen)
        )
          return;
        const admissionWasOpen = this.admissionOpen;
        if (admissionWasOpen) this.closeAdmission('transport');
        if (result.record.status === 'exited') this.statusOverride = { status: 'stopped' };
        else
          this.statusOverride = {
            status: 'error',
            error: result.record.signal
              ? 'Process exited with a signal'
              : 'Process exited unsuccessfully',
          };
        this.disposeStdio(new ServerNotRunningError(this.name));
        if (admissionWasOpen) this.handle = undefined;
        this.ready = false;
        this.clearCaches();
        this.#processRunner.retireSettled(launch.record.id, this.#processScope);
        delete observedHandle.processId;
      },
      (error) => {
        publicationUnknown = error instanceof PublicationOutcomeUnknownError;
        throwIfPublicationOutcomeUnknown(error);
        if (
          this.handle !== observedHandle ||
          this.containmentFailed ||
          (this.closureCause !== 'transport' && !this.admissionOpen)
        )
          return;
        const observedRecord = this.#processRunner.get(launch.record.id);
        if (
          error instanceof ProcessEvidenceUnavailableError ||
          observedRecord?.status === 'unavailable'
        ) {
          if (!(error instanceof ProcessEvidenceUnavailableError))
            this.observedCaptureError = error;
          if (this.admissionOpen) this.closeAdmission('transport');
          this.statusOverride = {
            status: 'error',
            error: 'Process evidence unavailable; containment unconfirmed',
          };
          this.ready = false;
          this.clearCaches();
          return;
        }
        this.observedCaptureError = error;
        const admissionWasOpen = this.admissionOpen;
        if (admissionWasOpen) this.closeAdmission('transport');
        this.statusOverride = { status: 'error', error: 'Process output capture failed' };
        this.disposeStdio(new ServerNotRunningError(this.name));
        if (admissionWasOpen) this.handle = undefined;
        this.ready = false;
        this.clearCaches();
        this.#processRunner.retireSettled(launch.record.id, this.#processScope);
        delete observedHandle.processId;
      },
    );
    const tracked = settlement
      .catch((error) => {
        publicationUnknown = error instanceof PublicationOutcomeUnknownError;
        throw error;
      })
      .finally(() => {
        if (publicationUnknown) return;
        observerController.signal.removeEventListener('abort', onObserverAbort);
        this.observerController = undefined;
        this.operations.delete(tracked);
      });
    this.operations.add(tracked);
    void tracked.catch(() => undefined);
  }

  private startStreamableHttp(): void {
    const abortController = new AbortController();
    this.handle = { abortController };
    this.startedAt = new Date().toISOString();
  }

  private async initializeTransport(
    signal: AbortSignal,
    observationSource?: OutboundObservationSource,
  ): Promise<void> {
    if (this.config.transport === 'stdio') await this.stdioConnection!.initialize(signal);
    else
      await initializeStreamableHttp({
        outboundHttp: this.#outboundHttp,
        observationSource,
        serverName: this.name,
        config: this.config,
        handle: this.handle,
        ids: this.#ids,
        signal,
      });
  }

  private listTools(
    signal: AbortSignal,
    observationSource?: OutboundObservationSource,
  ): Promise<McpToolDefinition[]> {
    return this.config.transport === 'stdio'
      ? this.stdioConnection!.listTools(signal)
      : listStreamableHttpTools({
          outboundHttp: this.#outboundHttp,
          observationSource,
          serverName: this.name,
          config: this.config,
          handle: this.handle,
          ids: this.#ids,
          signal,
        });
  }

  private clearCaches(): void {
    this.catalog = undefined;
    this.argumentValidatorCache.clear();
    this.stdioExchangeQueue = undefined;
  }

  private disposeStdio(reason: unknown): void {
    this.stdioConnection?.dispose(reason);
    this.stdioConnection = undefined;
  }

  private validateToolArguments(
    toolName: string,
    inputSchema: unknown,
    args: Record<string, unknown>,
  ): void {
    const cacheKey = `${toolName}:${fingerprintMcpInputSchema(inputSchema)}`;
    let compiled = this.argumentValidatorCache.get(cacheKey);
    if (!compiled) {
      compiled = compileMcpArgumentValidator(inputSchema);
      this.argumentValidatorCache.set(cacheKey, compiled);
    }
    const result = validateMcpArguments(compiled, args);
    if (!result.ok)
      throw new InvalidArgumentsError(this.name, toolName, {
        source: 'local_input_schema_validation',
        reason: result.type,
        diagnostics: result.diagnostics,
      });
  }

  private enqueueStdioExchange<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.stdioExchangeQueue ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.stdioExchangeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
