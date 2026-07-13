import type { ManagedProcessScope, ProcessRunner } from '../runtime/process-runner.js';
import { compileMcpArgumentValidator, fingerprintMcpInputSchema, validateMcpArguments, type CachedMcpArgumentValidator } from './mcp-argument-validator.js';
import { InvalidArgumentsError, ServerNotRunningError, ToolNotFoundError } from './errors.js';
import { MCP_INVOKE_TIMEOUT_MS, type McpServerStatus, type McpStatus, type McpToolDefinition } from './protocol.js';
import type { McpServerConfig, McpServerHandle } from './server-registry.js';
import { McpInvocationStatsRecorder } from './invocation-stats.js';
import { buildMcpServerStatus } from './status-projection.js';
import { discoverStreamableHttpTools, healthStreamableHttpServer, invokeStreamableHttpTool, probeStreamableHttpStartup } from './streamable-http-transport.js';
import { discoverStdioTools, invokeStdioTool } from './stdio-transport.js';
import type { MutationAuthority } from '../application/mutation-authority.js';

export interface McpJsonRpcIdProvider { next(): number | string }

export interface McpServerRuntimeOptions {
  name: string;
  config: McpServerConfig;
  revision: string;
  processRunner: ProcessRunner;
  processScope: ManagedProcessScope;
  ids: McpJsonRpcIdProvider;
  invocationStats: McpInvocationStatsRecorder;
}

function abortError(): Error { return new DOMException('MCP runtime operation was aborted', 'AbortError'); }

export class McpServerRuntime {
  private handle?: McpServerHandle;
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

  constructor(private readonly options: McpServerRuntimeOptions) {}

  get name(): string { return this.options.name; }
  get config(): McpServerConfig { return this.options.config; }
  get revision(): string { return this.options.revision; }
  isReady(): boolean { return this.ready; }
  isContained(): boolean { return this.contained; }

  start(): Promise<void> {
    return this.admit(async (generation, signal) => {
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
    });
  }

  closeAdmission(): void {
    if (!this.admissionOpen) return;
    this.admissionOpen = false;
    this.generation += 1;
    this.options.processRunner.closeScope(this.options.processScope);
    for (const controller of this.controllers) controller.abort();
  }

  async stop(): Promise<void> {
    if (this.contained) return;
    this.closeAdmission();
    await Promise.allSettled([...this.operations]);
    const report = await this.options.processRunner.terminateScopeTree({
      rootScope: this.options.processScope,
      categories: ['service_infrastructure'],
      reason: `MCP server '${this.name}' stopped`,
    });
    if (report.failed.length > 0) {
      throw new Error(`MCP server '${this.name}' process containment failed.`);
    }
    this.handle?.abortController?.abort();
    this.handle = undefined;
    this.statusOverride = { status: 'stopped' };
    this.ready = false;
    this.clearCaches();
    this.contained = true;
  }

  dispose(): Promise<void> { return this.stop(); }

