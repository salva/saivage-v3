/** MCP Server Lifecycle Manager facade. */

import { EventLogger } from '../observability/index.js';
import type { SaivageConfig } from '../agents/config-api.js';
import { createResourceScope, type ResourceScope } from '../lifecycle/index.js';
import { ServerNotRunningError } from './errors.js';
import { MCP_INVOKE_TIMEOUT_MS, type McpServerStatus, type McpToolDefinition } from './protocol.js';
import { loadMcpServersFromConfig, type McpServerConfig } from './server-registry.js';
import { McpInvocationStatsRecorder } from './invocation-stats.js';
import { buildMcpToolsReadModel } from './status-projection.js';
import { McpServerRuntime } from './server-runtime.js';
import type { ProcessRunner } from '../runtime/process-runner.js';

export type { McpServerConfig, McpServerHandle } from './server-registry.js';
export type { McpTransport, McpStatus, McpServerStatus, McpToolAnnotations, McpToolDefinition, McpJsonRpcRequest, McpJsonRpcResponse, McpJsonRpcError, ListToolsResult, McpInitializeParams, ToolsCallResult } from './protocol.js';
export { MCP_INVOKE_TIMEOUT_MS } from './protocol.js';
export { McpInvokeError, ServerNotRunningError, ToolNotFoundError, InvalidArgumentsError, TimeoutError, TransportError } from './errors.js';

export interface McpStatusProvider { getStatus(): McpServerStatus[] }
export interface McpToolsReadModelProvider { getToolsReadModel(): ReturnType<typeof buildMcpToolsReadModel> }
export type McpToolCapability = ReturnType<typeof buildMcpToolsReadModel>['serverDetails'][number]['tools'][number] & { serverName: string };
export interface McpToolInvocationPort { getServerTools(name: string): McpToolDefinition[] | undefined; findToolCapability(serverName: string, toolName: string): McpToolCapability | null; invokeTool(serverName: string, toolName: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> }

export interface McpManagerOptions { config: SaivageConfig; processRunner: ProcessRunner; scope?: ResourceScope; }

export class McpManager {
  private projectRoot: string;
  private config: SaivageConfig;
  private readonly scope: ResourceScope;
  /** All configured MCP servers, loaded at construction time. */
  private servers: Record<string, McpServerConfig>;
  private runtimes: Map<string, McpServerRuntime> = new Map();
  /** Auto-incrementing JSON-RPC message ID counter. */
  private nextMsgId = 1;
  private readonly invocationStats = new McpInvocationStatsRecorder();

  constructor(projectRoot: string, private readonly options: McpManagerOptions) {
    this.projectRoot = projectRoot;
    this.config = options.config;
    this.scope = options.scope ?? createResourceScope('mcp-manager');
    this.servers = loadMcpServersFromConfig(this.config);
    this.rebuildRuntimes(this.servers);
    this.scope.add({ dispose: () => { for (const runtime of this.runtimes.values()) void runtime.dispose(); this.runtimes.clear(); } }, { name: 'mcp-manager-runtimes' });
  }

  next(): number { return this.nextMsgId++; }

  // ── Event Logger / Invocation Statistics ───────────────────

  setEventLogger(logger: EventLogger): void { this.invocationStats.setEventLogger(logger); }

  getInvocationStats(): Record<string, { total: number; success: number; error: number; lastInvokedAt?: string }> {
    return this.invocationStats.snapshot();
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Start all autostart servers. Disabled servers are skipped.
   */
  reloadServersFromConfig(config: SaivageConfig = this.config): void {
    this.config = config;
    const nextServers = loadMcpServersFromConfig(this.config);
    this.rebuildRuntimes(nextServers);
    this.servers = nextServers;
  }

  async startAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    const names: string[] = [];
    for (const [name, cfg] of Object.entries(this.servers)) {
      if (!cfg.disabled && cfg.autostart) {
        names.push(name);
        promises.push(this.startServer(name));
      }
    }
    const results = await Promise.allSettled(promises);
    const failures = results.flatMap((result, index) => result.status === 'rejected' ? [{ name: names[index]!, reason: result.reason }] : []);
    if (failures.length > 0) {
      const summary = failures.map((failure) => `${failure.name}: ${failure.reason instanceof Error ? failure.reason.message : String(failure.reason)}`).join('; ');
      throw new Error(`Failed to start ${failures.length} MCP autostart server(s): ${summary}`);
    }
  }

  /**
   * Start a single MCP server by name.
   *
   * If the server is disabled, silently skips (no error).
   * If the server is already running, does nothing.
   *
   * After the server is started, performs MCP tool discovery
   * (init handshake + tools/list). Discovery failures are recorded
   * but do not change the server status if the process is still alive.
   */
  async startServer(name: string): Promise<void> {
    const runtime = this.runtimes.get(name);
    if (!runtime) {
      throw new Error(`MCP server '${name}' not found in configuration.`);
    }
    await runtime.start();
  }

