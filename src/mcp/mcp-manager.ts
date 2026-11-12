import {
  canonicalValueSha256,
  mcpConnectionSchema,
  mcpAccessPolicySchema,
  type McpConnection,
  type McpAccessPolicy,
} from '../schemas/index.js';
import {
  McpAdmission,
  MCP_MANAGEMENT_OPERATIONS,
  type McpCaller,
  type McpOperation,
} from './access-policy.js';
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
import type { McpServerStatus, McpCatalogSnapshot, McpCatalogRefreshResult } from './protocol.js';
import { type McpServerConfig } from './server-registry.js';
import { McpServerRuntime } from './server-runtime.js';
import type { NativeMcpResult } from './native-result.js';
import { buildMcpToolsReadModel } from './status-projection.js';
import {
  readMcpServerDefinitions,
  replaceMcpServerDefinitions,
  type McpServerDefinition,
} from './server-definitions.js';

export interface McpStatusProvider {
  getStatus(caller: McpCaller): McpServerStatus[];
}
export interface McpToolsReadModelProvider {
  getToolsReadModel(caller: McpCaller): ReturnType<typeof buildMcpToolsReadModel>;
}
export interface McpToolInvocationPort {
  registerServer(
    caller: McpCaller,
    name: string,
    connection: McpConnection,
    policy?: McpAccessPolicy,
  ): { serverName: string; registered: true };
  setServerScope(
    caller: McpCaller,
    name: string,
    policy: McpAccessPolicy,
  ): { serverName: string; policy: McpAccessPolicy; updated: true };
  replaceServer(
    caller: McpCaller,
    name: string,
    connection: McpConnection,
  ): { serverName: string; replaced: true; status: 'stopped' };
  unregisterServer(
    caller: McpCaller,
    name: string,
  ): Promise<{ serverName: string; unregistered: true; status: 'stopped' }>;
  getStatus(caller: McpCaller): McpServerStatus[];
  getServerStatus(caller: McpCaller, name: string): McpServerStatus | undefined;
  startServer(
    caller: McpCaller,
    name: string,
    options?: { signal?: AbortSignal; observationSource?: OutboundObservationSource },
  ): Promise<McpLifecycleResult>;
  stopServer(caller: McpCaller, name: string): Promise<McpLifecycleResult>;
  restartServer(
    caller: McpCaller,
    name: string,
    options?: { signal?: AbortSignal; observationSource?: OutboundObservationSource },
  ): Promise<McpLifecycleResult>;
  getServerCatalog(caller: McpCaller, name: string): McpCatalogSnapshot | undefined;
  refreshServerCatalog(
    caller: McpCaller,
    name: string,
    bindingId: string,
    options?: { signal?: AbortSignal; observationSource?: OutboundObservationSource },
  ): Promise<McpCatalogRefreshResult>;
  invokeTool(
    caller: McpCaller,
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
  toolCount?: number;
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
  readCanonicalLivePath: (cardId: string) => readonly string[];
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
  const { policy: _policy, format_version: _format, ...connection } = config;
  return canonicalValueSha256(connection);
}

export class McpManager implements McpReconciliationPort {
  private readonly policyAdmission: McpAdmission;
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
    readCanonicalLivePath,
    nativeGit,
    configAuthority,
    processRunner,
    mcpProcessRootScope,
    eventLogger,
    outboundHttp,
  }: McpManagerOptions) {
    this.policyAdmission = new McpAdmission(readCanonicalLivePath);
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

  getStatus(caller: McpCaller): McpServerStatus[] {
    this.policyAdmission.requireGrant(caller, 'mcp_servers');
    const { configs, sources } = this.loadDefinitions();
    const names = new Set([...Object.keys(configs), ...this.#runtimes.keys()]);
    return [...names].flatMap((name) => {
      const runtime = this.#runtimes.get(name);
      const policy = configs[name]?.policy ?? runtime!.policy;
      const exposed = !!configs[name] && this.policyAdmission.exposed(caller, policy);
      const availableActions = MCP_MANAGEMENT_OPERATIONS.filter(
        (operation) =>
          caller.operations.includes(operation) &&
          !(
            this.nativeGit &&
            ['mcp_server_replace', 'mcp_catalog_refresh', 'mcp_server_set_scope'].includes(
              operation,
            )
          ) &&
          this.canManage(caller, name, operation),
      );
      if (!exposed && !availableActions.length) return [];
      const status = runtime
        ? { ...runtime.getStatus(), definitionSource: sources.get(name) ?? null }
        : {
            name,
            transport: configs[name]!.transport,
            status: 'stopped' as const,
            bindingId: null,
            definitionSource: sources.get(name)!,
            ready: false,
            containment: 'not_started' as const,
            failureReason: null,
            containmentBoundary:
              configs[name]!.transport === 'stdio'
                ? ('local_process_group' as const)
                : ('local_connection' as const),
            processId: null,
            tools_count: 0,
          };
      const { tools_count, ...safeStatus } = status;
      return [{ ...safeStatus, policy, availableActions, ...(exposed ? { tools_count } : {}) }];
    });
  }
  getServerStatus(caller: McpCaller, name: string): McpServerStatus | undefined {
    return this.getStatus(caller).find((status) => status.name === name);
  }
  getServerCatalog(caller: McpCaller, name: string): McpCatalogSnapshot | undefined {
    this.authorize(caller, name, 'mcp_tools');
    const runtime = this.#runtimes.get(name);
    if (!runtime) throw new McpLifecycleError(`Unknown MCP server '${name}'.`, 404);
    return runtime.getCatalog();
  }

  refreshServerCatalog(
    caller: McpCaller,
    name: string,
    bindingId: string,
    options?: { signal?: AbortSignal; observationSource?: OutboundObservationSource },
  ): Promise<McpCatalogRefreshResult> {
    this.authorize(caller, name, 'mcp_catalog_refresh');
    this.assertNativeSourceCapability();
    options?.signal?.throwIfAborted();
    this.assertAdmission();
    const { configs } = this.loadDefinitions(name);
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
    return runtime
      .refreshCatalog(bindingId, {
        ...options,
        assertDispatchAllowed: () =>
          this.assertSelected(caller, name, 'mcp_catalog_refresh', runtime),
      })
      .then((result) => {
        const { toolCount, ...selection } = result;
        const policy = this.loadDefinitions(name).configs[name]?.policy;
        return {
          ...selection,
          ...(caller.principal.kind !== 'card' ||
          (policy && this.policyAdmission.exposed(caller, policy))
            ? { toolCount }
            : {}),
        };
      });
  }

  async startServer(
    caller: McpCaller,
    name: string,
    options?: { signal?: AbortSignal; observationSource?: OutboundObservationSource },
  ): Promise<McpLifecycleResult> {
    this.authorize(caller, name, 'mcp_server_control', true);
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
        if (this.#runtimes.get(name) !== runtime)
          throw new McpLifecycleError('MCP owner changed during start.', 409);
        return this.startServer(caller, name, options);
      }
      if (runtime.isReady()) return this.startedResult(caller, name, runtime);
      if (!runtime.isContained() && (runtime.isRunning() || !runtime.isAdmissionOpen()))
        throw new McpLifecycleError(`MCP server '${name}' is busy or requires containment.`, 409);
    }
    if (!runtime || runtime.isContained()) {
      runtime = this.createRuntime({ name, config, revision, shouldRun: true });
      this.#runtimes.set(name, runtime);
    }
    const selected = runtime;
    await runtime.start({
      ...options,
      assertDispatchAllowed: () =>
        this.assertSelected(caller, name, 'mcp_server_control', selected, true),
    });
    if (!runtime.isReady()) throw new ServerNotRunningError(name);
    return this.startedResult(caller, name, runtime);
  }

  async stopServer(caller: McpCaller, name: string): Promise<McpLifecycleResult> {
    this.authorize(caller, name, 'mcp_server_control');
    this.assertAdmission();
    const runtime = this.#runtimes.get(name);
    if (!runtime) throw new McpLifecycleError(`Unknown MCP owner '${name}'.`, 404);
    await runtime.stop();
    return { serverName: name, status: 'stopped', toolCount: 0 };
  }

  async restartServer(
    caller: McpCaller,
    name: string,
    options?: { signal?: AbortSignal; observationSource?: OutboundObservationSource },
  ): Promise<McpLifecycleResult> {
    this.authorize(caller, name, 'mcp_server_control', true);
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
    return this.startServer(caller, name, options);
  }

  registerServer(
    caller: McpCaller,
    name: string,
    connection: McpConnection,
    policy?: McpAccessPolicy,
  ): { serverName: string; registered: true } {
    this.policyAdmission.requireGrant(caller, 'mcp_server_register');
    const selectedPolicy =
      policy ??
      (caller.principal.kind === 'card'
        ? { controllerCardId: caller.principal.cardId, exposure: 'subtree' as const }
        : this.policyAdmission.unavailable());
    const parsedPolicy = mcpAccessPolicySchema.safeParse(selectedPolicy);
    if (!parsedPolicy.success) throw new McpLifecycleError('Invalid MCP policy.', 409);
    this.policyAdmission.destination(caller, parsedPolicy.data);
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
      value: { connection: parsed.data, policy: parsedPolicy.data },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    replaceMcpServerDefinitions(this.#processRunner.projectRoot, dynamic);
    if (runtime) this.#runtimes.delete(name);
    return { serverName: name, registered: true };
  }

  replaceServer(
    caller: McpCaller,
    name: string,
    connection: McpConnection,
  ): { serverName: string; replaced: true; status: 'stopped' } {
    this.authorize(caller, name, 'mcp_server_replace');
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
      value: { connection: parsed.data, policy: dynamic[name]!.policy },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    replaceMcpServerDefinitions(this.#processRunner.projectRoot, dynamic);
    this.#runtimes.delete(name);
    return { serverName: name, replaced: true, status: 'stopped' };
  }

  async unregisterServer(
    caller: McpCaller,
    name: string,
  ): Promise<{ serverName: string; unregistered: true; status: 'stopped' }> {
    this.authorize(caller, name, 'mcp_server_unregister');
    this.assertAdmission();
    const dynamic = readMcpServerDefinitions(this.#processRunner.projectRoot);
    if (this.configAuthority.loadMcpServer(name) || !Object.hasOwn(dynamic, name))
      throw new McpLifecycleError(
        `MCP server '${name}' is not an exclusively agent-owned definition.`,
        409,
      );
    const runtime = this.#runtimes.get(name);
    const policy = dynamic[name]!.policy;
    delete dynamic[name];
    replaceMcpServerDefinitions(this.#processRunner.projectRoot, dynamic);
    if (runtime) runtime.policy = policy;
    // Publication must succeed before fencing. stop enters closure before its first await.
    if (runtime) await runtime.stop();
    return { serverName: name, unregistered: true, status: 'stopped' };
  }

  async invokeTool(
    caller: McpCaller,
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
    this.authorize(caller, serverName, 'mcp_tool_call');
    this.assertNativeSourceCapability();
    options?.signal?.throwIfAborted();
    if (!this.admissionOpen) throw new ServerNotRunningError(serverName);
    const runtime = this.#runtimes.get(serverName);
    if (!runtime) throw new ServerNotRunningError(serverName);
    if (!runtime.isReady()) throw new ServerNotRunningError(serverName);
    if (runtime.bindingId !== bindingId)
      throw new McpLifecycleError('Stale MCP binding; discover tools again before invoking.', 409);
    return runtime.invokeTool(bindingId, catalogId, toolName, args, {
      ...options,
      assertDispatchAllowed: () =>
        this.assertSelected(caller, serverName, 'mcp_tool_call', runtime),
    });
  }

  getToolsReadModel(caller: McpCaller): ReturnType<typeof buildMcpToolsReadModel> {
    if (caller.principal.kind !== 'operator') this.policyAdmission.unavailable();
    return buildMcpToolsReadModel({
      statuses: this.getStatus(caller),
      getServerTools: (name) => this.#runtimes.get(name)?.getTools(),
      invocationStats: this.getInvocationStats(),
    });
  }

  setServerScope(
    caller: McpCaller,
    name: string,
    policy: McpAccessPolicy,
  ): {
    serverName: string;
    policy: McpAccessPolicy;
    updated: true;
  } {
    this.assertAdmission();
    this.assertNativeSourceCapability();
    this.authorize(caller, name, 'mcp_server_set_scope');
    const parsed = mcpAccessPolicySchema.safeParse(policy);
    if (!parsed.success) throw new McpLifecycleError('Invalid MCP policy.', 409);
    this.policyAdmission.destination(caller, parsed.data);
    const dynamic = readMcpServerDefinitions(this.#processRunner.projectRoot);
    dynamic[name] = { ...dynamic[name]!, policy: parsed.data };
    replaceMcpServerDefinitions(this.#processRunner.projectRoot, dynamic);
    const runtime = this.#runtimes.get(name);
    if (runtime) runtime.policy = parsed.data;
    return { serverName: name, policy: parsed.data, updated: true };
  }

  private canManage(caller: McpCaller, name: string, operation: McpOperation): boolean {
    const { configs, sources } = this.loadDefinitions(name);
    const config = configs[name];
    const runtime = this.#runtimes.get(name);
    if (!config && (!runtime || operation !== 'mcp_server_control')) return false;
    if (
      ['mcp_server_replace', 'mcp_server_unregister', 'mcp_server_set_scope'].includes(operation) &&
      sources.get(name) !== 'agent'
    )
      return false;
    return this.policyAdmission.manages(caller, config?.policy ?? runtime!.policy);
  }

  private startedResult(
    caller: McpCaller,
    name: string,
    runtime: McpServerRuntime,
  ): McpLifecycleResult {
    const policy = this.loadDefinitions(name).configs[name]?.policy;
    return {
      serverName: name,
      status: 'running',
      ...(caller.principal.kind !== 'card' ||
      (policy && this.policyAdmission.exposed(caller, policy))
        ? { toolCount: runtime.getTools()!.length }
        : {}),
    };
  }

  private authorize(caller: McpCaller, name: string, operation: McpOperation, live = false): void {
    this.policyAdmission.requireGrant(caller, operation);
    const { configs } = this.loadDefinitions(name);
    const config = configs[name];
    if (operation === 'mcp_tools' || operation === 'mcp_tool_call') {
      if (!config || !this.policyAdmission.exposed(caller, config.policy))
        this.policyAdmission.unavailable();
    } else {
      if (!this.canManage(caller, name, operation)) this.policyAdmission.unavailable();
      if (live || operation === 'mcp_catalog_refresh') {
        if (!config) this.policyAdmission.unavailable();
        this.policyAdmission.liveAnchor(config.policy);
      }
    }
  }

  private assertSelected(
    caller: McpCaller,
    name: string,
    operation: McpOperation,
    runtime: McpServerRuntime,
    live = false,
  ): void {
    this.assertAdmission();
    this.authorize(caller, name, operation, live);
    const config = this.loadDefinitions(name).configs[name];
    if (
      !config ||
      config.disabled ||
      runtime !== this.#runtimes.get(name) ||
      runtime.revision !== revisionOf(config)
    )
      this.policyAdmission.unavailable();
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
        const selected = runtime;
        const assertDispatchAllowed = () => {
          this.assertAdmission();
          const current = this.loadDefinitions().configs[target.name];
          if (
            !current ||
            current.disabled ||
            selected !== this.#runtimes.get(target.name) ||
            revisionOf(current) !== selected.revision
          )
            this.policyAdmission.unavailable();
          this.policyAdmission.liveAnchor(current.policy);
        };
        assertDispatchAllowed();
        await runtime.start({ assertDispatchAllowed });
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
      source: this.loadDefinitions(target.name).sources.get(target.name)!,
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

  private dynamicConfig(definition: McpServerDefinition): McpServerConfig {
    return {
      ...definition.connection,
      policy: definition.policy,
      format_version: 1,
      disabled: false,
      autostart: false,
    };
  }

  private loadDefinitions(selectedName?: string): {
    configs: Record<string, McpServerConfig>;
    sources: Map<string, 'operator' | 'agent'>;
  } {
    const selectedOperator =
      selectedName === undefined ? undefined : this.configAuthority.loadMcpServer(selectedName);
    const operator =
      selectedName === undefined
        ? this.configAuthority.loadMcpServers()
        : selectedOperator
          ? { [selectedName]: selectedOperator }
          : {};
    const dynamic = readMcpServerDefinitions(this.#processRunner.projectRoot);
    const configs: Record<string, McpServerConfig> = Object.assign(Object.create(null), operator);
    const sources = new Map<string, 'operator' | 'agent'>(
      Object.keys(operator).map((name) => [name, 'operator']),
    );
    for (const [name, connection] of Object.entries(dynamic)) {
      if (selectedName !== undefined && name !== selectedName) continue;
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
