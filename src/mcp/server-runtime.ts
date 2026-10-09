import type { ManagedProcessScope, ProcessRunner } from '../runtime/runtime-api.js';
import { ProcessEvidenceUnavailableError } from '../runtime/runtime-api.js';
import { pathToFileURL } from 'node:url';
import {
  PublicationOutcomeUnknownError,
  throwIfPublicationOutcomeUnknown,
} from '../contracts/index.js';
import type { StdioMcpServerConfig, StreamableHttpMcpServerConfig } from '../schemas/index.js';
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
  type McpServerStatus,
  type McpStatus,
  type McpToolDefinition,
} from './protocol.js';
import type { McpServerConfig, McpServerHandle } from './server-registry.js';
import { McpInvocationStatsRecorder } from './invocation-stats.js';
import { buildMcpServerStatus } from './status-projection.js';
import {
  discoverStreamableHttpTools,
  healthStreamableHttpServer,
  invokeStreamableHttpTool,
  probeStreamableHttpStartup,
} from './streamable-http-transport.js';
import { StdioMcpConnection } from './stdio-transport.js';
import type { NativeMcpResult } from './native-result.js';

interface McpJsonRpcIdProvider {
  next(): number | string;
}

interface McpServerRuntimeOptions {
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
  private tools?: McpToolDefinition[];
  private readonly argumentValidatorCache = new Map<string, CachedMcpArgumentValidator>();
  private stdioInvocationQueue?: Promise<void>;
  private generation = 0;
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
  }: McpServerRuntimeOptions) {
    this.#name = name;
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

  start(callerSignal?: AbortSignal): Promise<void> {
    if (callerSignal?.aborted) return Promise.reject(callerSignal.reason);
    if (this.operations.size || this.handle)
      return Promise.reject(new McpLifecycleError(`MCP server '${this.name}' is busy.`, 409));
    let joinStop = false;
    const inner = this.admit(async (generation, signal, controller) => {
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
        if (cfg.transport === 'stdio') this.startStdio(cfg, generation, signal);
        else await this.startStreamableHttp(cfg, generation, signal);
        this.assertCurrent(generation, signal);
        const tools = await this.discoverTools(signal);
        this.assertCurrent(generation, signal);
        this.tools = tools;
        this.argumentValidatorCache.clear();
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
    this.generation += 1;
    this.ready = false;
    this.tools = undefined;
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

  invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    let joinStop = false;
    const inner = this.admit(async (generation, signal, controller) => {
      const cfg = this.config;
      const handle = this.handle;
      if (!handle || !this.ready) throw new ServerNotRunningError(this.name);
      if (cfg.transport === 'stdio') {
        if (
          !handle.process ||
          !handle.processId ||
          this.#processRunner.get(handle.processId)?.status !== 'running'
        )
          throw new ServerNotRunningError(this.name);
      } else if (!handle.abortController || handle.abortController.signal.aborted)
        throw new ServerNotRunningError(this.name);

      const toolDefinition = this.tools?.find((tool) => tool.name === toolName);
      if (!toolDefinition) throw new ToolNotFoundError(this.name, toolName);
      this.validateToolArguments(toolName, toolDefinition.inputSchema, args);
      const startTime = Date.now();
      const timeoutMs = options?.timeoutMs ?? MCP_INVOKE_TIMEOUT_MS;
      let result: NativeMcpResult;
      let responseCompleted = false;
      try {
        result =
          cfg.transport === 'stdio'
            ? await this.enqueueStdioInvocation(async () => {
                this.assertCurrent(generation, signal);
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
                      publicationUnknown =
                        containmentError instanceof PublicationOutcomeUnknownError;
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
              })
            : await invokeStreamableHttpTool({
                serverName: this.name,
                toolName,
                args,
                config: cfg,
                handle,
                timeoutMs,
                ids: this.#ids,
                signal,
              });
        if (responseCompleted) options?.signal?.throwIfAborted();
        else this.assertCurrent(generation, signal);
      } catch (err) {
        throwIfPublicationOutcomeUnknown(err);
        if (responseCompleted) options?.signal?.throwIfAborted();
        if (!responseCompleted && generation !== this.generation) throw err;
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

  healthCheck(): Promise<boolean> {
    return this.admit(async (_generation, signal) => {
      const cfg = this.config;
      if (cfg.disabled || !this.ready) return false;
      if (cfg.transport === 'stdio')
        return Boolean(
          this.handle?.processId &&
          this.#processRunner.get(this.handle.processId)?.status === 'running',
        );
      return healthStreamableHttpServer({
        serverName: this.name,
        config: cfg,
        handle: this.handle,
        signal,
      });
    });
  }

  getStatus(): McpServerStatus {
    return buildMcpServerStatus({
      name: this.name,
      config: this.config,
      handle: this.handle,
      override: this.statusOverride,
      startedAt: this.startedAt,
      tools: this.tools,
    });
  }
  getTools(): McpToolDefinition[] | undefined {
    return this.tools;
  }
  isRunning(): boolean {
    return Boolean(this.handle);
  }

  private admit<T>(
    operation: (generation: number, signal: AbortSignal, controller: AbortController) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (callerSignal?.aborted) return Promise.reject(callerSignal.reason);
    if (!this.admissionOpen) return Promise.reject(new ServerNotRunningError(this.name));
    const generation = this.generation;
    const controller = new AbortController();
    const onCallerAbort = () => {
      throwIfPublicationOutcomeUnknown(callerSignal!.reason);
      controller.abort(callerSignal!.reason);
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    this.controllers.add(controller);
    const result = operation(generation, controller.signal, controller);
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

  private assertCurrent(generation: number, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (generation !== this.generation || !this.admissionOpen)
      throw new ServerNotRunningError(this.name);
  }

  private startStdio(cfg: StdioMcpServerConfig, generation: number, signal: AbortSignal): void {
    this.assertCurrent(generation, signal);
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
          (this.closureCause !== 'transport' &&
            (generation !== this.generation || !this.admissionOpen))
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
      },
      (error) => {
        publicationUnknown = error instanceof PublicationOutcomeUnknownError;
        throwIfPublicationOutcomeUnknown(error);
        if (
          this.handle !== observedHandle ||
          this.containmentFailed ||
          (this.closureCause !== 'transport' &&
            (generation !== this.generation || !this.admissionOpen))
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

  private async startStreamableHttp(
    cfg: StreamableHttpMcpServerConfig,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const abortController = new AbortController();
    this.handle = { abortController };
    this.startedAt = new Date().toISOString();
    await probeStreamableHttpStartup({
      serverName: this.name,
      config: cfg,
      signal,
    });
    this.assertCurrent(generation, signal);
  }

  private discoverTools(signal: AbortSignal): Promise<McpToolDefinition[]> {
    return this.config.transport === 'stdio'
      ? this.stdioConnection!.discover(signal)
      : discoverStreamableHttpTools({
          serverName: this.name,
          config: this.config,
          handle: this.handle,
          ids: this.#ids,
          signal,
        });
  }

  private clearCaches(): void {
    this.tools = undefined;
    this.argumentValidatorCache.clear();
    this.stdioInvocationQueue = undefined;
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

  private enqueueStdioInvocation<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.stdioInvocationQueue ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.stdioInvocationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
