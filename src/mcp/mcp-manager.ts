/** MCP Server Lifecycle Manager facade. */

import { EventLogger } from '../observability/index.js';
import { createResourceScope, type ResourceScope } from '../lifecycle/index.js';
import {
  compileMcpArgumentValidator,
  fingerprintMcpInputSchema,
  validateMcpArguments,
  type CachedMcpArgumentValidator,
} from './mcp-argument-validator.js';
import { InvalidArgumentsError, ServerNotRunningError, ToolNotFoundError } from './errors.js';
import { MCP_INVOKE_TIMEOUT_MS, type McpServerStatus, type McpStatus, type McpToolDefinition } from './protocol.js';
import { loadMcpServersFromConfig, type McpServerConfig, type McpServerHandle } from './server-registry.js';
import { McpInvocationStatsRecorder } from './invocation-stats.js';
import { buildMcpServerStatus, buildMcpToolsReadModel } from './status-projection.js';
import { discoverStreamableHttpTools, healthStreamableHttpServer, invokeStreamableHttpTool, probeStreamableHttpStartup } from './streamable-http-transport.js';
import { discoverStdioTools, healthStdioProcess, invokeStdioTool, stopStdioProcess } from './stdio-transport.js';

export type { McpServerConfig, McpServerHandle } from './server-registry.js';
export type { McpTransport, McpStatus, McpServerStatus, McpToolAnnotations, McpToolDefinition, McpJsonRpcRequest, McpJsonRpcResponse, McpJsonRpcError, ListToolsResult, McpInitializeParams, ToolsCallResult } from './protocol.js';
export { MCP_INVOKE_TIMEOUT_MS } from './protocol.js';
export { McpInvokeError, ServerNotRunningError, ToolNotFoundError, InvalidArgumentsError, TimeoutError, TransportError } from './errors.js';

export interface McpStatusProvider { getStatus(): McpServerStatus[] }
export interface McpToolInvocationPort { getServerTools(name: string): McpToolDefinition[] | undefined; invokeTool(serverName: string, toolName: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> }
export interface McpToolsReadModelProvider { getToolsReadModel(): ReturnType<typeof buildMcpToolsReadModel> }

export interface McpManagerOptions { scope?: ResourceScope; }

export class McpManager {
  private projectRoot: string;
  private readonly scope: ResourceScope;
  /** All configured MCP servers, loaded at construction time. */
  private servers: Record<string, McpServerConfig>;
  /** Handles for currently running servers. */
  private handles: Map<string, McpServerHandle> = new Map();
  /** Status overrides for servers that are not in the handles map
   * (e.g. exited unexpectedly, errors, stopped). Stores error messages. */
  private statusOverrides: Map<string, { status: McpStatus; error?: string }> = new Map();
  /** Timestamps of last successful start per server. */
  private startedAt: Map<string, string> = new Map();
  /** Cached tool definitions per server name. */
  private toolsCache: Map<string, McpToolDefinition[]> = new Map();
  /** Compiled local argument validators keyed by server/tool/schema fingerprint. */
  private argumentValidatorCache: Map<string, CachedMcpArgumentValidator> = new Map();
  /** Servers that have completed init+tools/list successfully. */
  private toolsCacheInitialized: Set<string> = new Set();
  /** Discovery error messages per server (not surfaced as status changes). */
  private discoveryErrors: Map<string, string> = new Map();
  /** Auto-incrementing JSON-RPC message ID counter. */
  private nextMsgId = 1;
  private readonly invocationStats = new McpInvocationStatsRecorder();

  /**
   * Per-server stdio invocation queue.
   *
   * Each entry is a promise representing the tail of the invocation
   * chain for that server. Concurrent invokeTool() calls to the same
   * stdio server are serialized by chaining onto this promise so that
   * only one invocation writes to stdin / reads from stdout at a time.
   *
   * The stored promise is always settled (via .catch(() => {})) so
   * errors in one invocation never break the chain for subsequent ones.
   */
  private _invocationQueues: Map<string, Promise<void>> = new Map();

