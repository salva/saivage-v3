import { InvalidArgumentsError, McpInvokeError, TimeoutError, TransportError } from './errors.js';
import {
  CLIENT_NAME,
  CLIENT_VERSION,
  MCP_DISCOVERY_TIMEOUT_MS,
  MCP_PROTOCOL_VERSION,
  STREAMABLE_HTTP_SSE_BUFFER_LIMIT_BYTES,
  STREAMABLE_HTTP_SSE_FRAME_LIMIT_BYTES,
  type McpJsonRpcRequest,
  type McpToolDefinition,
} from './protocol.js';
import type { McpServerConfig, McpServerHandle } from './server-registry.js';

interface StreamableHttpReadContext { serverName: string; operation: string; expectedId: number | string; signal?: AbortSignal }
export interface MessageIdSource { next(): number | string }

function getContentType(resp: Response): string { return resp.headers?.get?.('content-type')?.toLowerCase() ?? ''; }

function isJsonRpcResponseForId(value: unknown, expectedId: number | string): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const msg = value as Record<string, unknown>;
  return msg.jsonrpc === '2.0' && msg.id === expectedId && ('result' in msg || 'error' in msg);
}

function sanitizeJsonRpcError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown JSON-RPC error';
  const err = error as { code?: unknown; message?: unknown };
  const code = typeof err.code === 'number' ? err.code : 'unknown';
  const message = typeof err.message === 'string' ? err.message.slice(0, 200) : 'unknown error';
  return `${message} (code ${code})`;
}

function abortPromise(signal?: AbortSignal): Promise<never> {
  if (!signal) return new Promise<never>(() => undefined);
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
}

function readChunkWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  return Promise.race([reader.read(), abortPromise(signal)]);
}

function extractSseData(frame: string): string | undefined {
  const dataLines: string[] = [];
  for (const line of frame.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') continue;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
  }
  return dataLines.length === 0 ? undefined : dataLines.join('\n');
}

