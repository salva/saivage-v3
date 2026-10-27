import { canonicalValueSha256, mcpConnectionSchema, type McpConnection } from '../schemas/index.js';
import {
  throwIfPublicationOutcomeUnknown,
  type OutboundHttpEmitter,
  type OutboundObservationSource,
} from '../contracts/index.js';
import type { ResolvedConfigAuthority } from '../config/index.js';
import type { EventLog } from '../observability/index.js';
import type { ProcessRunner } from '../runtime/runtime-api.js';
import type { ManagedProcessScope, ProcessStopReport } from '../runtime/runtime-api.js';
import { McpLifecycleError, ServerNotRunningError } from './errors.js';
import { McpInvocationStatsRecorder } from './invocation-stats.js';
import type {
  McpServerStatus,
  McpToolDefinition,
  McpCatalogSnapshot,
  McpCatalogRefreshResult,
} from './protocol.js';
import { type McpServerConfig } from './server-registry.js';
import { McpServerRuntime } from './server-runtime.js';
import type { NativeMcpResult } from './native-result.js';
import { buildMcpToolsReadModel } from './status-projection.js';
import { readMcpServerDefinitions, replaceMcpServerDefinitions } from './server-definitions.js';

export interface McpStatusProvider {
  getStatus(): McpServerStatus[];
}
export interface McpToolsReadModelProvider {
  getToolsReadModel(): ReturnType<typeof buildMcpToolsReadModel>;
}
type McpToolCapability = McpToolDefinition & {
  serverName: string;
  bindingId: string;
  catalogId: string;
};
export interface McpToolInvocationPort {
  registerServer(name: string, connection: McpConnection): { serverName: string; registered: true };
  replaceServer(
    name: string,
    connection: McpConnection,
  ): { serverName: string; replaced: true; status: 'stopped' };
  unregisterServer(
    name: string,
  ): Promise<{ serverName: string; unregistered: true; status: 'stopped' }>;
  getStatus(): McpServerStatus[];
  getServerStatus(name: string): McpServerStatus | undefined;
  startServer(
    name: string,
    options?: { signal?: AbortSignal; observationSource?: OutboundObservationSource },
  ): Promise<McpLifecycleResult>;
  stopServer(name: string): Promise<McpLifecycleResult>;
  restartServer(
    name: string,
    options?: { signal?: AbortSignal; observationSource?: OutboundObservationSource },
  ): Promise<McpLifecycleResult>;
  getServerCatalog(name: string): McpCatalogSnapshot | undefined;
  refreshServerCatalog(
    name: string,
    bindingId: string,
    options?: { signal?: AbortSignal; observationSource?: OutboundObservationSource },
  ): Promise<McpCatalogRefreshResult>;
  findToolCapability(serverName: string, toolName: string): McpToolCapability | null;
  invokeTool(
    serverName: string,
    bindingId: string,
    catalogId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      observationSource?: OutboundObservationSource;
    },
  ): Promise<NativeMcpResult>;
}

interface McpLifecycleResult {
  serverName: string;
  status: 'running' | 'stopped';
  toolCount: number;
}

interface McpReconciliationReport {
  converged: boolean;
  desired: Array<{ name: string; revision: string; shouldRun: boolean }>;
  active: Array<{ name: string; revision: string; state: 'running' | 'stopped' }>;
  pending: Array<{
    name: string;
    operation: 'add' | 'remove' | 'replace' | 'start' | 'stop';
    diagnostic: string;
  }>;
}
interface McpReconciliationPort {
  reconcilePersistedConfig(): Promise<McpReconciliationReport>;
}
interface McpManagerOptions {
  nativeGit: boolean;
  outboundHttp?: OutboundHttpEmitter;
  configAuthority: ResolvedConfigAuthority;
  processRunner: ProcessRunner;
  mcpProcessRootScope: ManagedProcessScope;
  eventLogger: EventLog;
}