  constructor(projectRoot: string, options: McpManagerOptions = {}) {
    this.projectRoot = projectRoot;
    this.scope = options.scope ?? createResourceScope('mcp-manager');
    this.servers = loadMcpServersFromConfig(projectRoot);
    this.scope.add({ dispose: () => { this.toolsCache.clear(); this.argumentValidatorCache.clear(); this.toolsCacheInitialized.clear(); this.discoveryErrors.clear(); this._invocationQueues.clear(); } }, { name: 'mcp-manager-caches' });
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
  reloadServersFromConfig(): void {
    this.servers = loadMcpServersFromConfig(this.projectRoot);
  }

  async startAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [name, cfg] of Object.entries(this.servers)) {
      if (!cfg.disabled && cfg.autostart) {
        promises.push(this.startServer(name));
      }
    }
    await Promise.allSettled(promises);
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
    const cfg = this.servers[name];
    if (!cfg) {
      throw new Error(`MCP server '${name}' not found in configuration.`);
    }

    if (cfg.disabled) {
      return; // silently skip disabled servers
    }

    // If already running, do nothing
    const existing = this.handles.get(name);
    if (existing) {
      if (cfg.transport === 'stdio' && existing.process && !existing.process.killed) {
        return;
      }
      if (cfg.transport === 'sse' && existing.abortController) {
        return;
      }
    }

    // Clear any previous error override
    this.statusOverrides.delete(name);

    if (cfg.transport === 'stdio') {
      await this._startStdio(name, cfg);
    } else {
      await this._startSse(name, cfg);
    }

    // ── Tool Discovery ─────────────────────────────────────────
    // Only attempt discovery if the server handle is still present
    // (it may have been removed by an immediate exit during _startStdio).
    if (this.handles.has(name)) {
      try {
        await this._discoverTools(name);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Record the discovery error for diagnostics but don't change
        // the server status — the process is still running.
        this.discoveryErrors.set(name, errMsg);
      }
    }
  }

  /**
   * Stop a single MCP server by name.
   *
   * For stdio: sends SIGTERM, waits 3 s, then SIGKILL if still alive.
   * For sse: aborts the AbortController to close the connection.
   *
   * Clears the cached tool list for this server.
   */
  async stopServer(name: string): Promise<void> {
    const handle = this.handles.get(name);
    if (!handle) {
      // Server not running — nothing to do
      return;
    }

    const cfg = this.servers[name];
    if (!cfg) {
      // Config removed after start — just clean up the handle
      await this._killHandle(handle);
      this.handles.delete(name);
      this.toolsCache.delete(name);
      this.toolsCacheInitialized.delete(name);
      this.discoveryErrors.delete(name);
      this._clearArgumentValidatorCacheForServer(name);
      return;
    }

    if (cfg.transport === 'stdio' && handle.process) {
      await this._stopStdio(name, handle.process);
    } else if (cfg.transport === 'sse' && handle.abortController) {
      handle.abortController.abort();
    }

    this.handles.delete(name);
    this.statusOverrides.set(name, { status: 'stopped' });

    // Clear tool cache on stop
    this.toolsCache.delete(name);
    this.toolsCacheInitialized.delete(name);
    this.discoveryErrors.delete(name);
    this._clearArgumentValidatorCacheForServer(name);

    // Clear invocation queue for this server on stop
    this._invocationQueues.delete(name);
  }

  /**
   * Stop all running servers.
   */
  async stopAll(): Promise<void> {
    const names = Array.from(this.handles.keys());
    const promises = names.map((n) => this.stopServer(n));
    await Promise.allSettled(promises);
  }

  /**
   * Restart a server: stop then start.
   */
  async restartServer(name: string): Promise<void> {
    await this.stopServer(name);
    await this.startServer(name);
  }

  /**
   * Return status for all configured servers (including disabled ones).
   */
  getStatus(): McpServerStatus[] {
    return Object.keys(this.servers).map((name) => this._buildStatus(name));
  }

  /**
   * Return status for a single server, or undefined if not configured.
   */
  getServerStatus(name: string): McpServerStatus | undefined {
    if (!this.servers[name]) return undefined;
    return this._buildStatus(name);
  }

