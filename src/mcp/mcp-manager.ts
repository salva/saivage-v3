/**
 * MCP Server Lifecycle Manager
 *
 * Manages external Model Context Protocol (MCP) servers defined in
 * saivage.json under the `mcpServers` section. Supports two transports:
 *
 * - **stdio**: Spawns a child process with configured command/args/env.
 *   Health checked by verifying the process is alive (pid exists, not exited).
 * - **sse**: Connects to an HTTP SSE endpoint. Health checked via HEAD/GET
 *   to the configured URL expecting a 2xx response.
 *
 * Lifecycle operations: start, stop (SIGTERM then SIGKILL), restart, health
 * check. Disabled servers are skipped. Autostart servers are started on
 * startAll().
 *
 * Also performs MCP tool discovery via the tools/list protocol after server
 * startup. Cached tool definitions are exposed via getTools(),
 * getServerTools(), and getToolServers().
 *
 * invokeTool() enables execution-time MCP tool invocation over both stdio
 * and SSE transports with structured error types. Invocation statistics
 * are tracked per server:tool key and exposed via getInvocationStats().
 *
 * See docs/design/configuration.md § MCP Servers and docs/design/implementation-plan.md Stage 9.
 */

import { ChildProcess, spawn } from 'node:child_process';
import { loadConfig, type SaivageConfig } from '../agents/config-schema.js';
import { EventLogger } from '../utils/event-logger.js';
import * as readline from 'node:readline';
import {
  compileMcpArgumentValidator,
  fingerprintMcpInputSchema,
  validateMcpArguments,
  type CachedMcpArgumentValidator,
} from './mcp-argument-validator.js';

// ── MCP Protocol Types ────────────────────────────────────────

/** MCP tool annotations (behavior hints). */
export interface McpToolAnnotations {
  /** Human-readable title for the tool. */
  title?: string;
  /** Tool does not modify its environment (default: false). */
  readOnlyHint?: boolean;
  /** Tool may perform destructive updates (default: true). */
  destructiveHint?: boolean;
  /** Repeated calls with the same arguments have no additional effect (default: false). */
  idempotentHint?: boolean;
  /** Tool interacts with external entities (default: true). */
  openWorldHint?: boolean;
}

/** MCP Tool definition as returned by tools/list. */
export interface McpToolDefinition {
  /** Unique identifier for the tool (programmatic use). */
  name: string;
  /** Human-readable display name. */
  title?: string;
  /** Human-readable description of the tool. */
  description?: string;
  /** JSON Schema object defining the expected parameters for the tool. */
  inputSchema: {
    type: 'object';
    properties?: Record<string, object>;
    required?: string[];
  };
  /** Optional JSON Schema object defining the structure of the tool's output. */
  outputSchema?: {
    type: 'object';
    properties?: Record<string, object>;
    required?: string[];
  };
  /** Optional additional tool information. */
  annotations?: McpToolAnnotations;
  /** Extension metadata. */
  _meta?: Record<string, unknown>;
}

/** MCP JSON-RPC 2.0 request message. */
export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** MCP JSON-RPC 2.0 success response message. */
export interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

/** MCP JSON-RPC 2.0 error response message. */
export interface McpJsonRpcError {
  jsonrpc: '2.0';
  id: number | string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** Response payload from tools/list. */
export interface ListToolsResult {
  /** Array of tool definitions returned by the server. */
  tools: McpToolDefinition[];
  /** Opaque cursor for pagination; absent on the last page. */
  nextCursor?: string;
}

/** Parameters sent with the initialize request. */
export interface McpInitializeParams {
  /** The protocol version the client supports. */
  protocolVersion: string;
  /** Client capabilities. */
  capabilities: Record<string, unknown>;
  /** Information about the client. */
  clientInfo: {
    name: string;
    version: string;
  };
}

/** Result of a tools/call invocation. */
export interface ToolsCallResult {
  /** MCP content items returned by the tool. */
  content: Array<{
    type: string;
    [key: string]: unknown;
  }>;
  /** Whether the LLM should make a followup request. */
  isError?: boolean;
  /** Structured error content for agents. */
  structuredContent?: Record<string, unknown>;
}

// ── Structured Error Types ──────────────────────────────────

/** Base error class for MCP tool invocation failures. */
export class McpInvokeError extends Error {
  /** Machine-readable error code for routing / display. */
  public readonly code: string;
  /** Suggested HTTP status code for API responses. */
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = 'McpInvokeError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** The requested MCP server is not configured or not currently running. */
export class ServerNotRunningError extends McpInvokeError {
  constructor(serverName: string) {
    super(`MCP server '${serverName}' is not running`, 'SERVER_NOT_RUNNING', 404);
    this.name = 'ServerNotRunningError';
  }
}

/** The requested tool does not exist on the MCP server. */
export class ToolNotFoundError extends McpInvokeError {
  constructor(serverName: string, toolName: string) {
    super(`Tool '${toolName}' not found on MCP server '${serverName}'`, 'TOOL_NOT_FOUND', 404);
    this.name = 'ToolNotFoundError';
  }
}

/** The arguments passed to the tool are invalid according to its schema. */
export class InvalidArgumentsError extends McpInvokeError {
  public readonly data: unknown;

