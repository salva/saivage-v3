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
 * See 06-configuration.md § MCP Servers and 12-implementation-plan.md Stage 9.
 */

import { ChildProcess, spawn } from 'node:child_process';
import { loadConfig, type SaivageConfig } from '../agents/config-schema.js';
import * as readline from 'node:readline';

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
  /** Servers that have completed init+tools/list successfully. */
  private toolsCacheInitialized: Set<string> = new Set();
  /** Discovery error messages per server (not surfaced as status changes). */
  private discoveryErrors: Map<string, string> = new Map();
  /** Auto-incrementing JSON-RPC message ID counter. */
  private nextMsgId = 1;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    const { config } = loadConfig(projectRoot);
    this.servers = normalizeMcpServers(config);
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
        const errMsg =
          err instanceof Error ? err.message : String(err);
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
          return;
        }
        this.handles.delete(name);
        this.statusOverrides.set(name, { status: 'error', error: errMsg });
        this.toolsCache.delete(name);
        this.toolsCacheInitialized.delete(name);
        this.discoveryErrors.delete(name);
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
      }
    });
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
      proc.stdin.write(JSON.stringify(initReq) + '\n');

      // Read lines until we get the init response or timeout
      const initResponse = await this._readResponse(
        rl,
        initId,
        abortController.signal,
      );

      if (!initResponse) {
        throw new Error('Server did not respond to initialize request');
      }

      if ('error' in initResponse && initResponse.error) {
        const err = initResponse.error as { message: string; code: number };
        throw new Error(
          `Initialize failed: ${err.message} (code ${err.code})`,
        );
      }

      // ── Step 2: Send initialized notification ──────────────
      const initializedNotification = {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      };
      proc.stdin.write(JSON.stringify(initializedNotification) + '\n');

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

        proc.stdin.write(JSON.stringify(listReq) + '\n');

        const listResponse = await this._readResponse(
          rl,
          listId,
          abortController.signal,
        );

        if (!listResponse) {
          throw new Error('Server did not respond to tools/list request');
        }

        if ('error' in listResponse && listResponse.error) {
          const err = listResponse.error as { message: string; code: number };
          throw new Error(
            `tools/list failed: ${err.message} (code ${err.code})`,
          );
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
          if (
            msg.id === requestId &&
            typeof msg.jsonrpc === 'string'
          ) {
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

  /**
   * Discover tools from an SSE (Streamable HTTP) MCP server via
   * HTTP POST init + tools/list.
   */
  private async _discoverToolsSse(
    name: string,
    cfg: McpServerConfig,
  ): Promise<void> {
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
      throw new Error(
        `Initialize HTTP POST returned status ${initResp.status}`,
      );
    }

    const initBody = (await initResp.json()) as Record<string, unknown>;

    if (initBody.error) {
      const err = initBody.error as { message: string; code: number };
      throw new Error(
        `Initialize failed: ${err.message} (code ${err.code})`,
      );
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
        throw new Error(
          `tools/list HTTP POST returned status ${listResp.status}`,
        );
      }

      const listBody = (await listResp.json()) as Record<string, unknown>;

      if (listBody.error) {
        const err = listBody.error as { message: string; code: number };
        throw new Error(
          `tools/list failed: ${err.message} (code ${err.code})`,
        );
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
    this.toolsCacheInitialized.add(name);
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
          error: proc.killed
            ? 'Process was killed'
            : `Process exited with code ${proc.exitCode}`,
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