export async function readStreamableHttpJsonRpcResponse(resp: Response, context: StreamableHttpReadContext): Promise<Record<string, unknown>> {
  const contentType = getContentType(resp);
  if (!contentType.includes('text/event-stream')) {
    try { return (await resp.json()) as Record<string, unknown>; }
    catch (err) { throw new TransportError(context.serverName, `Failed to parse JSON response for ${context.operation}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  if (!resp.body) throw new TransportError(context.serverName, `Streamable HTTP ${context.operation} response had no body`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bufferedBytes = 0;
  try {
    for (;;) {
      const { value, done } = await readChunkWithAbort(reader, context.signal);
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      bufferedBytes += value.byteLength;
      if (bufferedBytes > STREAMABLE_HTTP_SSE_BUFFER_LIMIT_BYTES) throw new TransportError(context.serverName, `Streamable HTTP ${context.operation} SSE buffer exceeded limit`);
      buffer += chunk;
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        bufferedBytes = new TextEncoder().encode(buffer).byteLength;
        if (new TextEncoder().encode(frame).byteLength > STREAMABLE_HTTP_SSE_FRAME_LIMIT_BYTES) throw new TransportError(context.serverName, `Streamable HTTP ${context.operation} SSE frame exceeded limit`);
        const data = extractSseData(frame);
        if (!data) { boundary = buffer.search(/\r?\n\r?\n/); continue; }
        let parsed: unknown;
        try { parsed = JSON.parse(data); }
        catch { throw new TransportError(context.serverName, `Malformed Streamable HTTP SSE data for ${context.operation}`); }
        if (isJsonRpcResponseForId(parsed, context.expectedId)) return parsed;
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  throw new TransportError(context.serverName, `Stream ended before JSON-RPC response for ${context.operation}`);
}

export async function readStreamableHttpNotificationError(resp: Response, serverName: string): Promise<string | undefined> {
  if (resp.status === 202 || resp.status === 204) return undefined;
  const contentType = getContentType(resp);
  if (contentType.includes('application/json')) {
    try { const body = (await resp.json()) as Record<string, unknown>; if (body.error) return sanitizeJsonRpcError(body.error); }
    catch { return 'malformed JSON error body'; }
  }
  if (contentType.includes('text/event-stream')) return `Streamable HTTP notification returned SSE body on MCP server '${serverName}'`;
  return undefined;
}

function sessionHeaders(handle?: McpServerHandle): Record<string, string> {
  return handle?.streamableHttpSessionId ? { 'Mcp-Session-Id': handle.streamableHttpSessionId } : {};
}

export async function discoverStreamableHttpTools(input: { serverName: string; config: McpServerConfig; handle?: McpServerHandle; ids: MessageIdSource }): Promise<McpToolDefinition[]> {
  const { serverName: name, config: cfg, handle, ids } = input;
  if (!cfg.url) throw new Error('Streamable HTTP server has no URL configured');
  const discoveryAbort = new AbortController();
  const timeoutId = setTimeout(() => discoveryAbort.abort(), MCP_DISCOVERY_TIMEOUT_MS);
  const serverSignal = handle?.abortController?.signal;
  if (serverSignal) serverSignal.addEventListener('abort', () => discoveryAbort.abort(), { once: true });
  const tools: McpToolDefinition[] = [];
  try {
    const initId = ids.next();
    const initReq: McpJsonRpcRequest = { jsonrpc: '2.0', id: initId, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION } } };
    const initResp = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(initReq), signal: discoveryAbort.signal });
    if (!initResp.ok) throw new Error(`Initialize HTTP POST returned status ${initResp.status}`);
    const sessionId = initResp.headers?.get?.('Mcp-Session-Id') ?? initResp.headers?.get?.('mcp-session-id');
    if (sessionId && handle) handle.streamableHttpSessionId = sessionId;
    const initBody = await readStreamableHttpJsonRpcResponse(initResp, { serverName: name, operation: 'initialize', expectedId: initId, signal: discoveryAbort.signal });
    if (initBody.error) { const err = initBody.error as { message: string; code: number }; throw new Error(`Initialize failed: ${err.message} (code ${err.code})`); }

    const notificationResp = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...sessionHeaders(handle) }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: discoveryAbort.signal });
    if (!notificationResp.ok) throw new Error(`notifications/initialized HTTP POST returned status ${notificationResp.status}`);
    const notificationError = await readStreamableHttpNotificationError(notificationResp, name);
    if (notificationError) throw new Error(`notifications/initialized failed: ${notificationError}`);

    let cursor: string | undefined;
    let firstPage = true;
    do {
      const listId = ids.next();
      const listReq: McpJsonRpcRequest = { jsonrpc: '2.0', id: listId, method: 'tools/list' };
      if (!firstPage && cursor) listReq.params = { cursor };
      firstPage = false;
      const listResp = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...sessionHeaders(handle) }, body: JSON.stringify(listReq), signal: discoveryAbort.signal });
      if (!listResp.ok) throw new Error(`tools/list HTTP POST returned status ${listResp.status}`);
      const listBody = await readStreamableHttpJsonRpcResponse(listResp, { serverName: name, operation: 'tools/list', expectedId: listId, signal: discoveryAbort.signal });
      if (listBody.error) { const err = listBody.error as { message: string; code: number }; throw new Error(`tools/list failed: ${err.message} (code ${err.code})`); }
      const result = listBody.result as (Record<string, unknown> & { tools?: McpToolDefinition[]; nextCursor?: string }) | undefined;
      if (result && Array.isArray(result.tools)) { tools.push(...result.tools); cursor = result.nextCursor; } else cursor = undefined;
    } while (cursor);
    return tools;
  } catch (err) {
    if (discoveryAbort.signal.aborted && !serverSignal?.aborted) throw new Error(`Streamable HTTP discovery timed out after ${MCP_DISCOVERY_TIMEOUT_MS}ms`);
    throw err;
  } finally { clearTimeout(timeoutId); }
}

export async function invokeStreamableHttpTool(input: { serverName: string; toolName: string; args: Record<string, unknown>; config: McpServerConfig; handle?: McpServerHandle; timeoutMs: number; ids: MessageIdSource }): Promise<unknown> {
  const { serverName, toolName, args, config: cfg, handle, timeoutMs, ids } = input;
  if (!cfg.url) throw new TransportError(serverName, 'No URL configured for Streamable HTTP server');
  const signal = handle?.abortController?.signal;
  const invokeAbort = new AbortController();
  const timeoutId = setTimeout(() => invokeAbort.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => invokeAbort.abort(), { once: true });
  try {
    const requestId = ids.next();
    const request: McpJsonRpcRequest = { jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: toolName, arguments: args } };
    let resp: Response;
    try {
      resp = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...sessionHeaders(handle) }, body: JSON.stringify(request), signal: invokeAbort.signal });
    } catch (err) {
      if (invokeAbort.signal.aborted) throw new TimeoutError(serverName, toolName, timeoutMs);
      throw new TransportError(serverName, `HTTP POST failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!resp.ok) throw new TransportError(serverName, `tools/call HTTP POST returned status ${resp.status}`);
    let body: Record<string, unknown>;
    try { body = await readStreamableHttpJsonRpcResponse(resp, { serverName, operation: 'tools/call', expectedId: requestId, signal: invokeAbort.signal }); }
    catch (err) { if (invokeAbort.signal.aborted) throw new TimeoutError(serverName, toolName, timeoutMs); throw err; }
    return processToolsCallResponse(body, serverName, toolName);
  } finally { clearTimeout(timeoutId); }
}

export async function healthStreamableHttpServer(input: { serverName: string; config: McpServerConfig; handle?: McpServerHandle }): Promise<boolean> {
  const { config: cfg, handle } = input;
  if (!handle || handle.abortController?.signal.aborted || !cfg.url) return false;
  try {
    let resp = await fetch(cfg.url, { method: 'HEAD' });
    if (resp.status === 405 || resp.status === 501) resp = await fetch(cfg.url, { method: 'GET' });
    return resp.ok;
  } catch { return false; }
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

export async function probeStreamableHttpStartup(input: { serverName: string; config: McpServerConfig; signal: AbortSignal }): Promise<{ ok: true } | { ok: false; error: string; aborted: boolean }> {
  const { serverName, config: cfg, signal } = input;
  if (!cfg.url) return { ok: false, error: `streamable-http MCP server '${serverName}' has no 'url' configured.`, aborted: false };
  try {
    const resp = await fetch(cfg.url, { method: 'HEAD', signal });
    if (!resp.ok) return { ok: false, error: `Streamable HTTP health check returned status ${resp.status}`, aborted: false };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Streamable HTTP health check failed: ${err instanceof Error ? err.message : String(err)}`, aborted: signal.aborted };
  }
}