  constructor(serverName: string, toolName: string, data?: unknown) {
    const dataStr = data !== undefined ? `: ${JSON.stringify(data)}` : '';
    super(
      `Invalid arguments for tool '${toolName}' on server '${serverName}'${dataStr}`,
      'INVALID_ARGUMENTS',
      400,
    );
    this.name = 'InvalidArgumentsError';
    this.data = data;
  }
}

/** The MCP tool invocation timed out before receiving a response. */
export class TimeoutError extends McpInvokeError {
  constructor(serverName: string, toolName: string, timeoutMs: number) {
    super(
      `Tool '${toolName}' on server '${serverName}' timed out after ${timeoutMs}ms`,
      'TIMEOUT',
      408,
    );
    this.name = 'TimeoutError';
  }
}

/** A transport-level error occurred (connection lost, process died, etc.). */
export class TransportError extends McpInvokeError {
  constructor(serverName: string, detail: string) {
    super(`Transport error on MCP server '${serverName}': ${detail}`, 'TRANSPORT_ERROR', 502);
    this.name = 'TransportError';
  }
}

// ── Types ─────────────────────────────────────────────────────

/** Transport type for an MCP server. */
export type McpTransport = 'stdio' | 'sse';

/** Runtime status of a configured MCP server. */
export type McpStatus = 'running' | 'stopped' | 'error';

/** Public status snapshot returned by the manager. */
export interface McpServerStatus {
  name: string;
  transport: McpTransport;
  status: McpStatus;
  pid?: number;
  error?: string;
  startedAt?: string;
  /** Number of tools discovered from this server (if any). */
  tools_count?: number;
}

/** Internal record for a running server. */
interface McpServerHandle {
  process?: ChildProcess;
  abortController?: AbortController;
}

/** Shape of an individual MCP server entry from saivage.json. */
interface McpServerConfig {
  transport: McpTransport;
  disabled: boolean;
  autostart: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

// ── Constants ─────────────────────────────────────────────────

const SIGTERM_TIMEOUT_MS = 3_000; // Wait 3 s after SIGTERM before SIGKILL
const MCP_DISCOVERY_TIMEOUT_MS = 10_000; // Timeout for init+tools/list handshake
/** Default timeout for tools/call invocations. */
export const MCP_INVOKE_TIMEOUT_MS = 30_000;
const MCP_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_NAME = 'saivage-mcp-manager';
const CLIENT_VERSION = '0.1.0';

// ── Helpers ───────────────────────────────────────────────────

function normalizeMcpServers(config: SaivageConfig): Record<string, McpServerConfig> {
  const raw = config.mcpServers ?? {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(raw)) {
    out[name] = {
      transport: entry.transport,
      disabled: entry.disabled ?? false,
      autostart: entry.autostart ?? true,
      command: entry.command,
      args: entry.args,
      env: entry.env,
      url: entry.url,
    };
  }
  return out;
}

// ── Manager ───────────────────────────────────────────────────

export class McpManager {
  private projectRoot: string;
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
  /** Optional EventLogger for recording MCP tool invocations. */
  private _eventLogger?: EventLogger;
  /** Invocation statistics per server:tool key.
   *  Key format: `${serverName}:${toolName}` */
  private _invocationStats: Map<
    string,
    {
      total: number;
      success: number;
      error: number;
      lastInvokedAt?: string;
    }
  > = new Map();

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

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    const { config } = loadConfig(projectRoot);
    this.servers = normalizeMcpServers(config);
  }

  // ── Event Logger ────────────────────────────────────────────

