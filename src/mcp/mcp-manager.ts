import { createHash } from 'node:crypto';
import type { ResolvedConfigAuthority } from '../config/index.js';
import type { EventLog } from '../observability/index.js';
import type { ProcessRunner } from '../runtime/process-runner.js';
import { ServerNotRunningError } from './errors.js';
import { McpInvocationStatsRecorder } from './invocation-stats.js';
import { type McpServerStatus, type McpToolDefinition } from './protocol.js';
import { loadMcpServersFromConfig, type McpServerConfig } from './server-registry.js';
import { McpServerRuntime } from './server-runtime.js';
import { buildMcpToolsReadModel } from './status-projection.js';

export type { McpServerConfig, McpServerHandle } from './server-registry.js';
export type { McpTransport, McpStatus, McpServerStatus, McpToolAnnotations, McpToolDefinition, McpJsonRpcRequest, McpJsonRpcResponse, McpJsonRpcError, ListToolsResult, McpInitializeParams, ToolsCallResult } from './protocol.js';
export { MCP_INVOKE_TIMEOUT_MS } from './protocol.js';
export { McpInvokeError, ServerNotRunningError, ToolNotFoundError, InvalidArgumentsError, TimeoutError, TransportError } from './errors.js';

export interface McpStatusProvider { getStatus(): McpServerStatus[] }
export interface McpToolsReadModelProvider { getToolsReadModel(): ReturnType<typeof buildMcpToolsReadModel> }
export type McpToolCapability = McpToolDefinition & { serverName: string };
export interface McpToolInvocationPort { getServerTools(name: string): McpToolDefinition[] | undefined; findToolCapability(serverName: string, toolName: string): McpToolCapability | null; invokeTool(serverName: string, toolName: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> }

export interface McpReconciliationReport {
  converged: boolean;
  desired: Array<{ name: string; revision: string; shouldRun: boolean }>;
  active: Array<{ name: string; revision: string; state: 'running' | 'stopped' }>;
  pending: Array<{ name: string; operation: 'add' | 'remove' | 'replace' | 'start' | 'stop'; diagnostic: string }>;
}
export interface McpReconciliationPort { reconcilePersistedConfig(): Promise<McpReconciliationReport> }
export interface McpManagerOptions { configAuthority: ResolvedConfigAuthority; processRunner: ProcessRunner; eventLogger: EventLog }

interface DesiredServer { name: string; config: McpServerConfig; revision: string; shouldRun: boolean }

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stableValue(child)]));
  return value;
}

function revisionOf(config: McpServerConfig): string {
  return createHash('sha256').update(JSON.stringify(stableValue(config))).digest('hex');
}

export class McpManager implements McpReconciliationPort {
  private readonly runtimes = new Map<string, McpServerRuntime>();
  private nextMsgId = 1;
  private readonly invocationStats: McpInvocationStatsRecorder;
  private reconciliationTail: Promise<void> = Promise.resolve();
  private currentReconciliation: Promise<McpReconciliationReport> | null = null;
  private admissionOpen = true;

  constructor(private readonly options: McpManagerOptions) {
    this.invocationStats = new McpInvocationStatsRecorder(options.eventLogger);
  }

  next(): number { return this.nextMsgId++; }
  getInvocationStats(): Record<string, { total: number; success: number; error: number; lastInvokedAt?: string }> { return this.invocationStats.snapshot(); }

  reconcilePersistedConfig(): Promise<McpReconciliationReport> {
    if (!this.admissionOpen) return Promise.reject(new Error('MCP reconciliation admission is closed.'));
    const run = this.reconciliationTail.then(() => this.reconcileTurn());
    this.currentReconciliation = run;
    this.reconciliationTail = run.then(() => undefined, () => undefined);
    void run.finally(() => { if (this.currentReconciliation === run) this.currentReconciliation = null; }).catch(() => undefined);
    return run;
  }

  closeAdmission(): void { this.admissionOpen = false; }

  async cleanupForApplicationStop(): Promise<void> {
    this.closeAdmission();
    for (const runtime of this.runtimes.values()) runtime.closeAdmission();
    let termination: Promise<import('../runtime/process-runner.js').ProcessStopReport>;
    try { termination = this.options.processRunner.terminateOwnedRoot('mcp', this.options.processRunner.mcpRootScope, 'application stopping'); }
    catch (error) { termination = Promise.reject(error); }
    const reconciliation = this.currentReconciliation ?? Promise.resolve();
    const settlements = await Promise.allSettled([termination, reconciliation]);
    const terminationSettlement = settlements[0]!;
    if (terminationSettlement.status === 'rejected') throw terminationSettlement.reason;
    if (settlements.some((settlement) => settlement.status === 'rejected') || terminationSettlement.value.failed.length !== 0) throw new Error('MCP application cleanup failed.');
    this.runtimes.clear();
  }

  getStatus(): McpServerStatus[] { return [...this.runtimes.values()].map((runtime) => runtime.getStatus()); }
  getServerStatus(name: string): McpServerStatus | undefined { return this.runtimes.get(name)?.getStatus(); }
  getTools(): McpToolDefinition[] { return [...this.runtimes.values()].flatMap((runtime) => runtime.getTools() ?? []); }
  getServerTools(name: string): McpToolDefinition[] | undefined { return this.runtimes.get(name)?.getTools(); }
  getToolServers(): string[] { return [...this.runtimes.values()].filter((runtime) => runtime.getTools() !== undefined).map((runtime) => runtime.name); }

