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
 * See 06-configuration.md § MCP Servers and 12-implementation-plan.md Stage 9.
 */

import { ChildProcess, spawn } from 'node:child_process';
import { loadConfig, type SaivageConfig } from '../agents/config-schema.js';

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
  }

  /**
   * Stop a single MCP server by name.
   *
   * For stdio: sends SIGTERM, waits 3 s, then SIGKILL if still alive.
   * For sse: aborts the AbortController to close the connection.
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
      return;
    }

    if (cfg.transport === 'stdio' && handle.process) {
      await this._stopStdio(name, handle.process);
    } else if (cfg.transport === 'sse' && handle.abortController) {
      handle.abortController.abort();
    }

    this.handles.delete(name);
    this.statusOverrides.set(name, { status: 'stopped' });
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
          return;
        }
        this.handles.delete(name);
        this.statusOverrides.set(name, { status: 'error', error: errMsg });
      }
    });

    proc.on('error', (_err) => {
      const handle = this.handles.get(name);
      if (handle && handle.process === proc) {
        const errMsg = `Process error: ${_err.message}`;
        this.handles.delete(name);
        this.statusOverrides.set(name, { status: 'error', error: errMsg });
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

  // ── Private: Stop ───────────────────────────────────────────

  private async _stopStdio(name: string, proc: ChildProcess): Promise<void> {
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
      return {
        name,
        transport: cfg.transport,
        status: 'error',
        error: override.error,
        startedAt: this.startedAt.get(name),
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
        };
      }
      return {
        name,
        transport: cfg.transport,
        status: 'running',
        pid: proc.pid ?? undefined,
        startedAt: this.startedAt.get(name),
      };
    }

    if (cfg.transport === 'sse') {
      if (handle.abortController && handle.abortController.signal.aborted) {
        return {
          name,
          transport: cfg.transport,
          status: 'stopped',
          startedAt: this.startedAt.get(name),
        };
      }
      return {
        name,
        transport: cfg.transport,
        status: 'running',
        startedAt: this.startedAt.get(name),
      };
    }

    return {
      name,
      transport: cfg.transport,
      status: 'stopped',
    };
  }
}
