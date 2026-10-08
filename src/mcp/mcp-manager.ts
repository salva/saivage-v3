import { canonicalValueSha256 } from '../schemas/index.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import type { ResolvedConfigAuthority } from '../config/index.js';
import type { EventLog } from '../observability/index.js';
import type { ProcessRunner } from '../runtime/runtime-api.js';
import type { ManagedProcessScope, ProcessStopReport } from '../runtime/runtime-api.js';
import { McpLifecycleError, ServerNotRunningError } from './errors.js';
import { McpInvocationStatsRecorder } from './invocation-stats.js';
import { type McpServerStatus, type McpToolDefinition } from './protocol.js';
import { loadMcpServersFromConfig, type McpServerConfig } from './server-registry.js';
import { McpServerRuntime } from './server-runtime.js';
import { buildMcpToolsReadModel } from './status-projection.js';

export interface McpStatusProvider {
  getStatus(): McpServerStatus[];
}
export interface McpToolsReadModelProvider {
  getToolsReadModel(): ReturnType<typeof buildMcpToolsReadModel>;
}
type McpToolCapability = McpToolDefinition & { serverName: string };
export interface McpToolInvocationPort {
  startServer(name: string, signal?: AbortSignal): Promise<McpLifecycleResult>;
  stopServer(name: string): Promise<McpLifecycleResult>;
  getServerTools(name: string): McpToolDefinition[] | undefined;
  findToolCapability(serverName: string, toolName: string): McpToolCapability | null;
  invokeTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
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
    configAuthority,
    processRunner,
    mcpProcessRootScope,
    eventLogger,
  }: McpManagerOptions) {
    this.configAuthority = configAuthority;
    this.#processRunner = processRunner;
    this.#mcpProcessRootScope = mcpProcessRootScope;
    this.invocationStats = new McpInvocationStatsRecorder(eventLogger);
  }

  next(): number {
    return this.nextMsgId++;
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
    return [...this.#runtimes.values()].map((runtime) => runtime.getStatus());
  }
  getServerStatus(name: string): McpServerStatus | undefined {
    return this.#runtimes.get(name)?.getStatus();
  }
  getTools(): McpToolDefinition[] {
    return [...this.#runtimes.values()].flatMap((runtime) => runtime.getTools() ?? []);
  }
  getServerTools(name: string): McpToolDefinition[] | undefined {
    const runtime = this.#runtimes.get(name);
    if (!runtime) throw new McpLifecycleError(`Unknown MCP server '${name}'.`, 404);
    return runtime.getTools();
  }

  async startServer(name: string, signal?: AbortSignal): Promise<McpLifecycleResult> {
    signal?.throwIfAborted();
    this.assertAdmission();
    const config = this.configAuthority.loadMcpServer(name);
    if (!config) throw new McpLifecycleError(`Unknown configured MCP server '${name}'.`, 404);
    if (config.disabled) throw new McpLifecycleError(`MCP server '${name}' is disabled.`, 409);
    const revision = revisionOf(config);
    let runtime = this.#runtimes.get(name);
    if (runtime && !runtime.isContained()) {
      if (runtime.revision !== revision) {
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
    await runtime.start(signal);
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
  getToolServers(): string[] {
    return [...this.#runtimes.values()]
      .filter((runtime) => runtime.getTools() !== undefined)
      .map((runtime) => runtime.name);
  }

  async invokeTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    options?.signal?.throwIfAborted();
    if (!this.admissionOpen) throw new ServerNotRunningError(serverName);
    const runtime = this.#runtimes.get(serverName);
    if (!runtime) throw new ServerNotRunningError(serverName);
    return runtime.invokeTool(toolName, args, options);
  }

  async healthCheck(name: string): Promise<boolean> {
    return this.#runtimes.get(name)?.healthCheck() ?? false;
  }

  getToolsReadModel(): ReturnType<typeof buildMcpToolsReadModel> {
    return buildMcpToolsReadModel({
      statuses: this.getStatus(),
      getServerTools: (name) => this.getServerTools(name),
      invocationStats: this.getInvocationStats(),
    });
  }

  findToolCapability(serverName: string, toolName: string): McpToolCapability | null {
    const tool = this.getServerTools(serverName)?.find((candidate) => candidate.name === toolName);
    return tool ? { ...tool, serverName } : null;
  }

  private async reconcileTurn(): Promise<McpReconciliationReport> {
    if (!this.admissionOpen) throw new Error('MCP reconciliation admission is closed.');
    const configs = loadMcpServersFromConfig(this.configAuthority.loadEffective().config);
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
}
