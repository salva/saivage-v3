import type { ManagedProcessScope, ProcessRunner } from '../runtime/process-runner.js';
import {
  compileMcpArgumentValidator,
  fingerprintMcpInputSchema,
  validateMcpArguments,
  type CachedMcpArgumentValidator,
} from './mcp-argument-validator.js';
import { InvalidArgumentsError, ServerNotRunningError, ToolNotFoundError } from './errors.js';
import { MCP_INVOKE_TIMEOUT_MS, type McpServerStatus, type McpStatus, type McpToolDefinition } from './protocol.js';
import type { McpServerConfig, McpServerHandle } from './server-registry.js';
import { McpInvocationStatsRecorder } from './invocation-stats.js';
import { buildMcpServerStatus } from './status-projection.js';
import {
  discoverStreamableHttpTools,
  healthStreamableHttpServer,
  invokeStreamableHttpTool,
  probeStreamableHttpStartup,
} from './streamable-http-transport.js';
import { discoverStdioTools, invokeStdioTool } from './stdio-transport.js';

export interface McpJsonRpcIdProvider { next(): number | string }

export interface McpServerRuntimeOptions {
  name: string;
  config: McpServerConfig;
  processRunner: ProcessRunner;
  processScope: ManagedProcessScope;
  ids: McpJsonRpcIdProvider;
  invocationStats: McpInvocationStatsRecorder;
}

export class McpServerRuntime {
  private configValue: McpServerConfig;
  private handle?: McpServerHandle;
  private statusOverride?: { status: McpStatus; error?: string };
  private startedAt?: string;
  private tools?: McpToolDefinition[];
  private readonly argumentValidatorCache = new Map<string, CachedMcpArgumentValidator>();
  private discoveryError?: string;
  private stdioInvocationQueue?: Promise<void>;

  constructor(private readonly options: McpServerRuntimeOptions) {
    this.configValue = options.config;
  }

  get name(): string { return this.options.name; }
  get config(): McpServerConfig { return this.configValue; }

  updateConfig(config: McpServerConfig): void {
    this.configValue = config;
  }