interface DesiredServer {
  name: string;
  config: McpServerConfig;
  revision: string;
  shouldRun: boolean;
}

function revisionOf(config: McpServerConfig): string {
  return canonicalValueSha256(config);
}

export class McpManager implements McpReconciliationPort {
  private readonly nativeGit: boolean;
  private readonly outboundHttp?: OutboundHttpEmitter;
  readonly #processRunner: ProcessRunner;
  readonly #mcpProcessRootScope: ManagedProcessScope;
  readonly #runtimes = new Map<string, McpServerRuntime>();
  private readonly configAuthority: ResolvedConfigAuthority;
  private nextMsgId = 1;
  private readonly invocationStats: McpInvocationStatsRecorder;
  private reconciliationTail: Promise<void> = Promise.resolve();
  private currentReconciliation: Promise<McpReconciliationReport> | null = null;
  private admissionOpen = true;

  constructor({
    nativeGit,
    configAuthority,
    processRunner,
    mcpProcessRootScope,
    eventLogger,
    outboundHttp,
  }: McpManagerOptions) {
    this.nativeGit = nativeGit;
    this.configAuthority = configAuthority;
    this.outboundHttp = outboundHttp;
    this.#processRunner = processRunner;
    this.#mcpProcessRootScope = mcpProcessRootScope;
    this.invocationStats = new McpInvocationStatsRecorder(eventLogger);
  }

  next(): number {
    return this.nextMsgId++;
  }

  private assertNativeSourceCapability(): void {
    if (this.nativeGit)
      throw new McpLifecycleError(
        'Native Git refuses MCP writers with unknown source footprint.',
        409,
      );
  }

  hasPendingReconciliation(): boolean {
    return this.currentReconciliation !== null;
  }

