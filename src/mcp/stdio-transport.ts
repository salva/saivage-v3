import * as readline from 'node:readline';
import { Transform, type Readable } from 'node:stream';
import { TransportError } from './errors.js';
import { PublicationOutcomeUnknownError } from '../contracts/index.js';
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

interface MessageIdSource {
  next(): number | string;
}

function boundedLines(stdout: Readable, serverName: string): readline.Interface {
  let bytes = 0;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      let start = 0;
      for (;;) {
        const end = chunk.indexOf(10, start);
        const size = (end === -1 ? chunk.length : end + 1) - start;
        bytes += size;
        if (bytes > MCP_WIRE_RESPONSE_LIMIT_BYTES) {
          done(new TransportError(serverName, 'stdio JSON frame exceeded 48 MiB'));
          return;
        }
        if (end === -1) break;
        bytes = 0;
        start = end + 1;
      }
      done(null, chunk);
    },
  });
  const rl = readline.createInterface({ input: bounded, crlfDelay: Infinity });
  stdout.pipe(bounded);
  rl.once('close', () => {
    stdout.unpipe(bounded);
    bounded.destroy();
  });
  return rl;
}

function safeWrite(stream: NodeJS.WritableStream, data: string, serverName: string): void {
  if (stream.writable) {
    try {
      stream.write(data);
    } catch (err) {
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

function readJsonRpcResponse(
  rl: readline.Interface,
  requestId: number | string,
  signal: AbortSignal,
  onResponse?: () => void,
  onRequest?: (message: Record<string, unknown>) => void,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    let lineHandler: ((line: string) => void) | null = null;
    let closeHandler: (() => void) | null = null;
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (lineHandler) rl.removeListener('line', lineHandler);
      if (closeHandler) rl.removeListener('close', closeHandler);
      rl.removeListener('error', onError);
    };
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', onAbort);
    rl.on('error', onError);
    lineHandler = (line: string) => {
      if (!line.trim()) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // Retained tolerance for non-JSON diagnostics on stdout.
      }
      try {
        if (typeof msg.method === 'string') onRequest?.(msg);
        if (msg.method === undefined && msg.id === requestId && typeof msg.jsonrpc === 'string') {
          cleanup();
          onResponse?.();
          resolve(msg);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    rl.on('line', lineHandler);
    closeHandler = () => {
      cleanup();
      resolve(null);
    };
    rl.on('close', closeHandler);
  });
}

async function closeReadline(rl: readline.Interface, wasClosed: () => boolean): Promise<void> {
  rl.close();
  if (wasClosed()) return;
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

export async function discoverStdioTools(input: {
  serverName: string;
  handle?: McpServerHandle;
  ids: MessageIdSource;
  signal: AbortSignal;
  rootUri?: string;
}): Promise<McpToolDefinition[]> {
  const { serverName: name, handle, ids, signal } = input;
  if (!handle?.process) throw new Error('Server process is not running');
  const proc = handle.process;
  if (!proc.stdin || !proc.stdout) throw new Error('Server process has no stdin/stdout');
  const tools: McpToolDefinition[] = [];
  const rl = boundedLines(proc.stdout, name);
  signal.throwIfAborted();
  const onRequest = (message: Record<string, unknown>) => {
    if (message.method === 'roots/list' && input.rootUri && message.id !== undefined)
      safeWrite(
        proc.stdin!,
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { roots: [{ uri: input.rootUri }] },
        }) + '\n',
        name,
      );
  };
  let rlClosed = false;
  rl.once('close', () => {
    rlClosed = true;
  });
  let publicationUnknown = false;
  try {
    const initId = ids.next();
    const initReq: McpJsonRpcRequest = {
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: input.rootUri ? { roots: { listChanged: false } } : {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
    };
    safeWrite(proc.stdin, JSON.stringify(initReq) + '\n', name);
    const initResponse = await readJsonRpcResponse(rl, initId, signal, undefined, onRequest);
    if (!initResponse) throw new TransportError(name, 'initialize stream closed before response');
    if (initResponse.error) {
      const code = (initResponse.error as { code?: unknown }).code;
      throw new TransportError(
        name,
        `initialize rejected${typeof code === 'number' && Number.isFinite(code) ? ` (code ${code})` : ''}`,
      );
    }
    safeWrite(
      proc.stdin,
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      name,
    );
    let cursor: string | undefined;
    let firstPage = true;
    do {
      const listId = ids.next();
      const listReq: McpJsonRpcRequest = { jsonrpc: '2.0', id: listId, method: 'tools/list' };
      if (!firstPage && cursor) listReq.params = { cursor };
      firstPage = false;
      safeWrite(proc.stdin, JSON.stringify(listReq) + '\n', name);
      const listResponse = await readJsonRpcResponse(rl, listId, signal, undefined, onRequest);
      if (!listResponse) throw new TransportError(name, 'tools/list stream closed before response');
      if (listResponse.error) {
        const code = (listResponse.error as { code?: unknown }).code;
        throw new TransportError(
          name,
          `tools/list rejected${typeof code === 'number' && Number.isFinite(code) ? ` (code ${code})` : ''}`,
        );
      }
      const result = listResponse.result as
        | (Record<string, unknown> & { tools?: McpToolDefinition[]; nextCursor?: string })
        | undefined;
      if (result && Array.isArray(result.tools)) {
        tools.push(...result.tools);
        cursor = result.nextCursor;
      } else cursor = undefined;
    } while (cursor);
    return tools;
  } catch (error) {
    publicationUnknown = error instanceof PublicationOutcomeUnknownError;
    throw error;
  } finally {
    if (!publicationUnknown) await closeReadline(rl, () => rlClosed);
  }
}

export async function invokeStdioTool(input: {
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  handle?: McpServerHandle;
  ids: MessageIdSource;
  signal: AbortSignal;
  onResponse: () => void;
}): Promise<unknown> {
  const { serverName, toolName, args, handle, ids, signal } = input;
  signal.throwIfAborted();
  const proc = handle?.process;
  if (!proc?.stdin || !proc.stdout)
    throw new TransportError(serverName, 'Process has no stdin/stdout pipes');
  const rl = boundedLines(proc.stdout, serverName);
  let rlClosed = false;
  rl.once('close', () => {
    rlClosed = true;
  });
  try {
    const requestId = ids.next();
    const request: McpJsonRpcRequest = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    };
    safeWrite(proc.stdin, JSON.stringify(request) + '\n', serverName);
    const response = await readJsonRpcResponse(
      rl,
      requestId,
      signal,
      input.onResponse,
      (message) => {
        if (message.method === 'roots/list' && handle?.rootUri && message.id !== undefined)
          safeWrite(
            proc.stdin!,
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { roots: [{ uri: handle.rootUri }] },
            }) + '\n',
            serverName,
          );
      },
    );
    if (!response) {
      throw new TransportError(serverName, 'stdio stream closed before response received');
    }
    return mapToolsCallResponse(response, serverName, toolName);
  } finally {
    await closeReadline(rl, () => rlClosed);
  }
}