  invokeTool(authority: MutationAuthority, toolName: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> {
    return this.admit(async (generation, signal) => {
      const cfg = this.config;
      const handle = this.handle;
      if (!handle || !this.ready) throw new ServerNotRunningError(this.name);
      if (cfg.transport === 'stdio') {
        if (!handle.process || !handle.processId || this.options.processRunner.get(handle.processId)?.status !== 'running') throw new ServerNotRunningError(this.name);
      } else if (!handle.abortController || handle.abortController.signal.aborted) throw new ServerNotRunningError(this.name);

      const toolDefinition = this.tools?.find((tool) => tool.name === toolName);
      if (!toolDefinition) throw new ToolNotFoundError(this.name, toolName);
      this.validateToolArguments(toolName, toolDefinition.inputSchema, args);
      const startTime = Date.now();
      const timeoutMs = options?.timeoutMs ?? MCP_INVOKE_TIMEOUT_MS;
      try {
        const result = cfg.transport === 'stdio'
          ? await this.enqueueStdioInvocation(() => { this.assertCurrent(generation, signal); return invokeStdioTool({ serverName: this.name, toolName, args, config: cfg, handle, timeoutMs, ids: this.options.ids, signal }); })
          : await invokeStreamableHttpTool({ serverName: this.name, toolName, args, config: cfg, handle, timeoutMs, ids: this.options.ids, signal });
        this.assertCurrent(generation, signal);
        const durationMs = Date.now() - startTime;
        this.options.invocationStats.record(this.name, toolName, true);
        this.options.invocationStats.log(authority, this.name, toolName, true, durationMs);
        return result;
      } catch (err) {
        if (generation === this.generation) {
          const durationMs = Date.now() - startTime;
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.options.invocationStats.record(this.name, toolName, false);
          this.options.invocationStats.log(authority, this.name, toolName, false, durationMs, errorMsg);
        }
        throw err;
      }
    });
  }

  healthCheck(): Promise<boolean> {
    return this.admit(async (_generation, signal) => {
      const cfg = this.config;
      if (cfg.disabled || !this.ready) return false;
      if (cfg.transport === 'stdio') return Boolean(this.handle?.processId && this.options.processRunner.get(this.handle.processId)?.status === 'running');
      return healthStreamableHttpServer({ serverName: this.name, config: cfg, handle: this.handle, signal });
    });
  }

  getStatus(): McpServerStatus {
    return buildMcpServerStatus({ name: this.name, config: this.config, handle: this.handle, override: this.statusOverride, startedAt: this.startedAt, tools: this.tools });
  }
  getTools(): McpToolDefinition[] | undefined { return this.tools; }
  isRunning(): boolean { return Boolean(this.handle); }

  private admit<T>(operation: (generation: number, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.admissionOpen) return Promise.reject(new ServerNotRunningError(this.name));
    const generation = this.generation;
    const controller = new AbortController();
    this.controllers.add(controller);
    const result = operation(generation, controller.signal);
    const tracked = result.then(() => undefined, () => undefined).finally(() => {
      this.controllers.delete(controller);
      this.operations.delete(tracked);
    });
    this.operations.add(tracked);
    return result;
  }

  private assertCurrent(generation: number, signal: AbortSignal): void {
    if (signal.aborted || generation !== this.generation || !this.admissionOpen) throw abortError();
  }

  private startStdio(cfg: McpServerConfig, generation: number, signal: AbortSignal): void {
    if (!cfg.command) throw new Error(`stdio MCP server '${this.name}' has no 'command' configured.`);
    this.assertCurrent(generation, signal);
    const launch = this.options.processRunner.spawnInteractive({
      file: cfg.command, args: cfg.args ?? [], directScope: this.options.processScope, category: 'service_infrastructure',
      ownerId: `mcp:${this.name}`, ownerKind: 'runtime', launchReason: `MCP stdio server ${this.name}`,
      env: { ...process.env, ...(cfg.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.handle = { process: launch.process, processId: launch.record.id };
    this.startedAt = new Date().toISOString();
    launch.process.stdin?.on('error', () => undefined);
    launch.process.stdout?.on('error', () => undefined);
    const observerController = new AbortController();
    this.controllers.add(observerController);
    const settlement = Promise.race([
      this.options.processRunner.waitForSettlement(launch.record.id),
      new Promise<null>((resolve) => observerController.signal.addEventListener('abort', () => resolve(null), { once: true })),
    ]).then((result) => {
      if (!result || generation !== this.generation || !this.admissionOpen) return;
      const record = this.options.processRunner.get(launch.record.id);
      if (record?.status === 'exited') this.statusOverride = { status: 'stopped' };
      else this.statusOverride = { status: 'error', error: record?.signal ? 'Process exited with a signal' : 'Process exited unsuccessfully' };
      this.handle = undefined;
      this.ready = false;
      this.clearCaches();
    });
    const tracked = settlement.finally(() => {
      this.controllers.delete(observerController);
      this.operations.delete(tracked);
    });
    this.operations.add(tracked);
  }

  private async startStreamableHttp(cfg: McpServerConfig, generation: number, signal: AbortSignal): Promise<void> {
    if (!cfg.url) throw new Error(`streamable-http MCP server '${this.name}' has no 'url' configured.`);
    const abortController = new AbortController();
    signal.addEventListener('abort', () => abortController.abort(), { once: true });
    this.handle = { abortController };
    this.startedAt = new Date().toISOString();
    const startupProbe = await probeStreamableHttpStartup({ serverName: this.name, config: cfg, signal: abortController.signal });
    this.assertCurrent(generation, signal);
    if (!startupProbe.ok) throw new Error(`Streamable HTTP MCP server '${this.name}' failed its startup probe.`);
  }

  private discoverTools(signal: AbortSignal): Promise<McpToolDefinition[]> {
    return this.config.transport === 'stdio'
      ? discoverStdioTools({ serverName: this.name, handle: this.handle, ids: this.options.ids, signal })
      : discoverStreamableHttpTools({ serverName: this.name, config: this.config, handle: this.handle, ids: this.options.ids, signal });
  }

  private clearCaches(): void {
    this.tools = undefined;
    this.argumentValidatorCache.clear();
    this.stdioInvocationQueue = undefined;
  }

  private validateToolArguments(toolName: string, inputSchema: unknown, args: Record<string, unknown>): void {
    const cacheKey = `${toolName}:${fingerprintMcpInputSchema(inputSchema)}`;
    let compiled = this.argumentValidatorCache.get(cacheKey);
    if (!compiled) { compiled = compileMcpArgumentValidator(inputSchema); this.argumentValidatorCache.set(cacheKey, compiled); }
    const result = validateMcpArguments(compiled, args);
    if (!result.ok) throw new InvalidArgumentsError(this.name, toolName, { source: 'local_input_schema_validation', reason: result.type, diagnostics: result.diagnostics });
  }

  private enqueueStdioInvocation<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.stdioInvocationQueue ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.stdioInvocationQueue = next.then(() => undefined, () => undefined);
    return next;
  }
}