  /**
   * Return merged tool definitions from all servers.
   */
  getTools(): McpToolDefinition[] {
    const all: McpToolDefinition[] = [];
    for (const tools of this.toolsCache.values()) {
      all.push(...tools);
    }
    return all;
  }

  /**
   * Return cached tool definitions for a specific server.
   */
  getServerTools(name: string): McpToolDefinition[] | undefined {
    return this.toolsCache.get(name);
  }

  /**
   * Return server names that have cached tool definitions.
   */
  getToolServers(): string[] {
    return Array.from(this.toolsCache.keys());
  }

  /**
   * Invoke an MCP tool on a running server.
   *
   * Sends a `tools/call` JSON-RPC request over the appropriate transport
   * (stdio or SSE) and returns the result. The response is screened for
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
    // 1. Check server is configured
    const cfg = this.servers[serverName];
    if (!cfg) {
      throw new ServerNotRunningError(serverName);
    }

    // 2. Check server is running
    const handle = this.handles.get(serverName);
    if (!handle) {
      throw new ServerNotRunningError(serverName);
    }

    if (cfg.transport === 'stdio') {
      if (!handle.process || handle.process.killed || handle.process.exitCode !== null) {
        throw new ServerNotRunningError(serverName);
      }
    } else {
      if (!handle.abortController || handle.abortController.signal.aborted) {
        throw new ServerNotRunningError(serverName);
      }
    }

    // 3. Check tool exists in cache
    const serverTools = this.toolsCache.get(serverName);
    const toolDefinition = serverTools?.find((t) => t.name === toolName);
    if (!toolDefinition) {
      throw new ToolNotFoundError(serverName, toolName);
    }

    // 4. Enforce the discovered inputSchema locally before stdio/SSE dispatch.
    this._validateToolArguments(serverName, toolName, toolDefinition.inputSchema, args);

    // 5. Dispatch to transport-specific implementation
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? MCP_INVOKE_TIMEOUT_MS;

    if (cfg.transport === 'stdio') {
      // -- Stdio: serialize via per-server invocation queue ----
      try {
        const result = await this._enqueueStdioInvocation(serverName, async () => {
          return await invokeStdioTool({ serverName, toolName, args, config: cfg, handle, timeoutMs, ids: this });
        });
        const durationMs = Date.now() - startTime;
        this.invocationStats.record(serverName, toolName, true);
        this.invocationStats.log(serverName, toolName, true, durationMs);
        return result;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.invocationStats.record(serverName, toolName, false);
        this.invocationStats.log(serverName, toolName, false, durationMs, errorMsg);
        throw err;
      }
    } else {
      // -- SSE: invoke directly, no serialization needed -------
      try {
        const result = await invokeStreamableHttpTool({ serverName, toolName, args, config: cfg, handle, timeoutMs, ids: this });
        const durationMs = Date.now() - startTime;
        this.invocationStats.record(serverName, toolName, true);
        this.invocationStats.log(serverName, toolName, true, durationMs);
        return result;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.invocationStats.record(serverName, toolName, false);
        this.invocationStats.log(serverName, toolName, false, durationMs, errorMsg);
        throw err;
      }
    }
  }

  /**
   * Health check a specific server.
   *
   * - stdio: process must be running (pid alive, not exited with an error code).
   * - sse: performs a HEAD request (fallback to GET) to the configured URL
   *   and expects a 2xx response.
   *
   * Returns true if healthy, false otherwise.
   */
  async healthCheck(name: string): Promise<boolean> {
    const cfg = this.servers[name];
    if (!cfg) return false;
    if (cfg.disabled) return false;

    if (cfg.transport === 'stdio') {
      return healthStdioProcess(this.handles.get(name));
    }
    if (cfg.transport === 'sse') {
      return healthStreamableHttpServer({ serverName: name, config: cfg, handle: this.handles.get(name) });
    }

    return false;
  }

  // ── Private: Argument Validation ──────────────────────────

  private _validatorCacheKey(serverName: string, toolName: string, fingerprint: string): string {
    return `${serverName}:${toolName}:${fingerprint}`;
  }