  async start(): Promise<void> {
    const cfg = this.configValue;
    if (cfg.disabled) return;
    const existing = this.handle;
    if (existing) {
      if (cfg.transport === 'stdio' && existing.processId && this.options.processRunner.get(existing.processId)?.status === 'running') return;
      if (cfg.transport === 'streamable-http' && existing.abortController) return;
    }

    this.statusOverride = undefined;
    if (cfg.transport === 'stdio') await this.startStdio(cfg);
    else await this.startStreamableHttp(cfg);

    if (this.handle) {
      try {
        await this.discoverTools();
      } catch (err) {
        this.discoveryError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  async stop(): Promise<void> {
    const handle = this.handle;
    if (!handle) return;
    if (this.configValue.transport === 'stdio' && handle.processId) await this.stopStdio(handle.processId);
    else if (this.configValue.transport === 'streamable-http' && handle.abortController) handle.abortController.abort();
    this.handle = undefined;
    this.statusOverride = { status: 'stopped' };
    this.clearCaches();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async dispose(): Promise<void> {
    const handle = this.handle;
    this.options.processRunner.closeScope(this.options.processScope);
    if (handle) await this.killHandle(handle);
    this.handle = undefined;
    this.clearCaches();
  }

  async invokeTool(toolName: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> {
    const cfg = this.configValue;
    const handle = this.handle;
    if (!handle) throw new ServerNotRunningError(this.name);
    if (cfg.transport === 'stdio') {
      if (!handle.process || !handle.processId || this.options.processRunner.get(handle.processId)?.status !== 'running') throw new ServerNotRunningError(this.name);
    } else if (!handle.abortController || handle.abortController.signal.aborted) {
      throw new ServerNotRunningError(this.name);
    }

    const toolDefinition = this.tools?.find((tool) => tool.name === toolName);
    if (!toolDefinition) throw new ToolNotFoundError(this.name, toolName);
    this.validateToolArguments(toolName, toolDefinition.inputSchema, args);

    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? MCP_INVOKE_TIMEOUT_MS;
    try {
      const result = cfg.transport === 'stdio'
        ? await this.enqueueStdioInvocation(() => invokeStdioTool({ serverName: this.name, toolName, args, config: cfg, handle, timeoutMs, ids: this.options.ids }))
        : await invokeStreamableHttpTool({ serverName: this.name, toolName, args, config: cfg, handle, timeoutMs, ids: this.options.ids });
      const durationMs = Date.now() - startTime;
      this.options.invocationStats.record(this.name, toolName, true);
      this.options.invocationStats.log(this.name, toolName, true, durationMs);
      return result;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.options.invocationStats.record(this.name, toolName, false);
      this.options.invocationStats.log(this.name, toolName, false, durationMs, errorMsg);
      throw err;
    }
  }

  async healthCheck(): Promise<boolean> {
    const cfg = this.configValue;
    if (cfg.disabled) return false;
    if (cfg.transport === 'stdio') return Boolean(this.handle?.processId && this.options.processRunner.get(this.handle.processId)?.status === 'running');
    if (cfg.transport === 'streamable-http') return healthStreamableHttpServer({ serverName: this.name, config: cfg, handle: this.handle });
    return false;
  }

  getStatus(): McpServerStatus {
    return buildMcpServerStatus({
      name: this.name,
      config: this.configValue,
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

  clearCaches(): void {
    this.tools = undefined;
    this.discoveryError = undefined;
    this.argumentValidatorCache.clear();
    this.stdioInvocationQueue = undefined;
  }

  private async startStdio(cfg: McpServerConfig): Promise<void> {
    if (!cfg.command) {
      const msg = `stdio MCP server '${this.name}' has no 'command' configured.`;
      this.statusOverride = { status: 'error', error: msg };
      throw new Error(msg);
    }
    const args = cfg.args ?? [];
    const launch = this.options.processRunner.spawnInteractive({
      file: cfg.command,
      args,
      directScope: this.options.processScope,
      category: 'service_infrastructure',
      ownerId: `mcp:${this.name}`,
      ownerKind: 'runtime',
      launchReason: `MCP stdio server ${this.name}`,
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const proc = launch.process;
    this.handle = { process: proc, processId: launch.record.id };
    this.startedAt = new Date().toISOString();

    void this.options.processRunner.waitForSettlement(launch.record.id).then(() => {
      const handle = this.handle;
      if (!handle || handle.processId !== launch.record.id) return;
      const record = this.options.processRunner.get(launch.record.id);
      if (record?.status === 'exited') {
        this.handle = undefined;
        this.statusOverride = { status: 'stopped' };
        this.clearCaches();
        return;
      }
      const error = record?.signal ? `Process exited with signal ${record.signal}` : `Process exited with code ${record?.exit_code ?? 'unknown'}`;
      this.handle = undefined;
      this.statusOverride = { status: 'error', error };
      this.clearCaches();
    });
    proc.stdin?.on('error', () => undefined);
    proc.stdout?.on('error', () => undefined);
  }

  private async startStreamableHttp(cfg: McpServerConfig): Promise<void> {
    if (!cfg.url) {
      const msg = `streamable-http MCP server '${this.name}' has no 'url' configured.`;
      this.statusOverride = { status: 'error', error: msg };
      throw new Error(msg);
    }
    const abortController = new AbortController();
    this.handle = { abortController };
    this.startedAt = new Date().toISOString();
    const startupProbe = await probeStreamableHttpStartup({ serverName: this.name, config: cfg, signal: abortController.signal });
    if (!startupProbe.ok && !startupProbe.aborted) {
      this.handle = undefined;
      this.statusOverride = { status: 'error', error: startupProbe.error };
    }
  }

  private async discoverTools(): Promise<void> {
    const cfg = this.configValue;
    const tools = cfg.transport === 'stdio'
      ? await discoverStdioTools({ serverName: this.name, handle: this.handle, ids: this.options.ids })
      : await discoverStreamableHttpTools({ serverName: this.name, config: cfg, handle: this.handle, ids: this.options.ids });
    this.tools = tools;
    this.argumentValidatorCache.clear();
  }

  private async stopStdio(processId: string): Promise<void> {
    await this.options.processRunner.kill(processId, { directScope: this.options.processScope, category: 'service_infrastructure', reason: `MCP server '${this.name}' stopped` });
  }

  private async killHandle(handle: McpServerHandle): Promise<void> {
    if (handle.processId) await this.stopStdio(handle.processId);
    if (handle.abortController) handle.abortController.abort();
  }

  private validateToolArguments(toolName: string, inputSchema: unknown, args: Record<string, unknown>): void {
    const fingerprint = fingerprintMcpInputSchema(inputSchema);
    const cacheKey = `${toolName}:${fingerprint}`;
    let compiled = this.argumentValidatorCache.get(cacheKey);
    if (!compiled) {
      compiled = compileMcpArgumentValidator(inputSchema);
      this.argumentValidatorCache.set(cacheKey, compiled);
    }
    const result = validateMcpArguments(compiled, args);
    if (!result.ok) {
      throw new InvalidArgumentsError(this.name, toolName, {
        source: 'local_input_schema_validation',
        reason: result.type,
        diagnostics: result.diagnostics,
      });
    }
  }

  private enqueueStdioInvocation<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.stdioInvocationQueue ?? Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    this.stdioInvocationQueue = next.catch(() => {}) as Promise<void>;
    return next;
  }
}
