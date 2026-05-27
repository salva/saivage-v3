import type { ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { InvalidArgumentsError, McpInvokeError, TimeoutError, TransportError } from './errors.js';
import { CLIENT_NAME, CLIENT_VERSION, MCP_DISCOVERY_TIMEOUT_MS, MCP_PROTOCOL_VERSION, SIGTERM_TIMEOUT_MS, type McpJsonRpcRequest, type McpToolDefinition } from './protocol.js';
import type { McpServerConfig, McpServerHandle } from './server-registry.js';

export interface MessageIdSource { next(): number | string }

export function safeWrite(stream: NodeJS.WritableStream, data: string, serverName: string): void {
  if (stream.writable) {
    try { stream.write(data); }
    catch (err) { throw new TransportError(serverName, `stdio write failed (process may have exited early): ${err instanceof Error ? err.message : String(err)}`); }
  } else {
    throw new TransportError(serverName, 'Process stdin is not writable (process exited before discovery/invocation)');
  }
}

export function readJsonRpcResponse(rl: readline.Interface, requestId: number | string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const onAbort = () => { cleanup(); resolve(null); };
    let lineHandler: ((line: string) => void) | null = null;
    let closeHandler: (() => void) | null = null;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (lineHandler) rl.removeListener('line', lineHandler);
      if (closeHandler) rl.removeListener('close', closeHandler);
    };
    if (signal.aborted) { resolve(null); return; }
    signal.addEventListener('abort', onAbort);
    lineHandler = (line: string) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.id === requestId && typeof msg.jsonrpc === 'string') { cleanup(); resolve(msg); }
      } catch { /* skip non-JSON stdout */ }
    };
    rl.on('line', lineHandler);
    closeHandler = () => { cleanup(); resolve(null); };
    rl.on('close', closeHandler);
  });
}

async function closeReadline(rl: readline.Interface, wasClosed: () => boolean): Promise<void> {
  rl.close();
  if (wasClosed()) return;
  await new Promise<void>((resolve) => {
    const onClose = () => { clearTimeout(fallback); resolve(); };
    const fallback = setTimeout(() => { rl.removeListener('close', onClose); resolve(); }, 100);
    rl.once('close', onClose);
  });
}

export async function discoverStdioTools(input: { serverName: string; handle?: McpServerHandle; ids: MessageIdSource }): Promise<McpToolDefinition[]> {
  const { serverName: name, handle, ids } = input;
  if (!handle?.process) throw new Error('Server process is not running');
  const proc = handle.process;
  if (!proc.stdin || !proc.stdout) throw new Error('Server process has no stdin/stdout');
  const tools: McpToolDefinition[] = [];
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), MCP_DISCOVERY_TIMEOUT_MS);
  let rlClosed = false;
  rl.once('close', () => { rlClosed = true; });
  try {
    const initId = ids.next();
    const initReq: McpJsonRpcRequest = { jsonrpc: '2.0', id: initId, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION } } };
    safeWrite(proc.stdin, JSON.stringify(initReq) + '\n', name);
    const initResponse = await readJsonRpcResponse(rl, initId, abortController.signal);
    if (!initResponse) throw new Error('Server did not respond to initialize request');
    if (initResponse.error) { const err = initResponse.error as { message: string; code: number }; throw new Error(`Initialize failed: ${err.message} (code ${err.code})`); }
    safeWrite(proc.stdin, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n', name);
    let cursor: string | undefined;
    let firstPage = true;
    do {
      const listId = ids.next();
      const listReq: McpJsonRpcRequest = { jsonrpc: '2.0', id: listId, method: 'tools/list' };
      if (!firstPage && cursor) listReq.params = { cursor };
      firstPage = false;
      safeWrite(proc.stdin, JSON.stringify(listReq) + '\n', name);
      const listResponse = await readJsonRpcResponse(rl, listId, abortController.signal);
      if (!listResponse) throw new Error('Server did not respond to tools/list request');
      if (listResponse.error) { const err = listResponse.error as { message: string; code: number }; throw new Error(`tools/list failed: ${err.message} (code ${err.code})`); }
      const result = listResponse.result as (Record<string, unknown> & { tools?: McpToolDefinition[]; nextCursor?: string }) | undefined;
      if (result && Array.isArray(result.tools)) { tools.push(...result.tools); cursor = result.nextCursor; } else cursor = undefined;
    } while (cursor);
    return tools;
  } finally {
    clearTimeout(timeoutId);
    await closeReadline(rl, () => rlClosed);
  }
}

export async function invokeStdioTool(input: { serverName: string; toolName: string; args: Record<string, unknown>; config: McpServerConfig; handle?: McpServerHandle; timeoutMs: number; ids: MessageIdSource }): Promise<unknown> {
  const { serverName, toolName, args, handle, timeoutMs, ids } = input;
  const proc = handle?.process;
  if (!proc?.stdin || !proc.stdout) throw new TransportError(serverName, 'Process has no stdin/stdout pipes');
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
  let rlClosed = false;
  rl.once('close', () => { rlClosed = true; });
  try {
    const requestId = ids.next();
    const request: McpJsonRpcRequest = { jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: toolName, arguments: args } };
    safeWrite(proc.stdin, JSON.stringify(request) + '\n', serverName);
    const response = await readJsonRpcResponse(rl, requestId, abortController.signal);
    if (!response) {
      if (abortController.signal.aborted) throw new TimeoutError(serverName, toolName, timeoutMs);
      throw new TransportError(serverName, 'stdio stream closed before response received');
    }
    return processToolsCallResponse(response, serverName, toolName);
  } finally {
    clearTimeout(timeoutId);
    await closeReadline(rl, () => rlClosed);
  }
}

export async function stopStdioProcess(proc: ChildProcess): Promise<void> {
  if (proc.killed || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  const killed = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), SIGTERM_TIMEOUT_MS);
    proc.once('exit', () => { clearTimeout(timeout); resolve(true); });
    const check = setInterval(() => {
      if (proc.killed || proc.exitCode !== null) { clearTimeout(timeout); clearInterval(check); resolve(true); }
    }, 100);
  });
  if (!killed) {
    try { proc.kill('SIGKILL'); } catch { /* process may have died */ }
  }
}

export function healthStdioProcess(handle?: McpServerHandle): boolean {
  const proc = handle?.process;
  if (!proc || proc.killed || proc.exitCode !== null) return false;
  try { process.kill(proc.pid!, 0); return true; } catch { return false; }
}

function processToolsCallResponse(response: Record<string, unknown>, serverName: string, toolName: string): unknown {
  if (response.error) {
    const err = response.error as { code: number; message: string; data?: unknown };
    if (err.code === -32602) throw new InvalidArgumentsError(serverName, toolName, err.data);
    throw new McpInvokeError(`MCP server '${serverName}' returned error for tool '${toolName}': ${err.message} (code ${err.code})`, `MCP_ERROR_${err.code}`, 502);
  }
  const result = response.result as (Record<string, unknown> & { content?: unknown; isError?: boolean }) | undefined;
  if (!result) throw new McpInvokeError(`MCP server '${serverName}' returned a response with no result for tool '${toolName}'`, 'MCP_NO_RESULT', 502);
  if (result.isError === true) throw new McpInvokeError(`Tool '${toolName}' on server '${serverName}' reported an error`, 'TOOL_EXECUTION_ERROR', 422);
  return result.content !== undefined ? result.content : result;
}