  /**
   * Stop a single MCP server by name.
   *
   * For stdio: sends SIGTERM, waits 3 s, then SIGKILL if still alive.
   * For streamable-http: aborts the AbortController to close in-flight requests.
   *
   * Clears the cached tool list for this server.
   */
  async stopServer(name: string): Promise<void> {
    await this.runtimes.get(name)?.stop();
  }

  /**
   * Stop all running servers.
   */
  async stopAll(): Promise<void> {
    const promises = Array.from(this.runtimes.values()).map((runtime) => runtime.stop());
    await Promise.allSettled(promises);
  }

  /**
   * Restart a server: stop then start.
   */
  async restartServer(name: string): Promise<void> {
    const runtime = this.runtimes.get(name);
    if (!runtime) throw new Error(`MCP server '${name}' not found in configuration.`);
    await runtime.restart();
  }

  /**
   * Return status for all configured servers (including disabled ones).
   */
  getStatus(): McpServerStatus[] {
    return Array.from(this.runtimes.values()).map((runtime) => runtime.getStatus());
  }

  /**
   * Return status for a single server, or undefined if not configured.
   */
  getServerStatus(name: string): McpServerStatus | undefined {
    return this.runtimes.get(name)?.getStatus();
  }

  /**
   * Return merged tool definitions from all servers.
   */
  getTools(): McpToolDefinition[] {
    const all: McpToolDefinition[] = [];
    for (const runtime of this.runtimes.values()) {
      const tools = runtime.getTools();
      if (tools) all.push(...tools);
    }
    return all;
  }

  /**
   * Return cached tool definitions for a specific server.
   */
  getServerTools(name: string): McpToolDefinition[] | undefined {
    return this.runtimes.get(name)?.getTools();
  }

  /**
   * Return server names that have cached tool definitions.
   */
  getToolServers(): string[] {
    return Array.from(this.runtimes.values())
      .filter((runtime) => runtime.getTools() !== undefined)
      .map((runtime) => runtime.name);
  }

  /**
   * Invoke an MCP tool on a running server.
   *
   * Sends a `tools/call` JSON-RPC request over the appropriate transport
   * (stdio or Streamable HTTP) and returns the result. The response is screened for
   * structured error codes and mapped to typed exceptions.
   *
   * @param serverName  - The configured MCP server name.
   * @param toolName    - The tool to invoke (must exist in the tools cache).
   * @param args        - Tool arguments as a key-value record.
   * @param options     - Optional overrides (e.g. timeoutMs).
   * @returns           - The tool result (typically `result.content` or the
   *                      full JSON-RPC result object).
   * @throws {ServerNotRunningError}  Server is not configured or not running.
   * @throws {ToolNotFoundError}      Tool not found in the server's tool list.
   * @throws {InvalidArgumentsError}  Server returned JSON-RPC error -32602.
   * @throws {TimeoutError}           Invocation exceeded timeout.
   * @throws {TransportError}         Transport-level failure (connection, process).
   * @throws {McpInvokeError}         Other JSON-RPC error returned by the server.
   */
  async invokeTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<unknown> {
    const runtime = this.runtimes.get(serverName);
    if (!runtime) throw new ServerNotRunningError(serverName);
    return runtime.invokeTool(toolName, args, options);
  }

  /**
   * Health check a specific server.
   *
   * - stdio: process must be running (pid alive, not exited with an error code).
   * - streamable-http: performs a HEAD request (fallback to GET) to the configured URL
   *   and expects a 2xx response.
   *
   * Returns true if healthy, false otherwise.
   */
  async healthCheck(name: string): Promise<boolean> {
    const cfg = this.servers[name];
    if (!cfg) return false;
    return this.runtimes.get(name)?.healthCheck() ?? false;
  }

  // ── Read Models ─────────────────────────────────────────────

  getToolsReadModel(): ReturnType<typeof buildMcpToolsReadModel> {
    return buildMcpToolsReadModel({
      tools: this.getTools(),
      servers: this.getToolServers(),
      statuses: this.getStatus(),
      getServerTools: (name) => this.getServerTools(name),
      invocationStats: this.getInvocationStats(),
    });
  }

  findToolCapability(serverName: string, toolName: string): McpToolCapability | null {
    const projection = this.getToolsReadModel();
    const server = projection.serverDetails.find((candidate) => candidate.name === serverName);
    const tool = server?.tools.find((candidate) => candidate.name === toolName);
    return tool ? { ...tool, serverName } : null;
  }

  private rebuildRuntimes(nextServers: Record<string, McpServerConfig>): void {
    for (const [name, runtime] of Array.from(this.runtimes.entries())) {
      if (!nextServers[name]) {
        void runtime.dispose();
        this.runtimes.delete(name);
      }
    }
    for (const [name, config] of Object.entries(nextServers)) {
      const existing = this.runtimes.get(name);
      if (existing) existing.updateConfig(config);
      else this.runtimes.set(name, new McpServerRuntime({
        name,
        config,
        processRunner: this.options.processRunner,
        processScope: this.options.processRunner.createDirectScope(this.options.processRunner.serviceRootScope, `mcp-server:${name}`, 'service_infrastructure'),
        ids: this,
        invocationStats: this.invocationStats,
      }));
    }
  }
}