  /**
   * Attach an EventLogger for recording MCP tool invocations.
   * When set, every tools/call invocation will be logged with
   * server name, tool name, success/failure, and duration.
   */
  setEventLogger(logger: EventLogger): void {
    this._eventLogger = logger;
  }

  /**
   * Log an MCP tool invocation event through the attached EventLogger.
   * No-op if no EventLogger is attached.
   */
  private _logInvocation(
    server: string,
    tool: string,
    success: boolean,
    durationMs: number,
    error?: string,
  ): void {
    if (!this._eventLogger) return;
    this._eventLogger.appendEvent({
      kind: 'mcp_tool_invocation' as import('../schemas/types.js').EventKind,
      server,
      tool,
      success,
      duration_ms: durationMs,
      error,
    });
  }

  // ── Invocation Statistics ───────────────────────────────────

  /**
   * Record an MCP tool invocation in the internal statistics map.
   * Called on every invokeTool() success or failure.
   */
  private _recordInvocation(serverName: string, toolName: string, success: boolean): void {
    const key = `${serverName}:${toolName}`;
    const current = this._invocationStats.get(key) ?? { total: 0, success: 0, error: 0 };
    current.total++;
    if (success) current.success++;
    else current.error++;
    current.lastInvokedAt = new Date().toISOString();
    this._invocationStats.set(key, current);
  }