  private _clearArgumentValidatorCacheForServer(serverName: string): void {
    const prefix = `${serverName}:`;
    for (const key of Array.from(this.argumentValidatorCache.keys())) {
      if (key.startsWith(prefix)) {
        this.argumentValidatorCache.delete(key);
      }
    }
  }

  private _validateToolArguments(
    serverName: string,
    toolName: string,
    inputSchema: unknown,
    args: Record<string, unknown>,
  ): void {
    const fingerprint = fingerprintMcpInputSchema(inputSchema);
    const cacheKey = this._validatorCacheKey(serverName, toolName, fingerprint);
    let compiled = this.argumentValidatorCache.get(cacheKey);
    if (!compiled) {
      compiled = compileMcpArgumentValidator(inputSchema);
      this.argumentValidatorCache.set(cacheKey, compiled);
    }

    const result = validateMcpArguments(compiled, args);
    if (!result.ok) {
      throw new InvalidArgumentsError(serverName, toolName, {
        source: 'local_input_schema_validation',
        reason: result.type,
        diagnostics: result.diagnostics,
      });
    }
  }

  // ── Private: Invocation Queue ─────────────────────────────

  /**
   * Enqueue a stdio tool invocation so that concurrent calls to the
   * same server are serialized.  The `fn` callback performs the actual
   * stdio exchange (write request to stdin, read response from stdout).
   *
   * The queue is per-server.  If a previous invocation threw an error,
   * the chain continues — no single failure can stall the queue.
   *
   * @param serverName  Server whose queue to use.
   * @param fn          Callback that performs the stdio invocation.
   * @returns           The result of `fn()` (or its rejection).
   */
  private _enqueueStdioInvocation<T>(serverName: string, fn: () => Promise<T>): Promise<T> {
    // Get the current tail, default to an immediately-resolved promise
    const prev = this._invocationQueues.get(serverName) ?? Promise.resolve();

    // Chain: always call fn() regardless of whether prev failed.
    // This ensures a single error never breaks the queue.
    const next = prev.then(
      () => fn(),
      () => fn(),
    );

    // Store a *settled* promise as the new tail so errors don't propagate
    // to subsequent links in the chain.  .catch(() => {}) swallows the
    // rejection and produces a resolved promise.
    this._invocationQueues.set(serverName, next.catch(() => {}) as Promise<void>);

    // Return the actual promise so the caller gets the real result or error.
    return next;
  }

  // ── Private: Start ──────────────────────────────────────────

  private async _startStdio(name: string, cfg: McpServerConfig): Promise<void> {
    if (!cfg.command) {
      const msg = `stdio MCP server '${name}' has no 'command' configured.`;
      this.statusOverrides.set(name, { status: 'error', error: msg });
      throw new Error(msg);
    }

    const childEnv = { ...process.env, ...(cfg.env ?? {}) };
    const args = cfg.args ?? [];

    const proc = this.scope.spawn(cfg.command, args, {
      name: `mcp-stdio:${name}`,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Do not attach to parent tty
    }).process;

    this.handles.set(name, { process: proc });
    this.startedAt.set(name, new Date().toISOString());

    // Monitor process exit
    proc.on('exit', (code, signal) => {
      const handle = this.handles.get(name);
      if (handle && handle.process === proc) {
        let errMsg: string;
        if (signal) {
          errMsg = `Process exited with signal ${signal}`;
        } else if (code !== 0) {
          errMsg = `Process exited with code ${code}`;
        } else {
          // Clean exit with code 0 — treat as stopped, not error
          this.handles.delete(name);
          this.statusOverrides.set(name, { status: 'stopped' });
          // Clean up tool cache on exit
          this.toolsCache.delete(name);
          this.toolsCacheInitialized.delete(name);
          this.discoveryErrors.delete(name);
          this._clearArgumentValidatorCacheForServer(name);
          return;
        }
        this.handles.delete(name);
        this.statusOverrides.set(name, { status: 'error', error: errMsg });
        this.toolsCache.delete(name);
        this.toolsCacheInitialized.delete(name);
        this.discoveryErrors.delete(name);
        this._clearArgumentValidatorCacheForServer(name);
      }
    });

    proc.on('error', (_err) => {
      const handle = this.handles.get(name);
      if (handle && handle.process === proc) {
        const errMsg = `Process error: ${_err.message}`;
        this.handles.delete(name);
        this.statusOverrides.set(name, { status: 'error', error: errMsg });
        this.toolsCache.delete(name);
        this.toolsCacheInitialized.delete(name);
        this.discoveryErrors.delete(name);
        this._clearArgumentValidatorCacheForServer(name);
      }
    });

    // Suppress EPIPE/stream errors on stdin/stdout — they occur
    // naturally when a bad command exits early.  The 'exit' handler
    // above already cleans up the handle and status so there is no
    // need for an uncaught exception to crash the process.
    if (proc.stdin) {
      proc.stdin.on('error', () => {
        /* EPIPE expected on early exit */
      });
    }
    if (proc.stdout) {
      proc.stdout.on('error', () => {
        /* stream closed by early exit */
      });
    }
  }