  async invokeTool(serverName: string, toolName: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> {
    const runtime = this.runtimes.get(serverName);
    if (!runtime) throw new ServerNotRunningError(serverName);
    return runtime.invokeTool(toolName, args, options);
  }

  async healthCheck(name: string): Promise<boolean> { return this.runtimes.get(name)?.healthCheck() ?? false; }

  getToolsReadModel(): ReturnType<typeof buildMcpToolsReadModel> {
    return buildMcpToolsReadModel({ tools: this.getTools(), servers: this.getToolServers(), statuses: this.getStatus(), getServerTools: (name) => this.getServerTools(name), invocationStats: this.getInvocationStats() });
  }

  findToolCapability(serverName: string, toolName: string): McpToolCapability | null {
    const tool = this.getServerTools(serverName)?.find((candidate) => candidate.name === toolName);
    return tool ? { ...tool, serverName } : null;
  }

  private async reconcileTurn(): Promise<McpReconciliationReport> {
    if (!this.admissionOpen) throw new Error('MCP reconciliation admission is closed.');
    const configs = loadMcpServersFromConfig(this.options.configAuthority.loadEffective().config);
    const desired = Object.entries(configs).map(([name, config]): DesiredServer => ({ name, config, revision: revisionOf(config), shouldRun: !config.disabled && config.autostart })).sort((a, b) => a.name.localeCompare(b.name));
    const desiredByName = new Map(desired.map((entry) => [entry.name, entry]));
    const destructive = [...this.runtimes.values()].filter((runtime) => {
      const target = desiredByName.get(runtime.name);
      return !target || target.revision !== runtime.revision;
    });
    if (destructive.length > 1) {
      return {
        converged: false,
        desired: desired.map(({ name, revision, shouldRun }) => ({ name, revision, shouldRun })),
        active: [...this.runtimes.values()].sort((a, b) => a.name.localeCompare(b.name)).map((runtime) => ({ name: runtime.name, revision: runtime.revision, state: runtime.isRunning() ? 'running' : 'stopped' })),
        pending: destructive.sort((a, b) => a.name.localeCompare(b.name)).map((runtime) => ({
          name: runtime.name,
          operation: desiredByName.has(runtime.name) ? 'replace' as const : 'remove' as const,
          diagnostic: 'MCP reconciliation requires at most one destructive remove or replace target.',
        })),
      };
    }

    const pending: McpReconciliationReport['pending'] = [];
    const replacedNames = new Set<string>();
    for (const runtime of destructive) {
      const target = desiredByName.get(runtime.name);
      const operation = target ? 'replace' : 'remove';
      try { await runtime.stop(); }
      catch { pending.push({ name: runtime.name, operation, diagnostic: `MCP server '${runtime.name}' could not be contained.` }); continue; }
      this.runtimes.delete(runtime.name);
      if (target) replacedNames.add(runtime.name);
    }

    for (const target of desired) {
      let runtime = this.runtimes.get(target.name);
      if (runtime && runtime.revision !== target.revision) continue;
      let startOperation: 'add' | 'replace' | 'start' = 'start';
      if (!runtime) {
        this.assertAdmission();
        runtime = this.createRuntime(target);
        this.runtimes.set(target.name, runtime);
        startOperation = replacedNames.has(target.name) ? 'replace' : 'add';
      }
      if (!target.shouldRun) {
        if (runtime.isRunning()) {
          try { await runtime.stop(); }
          catch { pending.push({ name: target.name, operation: 'stop', diagnostic: `MCP server '${target.name}' could not be contained.` }); }
        }
        continue;
      }
      if (runtime.isReady()) continue;
      if (runtime.isContained()) {
        this.assertAdmission();
        runtime = this.createRuntime(target);
        this.runtimes.set(target.name, runtime);
      } else if (runtime.isRunning()) {
        pending.push({ name: target.name, operation: 'start', diagnostic: `MCP server '${target.name}' has not completed startup.` });
        continue;
      }
      try { this.assertAdmission(); await runtime.start(); }
      catch {
        try { await runtime.stop(); } catch { /* retained below as active truth */ }
        pending.push({ name: target.name, operation: startOperation, diagnostic: `MCP server '${target.name}' failed to start.` });
      }
    }

    const report: McpReconciliationReport = {
      converged: false,
      desired: desired.map(({ name, revision, shouldRun }) => ({ name, revision, shouldRun })),
      active: [...this.runtimes.values()].sort((a, b) => a.name.localeCompare(b.name)).map((runtime) => ({ name: runtime.name, revision: runtime.revision, state: runtime.isRunning() ? 'running' : 'stopped' })),
      pending,
    };
    report.converged = pending.length === 0 && report.desired.every((target) => {
      const runtime = this.runtimes.get(target.name);
      return runtime?.revision === target.revision && (target.shouldRun ? runtime.isReady() : !runtime.isRunning());
    }) && report.active.every((runtime) => desiredByName.has(runtime.name));
    return report;
  }

  private createRuntime(target: DesiredServer): McpServerRuntime {
    return new McpServerRuntime({
      name: target.name,
      config: target.config,
      revision: target.revision,
      processRunner: this.options.processRunner,
      processScope: this.options.processRunner.createDirectScope(this.options.processRunner.mcpRootScope, `mcp-server:${target.name}:${target.revision}`, 'service_infrastructure'),
      ids: this,
      invocationStats: this.invocationStats,
    });
  }

  private assertAdmission(): void {
    if (!this.admissionOpen) throw new Error('MCP reconciliation admission is closed.');
  }
}
