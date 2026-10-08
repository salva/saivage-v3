import { TimeoutError, TransportError } from './errors.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import type { StreamableHttpMcpServerConfig } from '../schemas/index.js';
import {
  CLIENT_NAME,
  CLIENT_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_WIRE_RESPONSE_LIMIT_BYTES,
  type McpJsonRpcRequest,
  type McpToolDefinition,
} from './protocol.js';
import type { McpServerHandle } from './server-registry.js';
import { mapToolsCallResponse } from './tools-call-response.js';

interface StreamableHttpReadContext {
  serverName: string;
  operation: string;
  expectedId: number | string;
  signal?: AbortSignal;
}
interface MessageIdSource {
  next(): number | string;
}

function getContentType(resp: Response): string {
  return resp.headers?.get?.('content-type')?.toLowerCase() ?? '';
}

function isJsonRpcResponseForId(
  value: unknown,
  expectedId: number | string,
): value is Record<string, unknown> {
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

async function readChunkWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal?.throwIfAborted();
  if (!signal) return reader.read();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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

async function readBoundedJson(
  resp: Response,
  context: Omit<StreamableHttpReadContext, 'expectedId'>,
): Promise<Record<string, unknown>> {
  if (!resp.body) throw new TransportError(context.serverName, 'MCP JSON response had no body');
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await readChunkWithAbort(reader, context.signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MCP_WIRE_RESPONSE_LIMIT_BYTES)
        throw new TransportError(context.serverName, 'MCP JSON response exceeded 48 MiB');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readStreamableHttpJsonRpcResponse(
  resp: Response,
  context: StreamableHttpReadContext,
): Promise<Record<string, unknown>> {
  const contentType = getContentType(resp);
  if (!contentType.includes('text/event-stream')) {
    try {
      const parsed = await readBoundedJson(resp, context);
      if (!isJsonRpcResponseForId(parsed, context.expectedId))
        throw new TransportError(
          context.serverName,
          'MCP JSON response has wrong request identity',
        );
      return parsed;
    } catch (err) {
      throwIfPublicationOutcomeUnknown(err);
      if (context.signal?.aborted) throw context.signal.reason;
      throw new TransportError(
        context.serverName,
        `Failed to parse JSON response for ${context.operation}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!resp.body)
    throw new TransportError(
      context.serverName,
      `Streamable HTTP ${context.operation} response had no body`,
    );
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let receivedBytes = 0;
  try {
    for (;;) {
      const { value, done } = await readChunkWithAbort(reader, context.signal);
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MCP_WIRE_RESPONSE_LIMIT_BYTES)
        throw new TransportError(context.serverName, 'MCP SSE response exceeded 48 MiB');
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = extractSseData(frame);
        if (!data) {
          boundary = buffer.search(/\r?\n\r?\n/);
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new TransportError(
            context.serverName,
            `Malformed Streamable HTTP SSE data for ${context.operation}`,
          );
        }
        if (isJsonRpcResponseForId(parsed, context.expectedId)) return parsed;
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  throw new TransportError(
    context.serverName,
    `Stream ended before JSON-RPC response for ${context.operation}`,
  );
}

async function readStreamableHttpNotificationError(
  resp: Response,
  serverName: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (resp.status === 202 || resp.status === 204) return undefined;
  const contentType = getContentType(resp);
  if (contentType.includes('application/json')) {
    try {
      const body = await readBoundedJson(resp, {
        serverName,
        operation: 'notifications/initialized',
        signal,
      });
      if (body.error) return sanitizeJsonRpcError(body.error);
    } catch {
      signal.throwIfAborted();
      return 'malformed JSON error body';
    }
  }
  if (contentType.includes('text/event-stream'))
    return `Streamable HTTP notification returned SSE body on MCP server '${serverName}'`;
  return undefined;
}

function sessionHeaders(handle?: McpServerHandle): Record<string, string> {
  return handle?.streamableHttpSessionId
    ? { 'Mcp-Session-Id': handle.streamableHttpSessionId }
    : {};
}

export async function discoverStreamableHttpTools(input: {
  serverName: string;
  config: StreamableHttpMcpServerConfig;
  handle?: McpServerHandle;
  ids: MessageIdSource;
  signal: AbortSignal;
}): Promise<McpToolDefinition[]> {
  const { serverName: name, config: cfg, handle, ids, signal } = input;
  signal.throwIfAborted();
  const discoveryAbort = new AbortController();
  const serverSignal = handle?.abortController?.signal;
  serverSignal?.throwIfAborted();
  const onServerAbort = () => discoveryAbort.abort(serverSignal!.reason);
  const onOperationAbort = () => discoveryAbort.abort(signal.reason);
  serverSignal?.addEventListener('abort', onServerAbort, { once: true });
  signal.addEventListener('abort', onOperationAbort, { once: true });
  const tools: McpToolDefinition[] = [];
  try {
    const initId = ids.next();
    const initReq: McpJsonRpcRequest = {
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
    };
    const initResp = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initReq),
      signal: discoveryAbort.signal,
    });
    if (!initResp.ok) throw new Error(`Initialize HTTP POST returned status ${initResp.status}`);
    const sessionId =
      initResp.headers?.get?.('Mcp-Session-Id') ?? initResp.headers?.get?.('mcp-session-id');
    if (sessionId && handle) handle.streamableHttpSessionId = sessionId;
    const initBody = await readStreamableHttpJsonRpcResponse(initResp, {
      serverName: name,
      operation: 'initialize',
      expectedId: initId,
      signal: discoveryAbort.signal,
    });
    if (initBody.error) {
      const err = initBody.error as { message: string; code: number };
      throw new Error(`Initialize failed: ${err.message} (code ${err.code})`);
    }

    const notificationResp = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...sessionHeaders(handle),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: discoveryAbort.signal,
    });
    if (!notificationResp.ok)
      throw new Error(
        `notifications/initialized HTTP POST returned status ${notificationResp.status}`,
      );
    const notificationError = await readStreamableHttpNotificationError(
      notificationResp,
      name,
      discoveryAbort.signal,
    );
    if (notificationError)
      throw new Error(`notifications/initialized failed: ${notificationError}`);

    let cursor: string | undefined;
    let firstPage = true;
    do {
      const listId = ids.next();
      const listReq: McpJsonRpcRequest = { jsonrpc: '2.0', id: listId, method: 'tools/list' };
      if (!firstPage && cursor) listReq.params = { cursor };
      firstPage = false;
      const listResp = await fetch(cfg.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...sessionHeaders(handle),
        },
        body: JSON.stringify(listReq),
        signal: discoveryAbort.signal,
      });
      if (!listResp.ok) throw new Error(`tools/list HTTP POST returned status ${listResp.status}`);
      const listBody = await readStreamableHttpJsonRpcResponse(listResp, {
        serverName: name,
        operation: 'tools/list',
        expectedId: listId,
        signal: discoveryAbort.signal,
      });
      if (listBody.error) {
        const err = listBody.error as { message: string; code: number };
        throw new Error(`tools/list failed: ${err.message} (code ${err.code})`);
      }
      const result = listBody.result as
        | (Record<string, unknown> & { tools?: McpToolDefinition[]; nextCursor?: string })
        | undefined;
      if (result && Array.isArray(result.tools)) {
        tools.push(...result.tools);
        cursor = result.nextCursor;
      } else cursor = undefined;
    } while (cursor);
    return tools;
  } catch (err) {
    if (discoveryAbort.signal.aborted) throw discoveryAbort.signal.reason;
    throw err;
  } finally {
    serverSignal?.removeEventListener('abort', onServerAbort);
    signal.removeEventListener('abort', onOperationAbort);
  }
}

export async function invokeStreamableHttpTool(input: {
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  config: StreamableHttpMcpServerConfig;
  handle?: McpServerHandle;
  timeoutMs: number;
  ids: MessageIdSource;
  signal: AbortSignal;
}): Promise<unknown> {
  const {
    serverName,
    toolName,
    args,
    config: cfg,
    handle,
    timeoutMs,
    ids,
    signal: operationSignal,
  } = input;
  const signal = handle?.abortController?.signal;
  const invokeAbort = new AbortController();
  operationSignal.throwIfAborted();
  signal?.throwIfAborted();
  const timeoutId = setTimeout(
    () => invokeAbort.abort(new TimeoutError(serverName, toolName, timeoutMs)),
    timeoutMs,
  );
  const onServerAbort = () => invokeAbort.abort(signal!.reason);
  const onOperationAbort = () => invokeAbort.abort(operationSignal.reason);
  signal?.addEventListener('abort', onServerAbort, { once: true });
  operationSignal.addEventListener('abort', onOperationAbort, { once: true });
  try {
    const requestId = ids.next();
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
          ...sessionHeaders(handle),
        },
        body: JSON.stringify(request),
        signal: invokeAbort.signal,
      });
    } catch (err) {
      throwIfPublicationOutcomeUnknown(err);
      if (invokeAbort.signal.aborted) throw invokeAbort.signal.reason;
      throw new TransportError(
        serverName,
        `HTTP POST failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!resp.ok)
      throw new TransportError(serverName, `tools/call HTTP POST returned status ${resp.status}`);
    let body: Record<string, unknown>;
    try {
      body = await readStreamableHttpJsonRpcResponse(resp, {
        serverName,
        operation: 'tools/call',
        expectedId: requestId,
        signal: invokeAbort.signal,
      });
    } catch (err) {
      throwIfPublicationOutcomeUnknown(err);
      if (invokeAbort.signal.aborted) throw invokeAbort.signal.reason;
      throw err;
    }
    return mapToolsCallResponse(body, serverName, toolName);
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onServerAbort);
    operationSignal.removeEventListener('abort', onOperationAbort);
  }
}

export async function healthStreamableHttpServer(input: {
  serverName: string;
  config: StreamableHttpMcpServerConfig;
  handle?: McpServerHandle;
  signal: AbortSignal;
}): Promise<boolean> {
  const { config: cfg, handle, signal } = input;
  if (!handle || handle.abortController?.signal.aborted) return false;
  try {
    let resp = await fetch(cfg.url, { method: 'HEAD', signal });
    if (resp.status === 405 || resp.status === 501)
      resp = await fetch(cfg.url, { method: 'GET', signal });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function probeStreamableHttpStartup(input: {
  config: StreamableHttpMcpServerConfig;
  signal: AbortSignal;
}): Promise<{ ok: true } | { ok: false; error: string; aborted: boolean }> {
  const { config: cfg, signal } = input;
  try {
    const resp = await fetch(cfg.url, { method: 'HEAD', signal });
    if (!resp.ok)
      return {
        ok: false,
        error: `Streamable HTTP health check returned status ${resp.status}`,
        aborted: false,
      };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Streamable HTTP health check failed: ${err instanceof Error ? err.message : String(err)}`,
      aborted: signal.aborted,
    };
  }
}