  private async _startSse(name: string, cfg: McpServerConfig): Promise<void> {
    if (!cfg.url) {
      const msg = `sse MCP server '${name}' has no 'url' configured.`;
      this.statusOverrides.set(name, { status: 'error', error: msg });
      throw new Error(msg);
    }

    const abortController = new AbortController();
    this.handles.set(name, { abortController });
    this.startedAt.set(name, new Date().toISOString());

    const startupProbe = await probeStreamableHttpStartup({ serverName: name, config: cfg, signal: abortController.signal });
    if (!startupProbe.ok && !startupProbe.aborted) {
      this.handles.delete(name);
      this.statusOverrides.set(name, { status: 'error', error: startupProbe.error });
    }
  }

  // ── Private: Tool Discovery ─────────────────────────────────

  /**
   * Discover tools from a running MCP server by performing the init
   * handshake followed by tools/list. Dispatches to the appropriate
   * transport-specific implementation.
   */
  private async _discoverTools(name: string): Promise<void> {
    const cfg = this.servers[name];
    if (!cfg) return;

    if (cfg.transport === 'stdio') {
      await this._discoverToolsStdio(name);
    } else {
      await this._discoverToolsSse(name, cfg);
    }
  }

  /**
   * Discover tools from a stdio MCP server via transport module.
   */
  private async _discoverToolsStdio(name: string): Promise<void> {
    const tools = await discoverStdioTools({ serverName: name, handle: this.handles.get(name), ids: this });
    this.toolsCache.set(name, tools);
    this._clearArgumentValidatorCacheForServer(name);
    this.toolsCacheInitialized.add(name);
  }

  /**
   * Discover tools from an SSE (Streamable HTTP) MCP server via
   * HTTP POST init + tools/list.
   */
  private async _discoverToolsSse(name: string, cfg: McpServerConfig): Promise<void> {
    const tools = await discoverStreamableHttpTools({ serverName: name, config: cfg, handle: this.handles.get(name), ids: this });
    this.toolsCache.set(name, tools);
    this._clearArgumentValidatorCacheForServer(name);
    this.toolsCacheInitialized.add(name);
  }

  // ── Private: Stop ───────────────────────────────────────────

  private async _stopStdio(_name: string, proc: import('node:child_process').ChildProcess): Promise<void> { await stopStdioProcess(proc); }

  private async _killHandle(handle: McpServerHandle): Promise<void> {
    if (handle.process && !handle.process.killed) await stopStdioProcess(handle.process);
    if (handle.abortController) handle.abortController.abort();
  }

  // ── Private: Health ─────────────────────────────────────────

  // ── Private: Status Building ────────────────────────────────

  getToolsReadModel(): ReturnType<typeof buildMcpToolsReadModel> {
    return buildMcpToolsReadModel({
      tools: this.getTools(),
      servers: this.getToolServers(),
      statuses: this.getStatus(),
      getServerTools: (name) => this.getServerTools(name),
      invocationStats: this.getInvocationStats(),
    });
  }

  private _buildStatus(name: string): McpServerStatus {
    return buildMcpServerStatus({
      name,
      config: this.servers[name],
      handle: this.handles.get(name),
      override: this.statusOverrides.get(name),
      startedAt: this.startedAt.get(name),
      tools: this.toolsCache.get(name),
    });
  }
}