  hasWorkGcBlocker(): boolean {
    return (
      this.currentReconciliation !== null ||
      [...this.#runtimes.values()].some((runtime) => runtime.hasWorkGcBlocker())
    );
  }
  getInvocationStats(): Record<
    string,
    { total: number; success: number; error: number; lastInvokedAt?: string }
  > {
    return this.invocationStats.snapshot();
  }

  reconcilePersistedConfig(): Promise<McpReconciliationReport> {
    if (!this.admissionOpen)
      return Promise.reject(new Error('MCP reconciliation admission is closed.'));
    const run = this.reconciliationTail.then(() => this.reconcileTurn());
    this.currentReconciliation = run;
    this.reconciliationTail = run.then(
      () => undefined,
      () => undefined,
    );
    void run
      .finally(() => {
        if (this.currentReconciliation === run) this.currentReconciliation = null;
      })
      .catch(() => undefined);
    return run;
  }

  closeAdmission(): void {
    if (!this.admissionOpen) return;
    this.admissionOpen = false;
    const runtimes = [...this.#runtimes.values()];
    for (const runtime of runtimes) runtime.closeAdmission();
  }

  async cleanupForApplicationStop(): Promise<void> {
    this.closeAdmission();
    const runtimes = [...this.#runtimes.values()];
    const runtimeStops = runtimes.map((runtime) => runtime.stop());
    let termination: Promise<import('../runtime/runtime-api.js').ProcessStopReport>;
    try {
      termination = this.#processRunner.terminateScopeTree({
        rootScope: this.#mcpProcessRootScope,
        categories: ['service_infrastructure'],
        reason: 'application stopping',
      });
    } catch (error) {
      termination = Promise.reject(error);
    }
    const reconciliation = this.currentReconciliation ?? Promise.resolve();
    const settlements = await Promise.allSettled([...runtimeStops, termination, reconciliation]);
    const terminationSettlement = settlements[
      runtimeStops.length
    ]! as PromiseSettledResult<ProcessStopReport>;
    if (terminationSettlement.status === 'rejected') throw terminationSettlement.reason;
    if (terminationSettlement.value.failed.length !== 0)
      throw new Error('MCP application cleanup failed.');
    const failed = settlements.find((settlement) => settlement.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    this.#runtimes.clear();
  }

  getStatus(): McpServerStatus[] {
    const { configs, sources } = this.loadDefinitions();
    const names = new Set([...Object.keys(configs), ...this.#runtimes.keys()]);
    return [...names].map((name) => {
      const runtime = this.#runtimes.get(name);
      if (runtime) return { ...runtime.getStatus(), definitionSource: sources.get(name) ?? null };
      return {
        name,
        transport: configs[name]!.transport,
        status: 'stopped',
        bindingId: null,
        definitionSource: sources.get(name)!,
        containmentFailed: false,
        processId: null,
        tools_count: 0,
      };
    });
  }
  getServerStatus(name: string): McpServerStatus | undefined {
    return this.getStatus().find((status) => status.name === name);
  }
  getServerCatalog(name: string): McpCatalogSnapshot | undefined {
    const runtime = this.#runtimes.get(name);
    if (!runtime) throw new McpLifecycleError(`Unknown MCP server '${name}'.`, 404);
    return runtime.getCatalog();
  }

  refreshServerCatalog(
    name: string,
    bindingId: string,
    options?: { signal?: AbortSignal; observationSource?: OutboundObservationSource },
  ): Promise<McpCatalogRefreshResult> {
    this.assertNativeSourceCapability();
    options?.signal?.throwIfAborted();
    this.assertAdmission();
    const { configs } = this.loadDefinitions();
    const config = configs[name];
    if (!config) throw new McpLifecycleError(`Unknown configured MCP server '${name}'.`, 404);
    if (config.disabled) throw new McpLifecycleError(`MCP server '${name}' is disabled.`, 409);
    const runtime = this.#runtimes.get(name);
    if (!runtime?.isReady()) throw new ServerNotRunningError(name);
    if (runtime.revision !== revisionOf(config))
      throw new McpLifecycleError(
        'MCP configuration changed; catalog refresh does not reconcile configuration.',
        409,
      );
    return runtime.refreshCatalog(bindingId, options);
  }

  async startServer(
    name: string,
    options?: { signal?: AbortSignal; observationSource?: OutboundObservationSource },
  ): Promise<McpLifecycleResult> {
    this.assertNativeSourceCapability();
    const signal = options?.signal;
    signal?.throwIfAborted();
    this.assertAdmission();
    const dynamic = readMcpServerDefinitions(this.#processRunner.projectRoot);
    const operator = this.configAuthority.loadMcpServer(name);
    if (operator && Object.hasOwn(dynamic, name))
      throw new McpLifecycleError(`MCP server '${name}' has conflicting definition sources.`, 409);
    const isDynamic = Object.hasOwn(dynamic, name);
    const config = operator ?? (isDynamic ? this.dynamicConfig(dynamic[name]!) : undefined);
    if (!config) throw new McpLifecycleError(`Unknown configured MCP server '${name}'.`, 404);
    if (config.disabled) throw new McpLifecycleError(`MCP server '${name}' is disabled.`, 409);
    const revision = revisionOf(config);
    let runtime = this.#runtimes.get(name);
    if (runtime && !runtime.isContained()) {
      if (runtime.revision !== revision) {
        if (isDynamic)
          throw new McpLifecycleError('Stop before starting changed configuration.', 409);
        if (runtime.isRunning() || !runtime.isAdmissionOpen())
          throw new McpLifecycleError('Stop before starting changed configuration.', 409);
        await runtime.stop();
        this.assertAdmission();
        signal?.throwIfAborted();
      }
      if (runtime.isReady())
        return { serverName: name, status: 'running', toolCount: runtime.getTools()!.length };
      if (!runtime.isContained() && (runtime.isRunning() || !runtime.isAdmissionOpen()))
        throw new McpLifecycleError(`MCP server '${name}' is busy or requires containment.`, 409);
    }
    if (!runtime || runtime.isContained()) {
      runtime = this.createRuntime({ name, config, revision, shouldRun: true });
      this.#runtimes.set(name, runtime);
    }
    await runtime.start(options);
    if (!runtime.isReady()) throw new ServerNotRunningError(name);
    return { serverName: name, status: 'running', toolCount: runtime.getTools()!.length };
  }

  async stopServer(name: string): Promise<McpLifecycleResult> {
    this.assertAdmission();
    const runtime = this.#runtimes.get(name);
    if (!runtime) throw new McpLifecycleError(`Unknown MCP owner '${name}'.`, 404);
    await runtime.stop();
    return { serverName: name, status: 'stopped', toolCount: 0 };
  }

  async restartServer(
    name: string,
    options?: { signal?: AbortSignal; observationSource?: OutboundObservationSource },
  ): Promise<McpLifecycleResult> {
    this.assertNativeSourceCapability();
    options?.signal?.throwIfAborted();
    this.assertAdmission();
    const runtime = this.#runtimes.get(name);
    if (!runtime) throw new McpLifecycleError(`Unknown MCP owner '${name}'.`, 404);
    await runtime.stop();
    this.assertAdmission();
    options?.signal?.throwIfAborted();
    if (this.#runtimes.get(name) !== runtime)
      throw new McpLifecycleError(`MCP owner '${name}' changed during restart.`, 409);
    return this.startServer(name, options);
  }

  registerServer(
    name: string,
    connection: McpConnection,
  ): { serverName: string; registered: true } {
    this.assertNativeSourceCapability();
    this.assertAdmission();
    if (!name.length) throw new McpLifecycleError('MCP server name must be nonempty.', 409);
    const parsed = mcpConnectionSchema.safeParse(connection);
    if (!parsed.success) throw new McpLifecycleError('Invalid MCP connection.', 409);
    const dynamic = readMcpServerDefinitions(this.#processRunner.projectRoot);
    if (this.configAuthority.loadMcpServer(name) || Object.hasOwn(dynamic, name))
      throw new McpLifecycleError(`MCP server '${name}' already has a definition.`, 409);
    const runtime = this.#runtimes.get(name);
    if (runtime && !runtime.isContained())
      throw new McpLifecycleError(`MCP server '${name}' requires containment.`, 409);
    Object.defineProperty(dynamic, name, {
      value: parsed.data,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    replaceMcpServerDefinitions(this.#processRunner.projectRoot, dynamic);
    return { serverName: name, registered: true };
  }

  replaceServer(
    name: string,
    connection: McpConnection,
  ): { serverName: string; replaced: true; status: 'stopped' } {
    this.assertNativeSourceCapability();
    this.assertAdmission();
    if (!name.length) throw new McpLifecycleError('MCP server name must be nonempty.', 409);
    const parsed = mcpConnectionSchema.safeParse(connection);
    if (!parsed.success) throw new McpLifecycleError('Invalid MCP connection.', 409);
    const dynamic = readMcpServerDefinitions(this.#processRunner.projectRoot);
    if (this.configAuthority.loadMcpServer(name) || !Object.hasOwn(dynamic, name))
      throw new McpLifecycleError(
        `MCP server '${name}' is not an exclusively agent-owned definition.`,
        409,
      );
    const runtime = this.#runtimes.get(name);
    if (runtime && !runtime.canReplaceDefinition())
      throw new McpLifecycleError(`MCP server '${name}' requires completed containment.`, 409);
    Object.defineProperty(dynamic, name, {
      value: parsed.data,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    replaceMcpServerDefinitions(this.#processRunner.projectRoot, dynamic);
    this.#runtimes.delete(name);
    return { serverName: name, replaced: true, status: 'stopped' };
  }

  async unregisterServer(
    name: string,
  ): Promise<{ serverName: string; unregistered: true; status: 'stopped' }> {
    this.assertAdmission();
    const dynamic = readMcpServerDefinitions(this.#processRunner.projectRoot);
    if (this.configAuthority.loadMcpServer(name) || !Object.hasOwn(dynamic, name))
      throw new McpLifecycleError(
        `MCP server '${name}' is not an exclusively agent-owned definition.`,
        409,
      );
    const runtime = this.#runtimes.get(name);
    delete dynamic[name];
    replaceMcpServerDefinitions(this.#processRunner.projectRoot, dynamic);
    // Publication must succeed before fencing. stop enters closure before its first await.
    if (runtime) await runtime.stop();
    return { serverName: name, unregistered: true, status: 'stopped' };
  }

  async invokeTool(
    serverName: string,
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
    this.assertNativeSourceCapability();
    options?.signal?.throwIfAborted();
    if (!this.admissionOpen) throw new ServerNotRunningError(serverName);
    const runtime = this.#runtimes.get(serverName);
    if (!runtime) throw new ServerNotRunningError(serverName);
    if (!runtime.isReady()) throw new ServerNotRunningError(serverName);
    if (runtime.bindingId !== bindingId)
      throw new McpLifecycleError('Stale MCP binding; discover tools again before invoking.', 409);
    return runtime.invokeTool(bindingId, catalogId, toolName, args, options);
  }

  getToolsReadModel(): ReturnType<typeof buildMcpToolsReadModel> {
    return buildMcpToolsReadModel({
      statuses: this.getStatus(),
      getServerTools: (name) => this.#runtimes.get(name)?.getTools(),
      invocationStats: this.getInvocationStats(),
    });
  }

  findToolCapability(serverName: string, toolName: string): McpToolCapability | null {
    const catalog = this.getServerCatalog(serverName);
    const tool = catalog?.tools.find((candidate) => candidate.name === toolName);
    return tool && catalog
      ? { ...tool, serverName, bindingId: catalog.bindingId, catalogId: catalog.catalogId }
      : null;
  }

  private async reconcileTurn(): Promise<McpReconciliationReport> {
    if (!this.admissionOpen) throw new Error('MCP reconciliation admission is closed.');
    const { configs } = this.loadDefinitions();
    const desired = Object.entries(configs)
      .map(
        ([name, config]): DesiredServer => ({
          name,
          config,
          revision: revisionOf(config),
          shouldRun: !config.disabled && config.autostart,
        }),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    if (this.nativeGit && desired.some((entry) => !entry.config.disabled))
      this.assertNativeSourceCapability();
    const desiredByName = new Map(desired.map((entry) => [entry.name, entry]));
    const destructive = [...this.#runtimes.values()].filter((runtime) => {
      const target = desiredByName.get(runtime.name);
      return !target || target.revision !== runtime.revision;
    });
    if (destructive.length > 1) {
      return {
        converged: false,
        desired: desired.map(({ name, revision, shouldRun }) => ({ name, revision, shouldRun })),
        active: [...this.#runtimes.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((runtime) => ({
            name: runtime.name,
            revision: runtime.revision,
            state: runtime.isRunning() ? 'running' : 'stopped',
          })),
        pending: destructive
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((runtime) => ({
            name: runtime.name,
            operation: desiredByName.has(runtime.name) ? ('replace' as const) : ('remove' as const),
            diagnostic:
              'MCP reconciliation requires at most one destructive remove or replace target.',
          })),
      };
    }

    const pending: McpReconciliationReport['pending'] = [];
    const replacedNames = new Set<string>();
    for (const runtime of destructive) {
      const target = desiredByName.get(runtime.name);
      const operation = target ? 'replace' : 'remove';
      try {
        await runtime.stop();
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        pending.push({
          name: runtime.name,
          operation,
          diagnostic: `MCP server '${runtime.name}' could not be contained.`,
        });
        continue;
      }
      this.#runtimes.delete(runtime.name);
      if (target) replacedNames.add(runtime.name);
    }

    for (const target of desired) {
      let runtime = this.#runtimes.get(target.name);
      if (runtime && runtime.revision !== target.revision) continue;
      let startOperation: 'add' | 'replace' | 'start' = 'start';
      if (!runtime) {
        this.assertAdmission();
        runtime = this.createRuntime(target);
        this.#runtimes.set(target.name, runtime);
        startOperation = replacedNames.has(target.name) ? 'replace' : 'add';
      }
      if (!target.shouldRun) {
        if (runtime.isRunning()) {
          try {
            await runtime.stop();
          } catch (error) {
            throwIfPublicationOutcomeUnknown(error);
            pending.push({
              name: target.name,
              operation: 'stop',
              diagnostic: `MCP server '${target.name}' could not be contained.`,
            });
          }
        }
        continue;
      }
      if (runtime.isReady()) continue;
      if (runtime.isContained()) {
        this.assertAdmission();
        runtime = this.createRuntime(target);
        this.#runtimes.set(target.name, runtime);
      } else if (runtime.isRunning()) {
        pending.push({
          name: target.name,
          operation: 'start',
          diagnostic: `MCP server '${target.name}' has not completed startup.`,
        });
        continue;
      }
      try {
        this.assertAdmission();
        await runtime.start();
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        pending.push({
          name: target.name,
          operation: startOperation,
          diagnostic: `MCP server '${target.name}' failed to start.`,
        });
      }
    }

    const report: McpReconciliationReport = {
      converged: false,
      desired: desired.map(({ name, revision, shouldRun }) => ({ name, revision, shouldRun })),
      active: [...this.#runtimes.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((runtime) => ({
          name: runtime.name,
          revision: runtime.revision,
          state: runtime.isRunning() ? 'running' : 'stopped',
        })),
      pending,
    };
    report.converged =
      pending.length === 0 &&
      report.desired.every((target) => {
        const runtime = this.#runtimes.get(target.name);
        return (
          runtime?.revision === target.revision &&
          (target.shouldRun ? runtime.isReady() : !runtime.isRunning())
        );
      }) &&
      report.active.every((runtime) => desiredByName.has(runtime.name));
    return report;
  }

  private createRuntime(target: DesiredServer): McpServerRuntime {
    return new McpServerRuntime({
      outboundHttp: this.outboundHttp,
      name: target.name,
      config: target.config,
      revision: target.revision,
      processRunner: this.#processRunner,
      processScope: this.#processRunner.createDirectScope(
        this.#mcpProcessRootScope,
        `mcp-server:${target.name}:${target.revision}`,
        'service_infrastructure',
      ),
      ids: this,
      invocationStats: this.invocationStats,
      projectRoot: this.#processRunner.projectRoot,
    });
  }

  private assertAdmission(): void {
    if (!this.admissionOpen) throw new Error('MCP reconciliation admission is closed.');
  }

  private dynamicConfig(connection: McpConnection): McpServerConfig {
    return { ...connection, disabled: false, autostart: false };
  }

  private loadDefinitions(): {
    configs: Record<string, McpServerConfig>;
    sources: Map<string, 'operator' | 'agent'>;
  } {
    const operator = this.configAuthority.loadMcpServers();
    const dynamic = readMcpServerDefinitions(this.#processRunner.projectRoot);
    const configs = { ...operator };
    const sources = new Map<string, 'operator' | 'agent'>(
      Object.keys(operator).map((name) => [name, 'operator']),
    );
    for (const [name, connection] of Object.entries(dynamic)) {
      if (Object.hasOwn(operator, name))
        throw new McpLifecycleError(
          `MCP server '${name}' has conflicting definition sources.`,
          409,
        );
      Object.defineProperty(configs, name, {
        value: this.dynamicConfig(connection),
        enumerable: true,
      });
      sources.set(name, 'agent');
    }
    return { configs, sources };
  }
}