  /**
   * Return invocation statistics for all tools that have been invoked
   * during this session. Key format is `${serverName}:${toolName}`.
   */
  getInvocationStats(): Record<
    string,
    { total: number; success: number; error: number; lastInvokedAt?: string }
  > {
    const out: Record<
      string,
      { total: number; success: number; error: number; lastInvokedAt?: string }
    > = {};
    for (const [key, val] of this._invocationStats) {
      out[key] = val;
    }
    return out;
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Start all autostart servers. Disabled servers are skipped.
   */
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
          return await this._invokeToolStdio(serverName, toolName, args, cfg, timeoutMs);
        });
        const durationMs = Date.now() - startTime;
        this._recordInvocation(serverName, toolName, true);
        this._logInvocation(serverName, toolName, true, durationMs);
        return result;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMsg = err instanceof Error ? err.message : String(err);
        this._recordInvocation(serverName, toolName, false);
        this._logInvocation(serverName, toolName, false, durationMs, errorMsg);
        throw err;
      }
    } else {
      // -- SSE: invoke directly, no serialization needed -------
      try {
        const result = await this._invokeToolSse(serverName, toolName, args, cfg, timeoutMs);
        const durationMs = Date.now() - startTime;
        this._recordInvocation(serverName, toolName, true);
        this._logInvocation(serverName, toolName, true, durationMs);
        return result;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMsg = err instanceof Error ? err.message : String(err);
        this._recordInvocation(serverName, toolName, false);
        this._logInvocation(serverName, toolName, false, durationMs, errorMsg);
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
      return this._healthStdio(name);
    }
    if (cfg.transport === 'sse') {
      return this._healthSse(name, cfg);
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

  // ── Private: Tool Invocation ──────────────────────────────

  /**
   * Invoke a tool on a stdio MCP server.
   *
   * Creates a temporary readline interface on the process's stdout,
   * writes the tools/call JSON-RPC request to stdin, and reads the
   * matching response.
   */
  private async _invokeToolStdio(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    _cfg: McpServerConfig,
    timeoutMs: number,
  ): Promise<unknown> {
    const handle = this.handles.get(serverName);
    const proc = handle!.process!;

    if (!proc.stdin || !proc.stdout) {
      throw new TransportError(serverName, 'Process has no stdin/stdout pipes');
    }

    const rl = readline.createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    let rlClosed = false;
    const onRlClose = () => {
      rlClosed = true;
    };
    rl.once('close', onRlClose);

    try {
      const requestId = this.nextMsgId++;
      const request: McpJsonRpcRequest = {
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      };

      this._safeWrite(proc.stdin, JSON.stringify(request) + '\n', serverName);

      const response = await this._readResponse(rl, requestId, abortController.signal);

      if (!response) {
        if (abortController.signal.aborted) {
          throw new TimeoutError(serverName, toolName, timeoutMs);
        }
        throw new TransportError(serverName, 'stdio stream closed before response received');
      }

      return this._processToolsCallResponse(response, serverName, toolName);
    } finally {
      clearTimeout(timeoutId);
      rl.close();
      if (!rlClosed) {
        await new Promise<void>((resolve) => {
          const onClose = () => {
            clearTimeout(fallback);
            resolve();
          };
          const fallback = setTimeout(() => {
            rl.removeListener('close', onClose);
            resolve();
          }, 100);
          rl.once('close', onClose);
        });
      }
    }
  }

  /**
   * Invoke a tool on an SSE MCP server.
   *
   * Sends the tools/call JSON-RPC request via HTTP POST to the server's
   * configured URL.
   */
  private async _invokeToolSse(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    cfg: McpServerConfig,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!cfg.url) {
      throw new TransportError(serverName, 'No URL configured for SSE server');
    }

    const handle = this.handles.get(serverName);
    const signal = handle?.abortController?.signal;

    // Create a timeout AbortController that respects the existing signal
    const invokeAbort = new AbortController();
    const timeoutId = setTimeout(() => {
      invokeAbort.abort();
    }, timeoutMs);

    // If the server's abortController fires, also abort our request
    if (signal) {
      const onServerAbort = () => {
        invokeAbort.abort();
      };
      signal.addEventListener('abort', onServerAbort, { once: true });
    }

    try {
      const requestId = this.nextMsgId++;
      const request: McpJsonRpcRequest = {
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      };

      let resp: Response;
      try {
        resp = await fetch(cfg.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify(request),
          signal: invokeAbort.signal,
        });
      } catch (err) {
        if (invokeAbort.signal.aborted) {
          throw new TimeoutError(serverName, toolName, timeoutMs);
        }
        throw new TransportError(
          serverName,
          `HTTP POST failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!resp.ok) {
        throw new TransportError(serverName, `tools/call HTTP POST returned status ${resp.status}`);
      }

      let body: Record<string, unknown>;
      try {
        body = (await resp.json()) as Record<string, unknown>;
      } catch (err) {
        throw new TransportError(
          serverName,
          `Failed to parse JSON response: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return this._processToolsCallResponse(body, serverName, toolName);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Process a tools/call JSON-RPC response, mapping error codes to
   * structured error types. Returns result.content (or the full result
   * if content is absent) on success.
   */
  private _processToolsCallResponse(
    response: Record<string, unknown>,
    serverName: string,
    toolName: string,
  ): unknown {
    // Check for JSON-RPC error
    if (response.error) {
      const err = response.error as {
        code: number;
        message: string;
        data?: unknown;
      };

      // JSON-RPC code -32602 = Invalid Params (invalid arguments)
      if (err.code === -32602) {
        throw new InvalidArgumentsError(serverName, toolName, err.data);
      }

      // Other error codes
      throw new McpInvokeError(
        `MCP server '${serverName}' returned error for tool '${toolName}': ${err.message} (code ${err.code})`,
        `MCP_ERROR_${err.code}`,
        502,
      );
    }

    const result = response.result as
      | (Record<string, unknown> & {
          content?: unknown;
          isError?: boolean;
        })
      | undefined;

    if (!result) {
      throw new McpInvokeError(
        `MCP server '${serverName}' returned a response with no result for tool '${toolName}'`,
        'MCP_NO_RESULT',
        502,
      );
    }

    // If the tool itself reports an error via isError flag
    if (result.isError === true) {
      throw new McpInvokeError(
        `Tool '${toolName}' on server '${serverName}' reported an error`,
        'TOOL_EXECUTION_ERROR',
        422,
      );
    }

    // Return content if present, otherwise return the full result
    return result.content !== undefined ? result.content : result;
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

    const proc = spawn(cfg.command, args, {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Do not attach to parent tty
    });

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

    // Perform a quick health check to verify the endpoint is reachable
    try {
      const resp = await fetch(cfg.url, {
        method: 'HEAD',
        signal: abortController.signal,
      });
      if (!resp.ok) {
        const msg = `SSE health check returned status ${resp.status}`;
        this.handles.delete(name);
        this.statusOverrides.set(name, { status: 'error', error: msg });
        // Don't throw — the caller may still want to interact with the server
        // but we record the error status
      }
    } catch (err) {
      // Only report as error if not aborted by us
      if (!abortController.signal.aborted) {
        const msg = `SSE health check failed: ${err instanceof Error ? err.message : String(err)}`;
        this.handles.delete(name);
        this.statusOverrides.set(name, { status: 'error', error: msg });
      }
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
   * Discover tools from a stdio MCP server via the init + tools/list
   * JSON-RPC handshake over the process's stdin/stdout.
   */
  private async _discoverToolsStdio(name: string): Promise<void> {
    const handle = this.handles.get(name);
    if (!handle || !handle.process) {
      throw new Error('Server process is not running');
    }

    const proc = handle.process;
    if (!proc.stdin || !proc.stdout) {
      throw new Error('Server process has no stdin/stdout');
    }

    // Collect tools across paginated responses
    const tools: McpToolDefinition[] = [];

    // Set up readline on stdout
    const rl = readline.createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });

    // Set up a timeout for the entire discovery sequence
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, MCP_DISCOVERY_TIMEOUT_MS);

    // Track whether the readline closed while we were waiting.
    // We'll use this to decide if we should await the close event.
    let rlClosed = false;
    const onRlClose = () => {
      rlClosed = true;
    };
    rl.once('close', onRlClose);

    try {
      // ── Step 1: Initialize ─────────────────────────────────
      const initId = this.nextMsgId++;
      const initReq: McpJsonRpcRequest = {
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: CLIENT_NAME,
            version: CLIENT_VERSION,
          },
        },
      };
      this._safeWrite(proc.stdin, JSON.stringify(initReq) + '\n', name);

      // Read lines until we get the init response or timeout
      const initResponse = await this._readResponse(rl, initId, abortController.signal);

      if (!initResponse) {
        throw new Error('Server did not respond to initialize request');
      }

      if ('error' in initResponse && initResponse.error) {
        const err = initResponse.error as { message: string; code: number };
        throw new Error(`Initialize failed: ${err.message} (code ${err.code})`);
      }

      // ── Step 2: Send initialized notification ──────────────
      const initializedNotification = {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      };
      this._safeWrite(proc.stdin, JSON.stringify(initializedNotification) + '\n', name);

      // ── Step 3: tools/list ─────────────────────────────────
      let cursor: string | undefined;
      let firstPage = true;

      do {
        const listId = this.nextMsgId++;
        const listReq: McpJsonRpcRequest = {
          jsonrpc: '2.0',
          id: listId,
          method: 'tools/list',
        };
        // Include cursor param on subsequent pages
        if (!firstPage && cursor) {
          listReq.params = { cursor };
        }
        firstPage = false;

        this._safeWrite(proc.stdin, JSON.stringify(listReq) + '\n', name);

        const listResponse = await this._readResponse(rl, listId, abortController.signal);

        if (!listResponse) {
          throw new Error('Server did not respond to tools/list request');
        }

        if ('error' in listResponse && listResponse.error) {
          const err = listResponse.error as { message: string; code: number };
          throw new Error(`tools/list failed: ${err.message} (code ${err.code})`);
        }

        const result = listResponse.result as
          | (Record<string, unknown> & {
              tools?: McpToolDefinition[];
              nextCursor?: string;
            })
          | undefined;
        if (result && Array.isArray(result.tools)) {
          tools.push(...result.tools);
          cursor = result.nextCursor;
        } else {
          cursor = undefined;
        }
      } while (cursor);

      // ── Cache and mark initialized ─────────────────────────
      this.toolsCache.set(name, tools);
      this._clearArgumentValidatorCacheForServer(name);
      this.toolsCacheInitialized.add(name);
    } finally {
      clearTimeout(timeoutId);
      // Close the readline interface to stop listening on stdout
      rl.close();
      // Wait for close only if it hasn't already closed
      if (!rlClosed) {
        await new Promise<void>((resolve) => {
          const onClose = () => {
            clearTimeout(fallback);
            resolve();
          };
          const fallback = setTimeout(() => {
            rl.removeListener('close', onClose);
            resolve();
          }, 100);
          rl.once('close', onClose);
        });
      }
    }
  }

  /**
   * Discover tools from an SSE (Streamable HTTP) MCP server via
   * HTTP POST init + tools/list.
   */
  private async _discoverToolsSse(name: string, cfg: McpServerConfig): Promise<void> {
    if (!cfg.url) {
      throw new Error('SSE server has no URL configured');
    }

    const handle = this.handles.get(name);
    const signal = handle?.abortController?.signal;

    const tools: McpToolDefinition[] = [];

    // ── Step 1: Initialize via HTTP POST ────────────────────
    const initId = this.nextMsgId++;
    const initReq: McpJsonRpcRequest = {
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: CLIENT_NAME,
          version: CLIENT_VERSION,
        },
      },
    };

    const initResp = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initReq),
      signal,
    });

    if (!initResp.ok) {
      throw new Error(`Initialize HTTP POST returned status ${initResp.status}`);
    }

    const initBody = (await initResp.json()) as Record<string, unknown>;

    if (initBody.error) {
      const err = initBody.error as { message: string; code: number };
      throw new Error(`Initialize failed: ${err.message} (code ${err.code})`);
    }

    // ── Step 2: Send initialized notification ───────────────
    const initializedNotification = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    };

    await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initializedNotification),
      signal,
    });
    // Notifications return HTTP 202; we don't need to parse the body

    // ── Step 3: tools/list ──────────────────────────────────
    let cursor: string | undefined;
    let firstPage = true;

    do {
      const listId = this.nextMsgId++;
      const listReq: McpJsonRpcRequest = {
        jsonrpc: '2.0',
        id: listId,
        method: 'tools/list',
      };
      if (!firstPage && cursor) {
        listReq.params = { cursor };
      }
      firstPage = false;

      const listResp = await fetch(cfg.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(listReq),
        signal,
      });

      if (!listResp.ok) {
        throw new Error(`tools/list HTTP POST returned status ${listResp.status}`);
      }

      const listBody = (await listResp.json()) as Record<string, unknown>;

      if (listBody.error) {
        const err = listBody.error as { message: string; code: number };
        throw new Error(`tools/list failed: ${err.message} (code ${err.code})`);
      }

      const result = listBody.result as
        | (Record<string, unknown> & {
            tools?: McpToolDefinition[];
            nextCursor?: string;
          })
        | undefined;

      if (result && Array.isArray(result.tools)) {
        tools.push(...result.tools);
        cursor = result.nextCursor;
      } else {
        cursor = undefined;
      }
    } while (cursor);

    // ── Cache and mark initialized ─────────────────────────
    this.toolsCache.set(name, tools);
    this._clearArgumentValidatorCacheForServer(name);
    this.toolsCacheInitialized.add(name);
  }

  /**
   * Safely write data to a process stdin stream, catching EPIPE/stream errors
   * and converting them to TransportError exceptions.
   *
   * This prevents uncaught EPIPE crashes when a bad stdio command exits
   * before or during the MCP handshake. The 'exit' handler in _startStdio
   * already cleans up the handle and status on process exit.
   */
  private _safeWrite(stream: NodeJS.WritableStream, data: string, serverName: string): void {
    if (stream.writable) {
      try {
        stream.write(data);
      } catch (err) {
        // EPIPE or similar write-after-close errors -> graceful manager error
        throw new TransportError(
          serverName,
          `stdio write failed (process may have exited early): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      throw new TransportError(
        serverName,
        'Process stdin is not writable (process exited before discovery/invocation)',
      );
    }
  }

  /**
   * Read lines from the readline interface until we find a JSON-RPC
   * response matching the given request ID. Returns the parsed message
   * or null if the signal is aborted or the interface closes.
   *
   * All non-matching messages (notifications, other responses) are
   * silently skipped.
   */
  private _readResponse(
    rl: readline.Interface,
    requestId: number | string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const onAbort = () => {
        cleanup();
        resolve(null);
      };

      let lineHandler: ((line: string) => void) | null = null;
      let closeHandler: (() => void) | null = null;

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        if (lineHandler) rl.removeListener('line', lineHandler);
        if (closeHandler) rl.removeListener('close', closeHandler);
      };

      if (signal.aborted) {
        resolve(null);
        return;
      }

      signal.addEventListener('abort', onAbort);

      lineHandler = (line: string) => {
        // Skip blank lines
        if (!line.trim()) return;

        try {
          const msg = JSON.parse(line) as Record<string, unknown>;

          // Check if this is the response we're waiting for
          if (msg.id === requestId && typeof msg.jsonrpc === 'string') {
            cleanup();
            resolve(msg);
          }
          // Otherwise, it's a notification or a response for another
          // request — skip it silently.
        } catch {
          // Non-JSON line (server logging to stdout?) — skip
        }
      };

      rl.on('line', lineHandler);

      closeHandler = () => {
        cleanup();
        // readline closed before we got our response
        resolve(null);
      };

      rl.on('close', closeHandler);
    });
  }

  // ── Private: Stop ───────────────────────────────────────────

  private async _stopStdio(_name: string, proc: ChildProcess): Promise<void> {
    if (proc.killed || proc.exitCode !== null) {
      // Already dead — just clean up
      return;
    }

    // Send SIGTERM first
    proc.kill('SIGTERM');

    // Wait up to SIGTERM_TIMEOUT_MS for graceful shutdown
    const killed = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), SIGTERM_TIMEOUT_MS);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });

      // If the process somehow doesn't respond to exit event but is dead
      const check = setInterval(() => {
        if (proc.killed || proc.exitCode !== null) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve(true);
        }
      }, 100);
    });

    // If still alive after timeout, send SIGKILL
    if (!killed) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Process may have died between timeout and kill
      }
    }
  }

  private async _killHandle(handle: McpServerHandle): Promise<void> {
    if (handle.process && !handle.process.killed) {
      await this._stopStdio('', handle.process);
    }
    if (handle.abortController) {
      handle.abortController.abort();
    }
  }

  // ── Private: Health ─────────────────────────────────────────

  private _healthStdio(name: string): boolean {
    const handle = this.handles.get(name);
    if (!handle || !handle.process) return false;

    const proc = handle.process;
    // Process is healthy if it's running (not killed, no exit code)
    if (proc.killed || proc.exitCode !== null) {
      return false;
    }

    // Check if pid is still alive
    try {
      process.kill(proc.pid!, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async _healthSse(name: string, cfg: McpServerConfig): Promise<boolean> {
    const handle = this.handles.get(name);
    if (!handle) return false;

    // Check if the connection was aborted
    if (handle.abortController && handle.abortController.signal.aborted) {
      return false;
    }

    if (!cfg.url) return false;

    try {
      // Try HEAD first; some SSE servers don't support HEAD, fall back to GET
      let resp = await fetch(cfg.url, { method: 'HEAD' });
      if (resp.status === 405 || resp.status === 501) {
        resp = await fetch(cfg.url, { method: 'GET' });
      }
      return resp.ok; // 2xx = healthy
    } catch {
      return false;
    }
  }

  // ── Private: Status Building ────────────────────────────────

  private _buildStatus(name: string): McpServerStatus {
    const cfg = this.servers[name];

    // Disabled servers
    if (cfg.disabled) {
      return {
        name,
        transport: cfg.transport,
        status: 'stopped',
      };
    }

    // Error override
    const override = this.statusOverrides.get(name);
    if (override && override.status === 'error') {
      const tools = this.toolsCache.get(name);
      return {
        name,
        transport: cfg.transport,
        status: 'error',
        error: override.error,
        startedAt: this.startedAt.get(name),
        tools_count: tools?.length ?? 0,
      };
    }

    // Stopped override
    if (override && override.status === 'stopped') {
      return {
        name,
        transport: cfg.transport,
        status: 'stopped',
        startedAt: this.startedAt.get(name),
        tools_count: 0,
      };
    }

    // Check handle
    const handle = this.handles.get(name);
    if (!handle) {
      return {
        name,
        transport: cfg.transport,
        status: 'stopped',
        startedAt: this.startedAt.get(name),
        tools_count: 0,
      };
    }

    if (cfg.transport === 'stdio' && handle.process) {
      const proc = handle.process;
      const tools = this.toolsCache.get(name);
      if (proc.killed || proc.exitCode !== null) {
        return {
          name,
          transport: cfg.transport,
          status: 'error',
          pid: proc.pid ?? undefined,
          error: proc.killed ? 'Process was killed' : `Process exited with code ${proc.exitCode}`,
          startedAt: this.startedAt.get(name),
          tools_count: tools?.length ?? 0,
        };
      }
      return {
        name,
        transport: cfg.transport,
        status: 'running',
        pid: proc.pid ?? undefined,
        startedAt: this.startedAt.get(name),
        tools_count: tools?.length ?? 0,
      };
    }

    if (cfg.transport === 'sse') {
      const tools = this.toolsCache.get(name);
      if (handle.abortController && handle.abortController.signal.aborted) {
        return {
          name,
          transport: cfg.transport,
          status: 'stopped',
          startedAt: this.startedAt.get(name),
          tools_count: tools?.length ?? 0,
        };
      }
      return {
        name,
        transport: cfg.transport,
        status: 'running',
        startedAt: this.startedAt.get(name),
        tools_count: tools?.length ?? 0,
      };
    }

    return {
      name,
      transport: cfg.transport,
      status: 'stopped',
    };
  }
}
