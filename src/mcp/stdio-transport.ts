import * as readline from 'node:readline';
import { Transform, type Readable } from 'node:stream';
import { TransportError } from './errors.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import {
  CLIENT_NAME,
  CLIENT_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_WIRE_RESPONSE_LIMIT_BYTES,
  type McpJsonRpcRequest,
  type McpToolDefinition,
} from './protocol.js';
import { mapToolsCallResponse } from './tools-call-response.js';

interface MessageIdSource {
  next(): number | string;
}

interface PendingResponse {
  id: number | string;
  stage: string;
  signal: AbortSignal;
  onAbort: () => void;
  onResponse?: () => void;
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: unknown) => void;
}

/** One receiver for one launched stdio connection; the runtime serializes exchanges. */
export class StdioMcpConnection {
  private readonly bounded: Transform;
  private readonly lines: readline.Interface;
  private pending?: PendingResponse;
  private closed = false;
  private terminalReason?: unknown;

  constructor(
    private readonly input: {
      serverName: string;
      stdin: NodeJS.WritableStream;
      stdout: Readable;
      ids: MessageIdSource;
      rootUri?: string;
      onFailure: (error: unknown) => void;
    },
  ) {
    let bytes = 0;
    this.bounded = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        let start = 0;
        for (;;) {
          const end = chunk.indexOf(10, start);
          bytes += (end === -1 ? chunk.length : end + 1) - start;
          if (bytes > MCP_WIRE_RESPONSE_LIMIT_BYTES) {
            done(new TransportError(input.serverName, 'stdio JSON frame exceeded 48 MiB'));
            return;
          }
          if (end === -1) break;
          bytes = 0;
          start = end + 1;
        }
        done(null, chunk);
      },
    });
    this.lines = readline.createInterface({ input: this.bounded, crlfDelay: Infinity });
    this.lines.on('line', this.onLine);
    this.lines.on('error', this.onError);
    this.lines.on('close', this.onClose);
    this.bounded.on('error', this.onError);
    input.stdin.on('error', this.onError);
    input.stdout.on('error', this.onError);
    input.stdout.pipe(this.bounded);
    input.stdout.on('end', this.onClose);
    input.stdout.on('close', this.onClose);
  }

  private write(message: Record<string, unknown> | McpJsonRpcRequest): void {
    if (!this.input.stdin.writable)
      throw new TransportError(
        this.input.serverName,
        'Process stdin is not writable (process exited before discovery/invocation)',
      );
    try {
      this.input.stdin.write(JSON.stringify(message) + '\n');
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      throw new TransportError(
        this.input.serverName,
        'stdio write failed (process may have exited early)',
      );
    }
  }

  private readonly onLine = (line: string): void => {
    if (this.closed || !line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Retained tolerance for stdout diagnostics.
    }
    try {
      if (typeof message.method === 'string') {
        if (
          message.method === 'roots/list' &&
          this.input.rootUri &&
          (typeof message.id === 'string' || typeof message.id === 'number')
        )
          this.write({
            jsonrpc: '2.0',
            id: message.id,
            result: { roots: [{ uri: this.input.rootUri }] },
          });
        return;
      }
      const pending = this.pending;
      if (
        pending &&
        message.method === undefined &&
        message.id === pending.id &&
        typeof message.jsonrpc === 'string'
      ) {
        // The completion hook is synchronous, before a later line can fence the runtime.
        pending.onResponse?.();
        this.clearPending();
        pending.resolve(message);
      }
    } catch (error) {
      this.fail(error);
    }
  };

  private readonly onError = (error: unknown): void => this.fail(error);
  private readonly onClose = (): void => {
    if (this.closed) return;
    this.fail(
      new TransportError(
        this.input.serverName,
        this.pending
          ? `${this.pending.stage} stream closed before response`
          : 'stdio stream closed',
      ),
    );
  };

  private clearPending(): PendingResponse | undefined {
    const pending = this.pending;
    this.pending = undefined;
    pending?.signal.removeEventListener('abort', pending.onAbort);
    return pending;
  }

  private fail(error: unknown): void {
    throwIfPublicationOutcomeUnknown(error);
    if (this.closed) return;
    // Preserve the wire/reader failure before runtime closure aborts internal controllers.
    this.dispose(error);
    this.input.onFailure(error);
  }

  dispose(reason: unknown): void {
    throwIfPublicationOutcomeUnknown(reason);
    if (this.closed) return;
    if (this.pending?.signal.aborted) reason = this.pending.signal.reason;
    throwIfPublicationOutcomeUnknown(reason);
    this.closed = true;
    this.terminalReason = reason;
    const pending = this.clearPending();
    this.input.stdout.unpipe(this.bounded);
    this.input.stdout.removeListener('error', this.onError);
    this.input.stdout.removeListener('end', this.onClose);
    this.input.stdout.removeListener('close', this.onClose);
    this.input.stdin.removeListener('error', this.onError);
    this.lines.removeListener('line', this.onLine);
    this.lines.removeListener('close', this.onClose);
    this.lines.close();
    this.lines.removeListener('error', this.onError);
    this.bounded.removeListener('error', this.onError);
    this.bounded.destroy();
    pending?.reject(reason);
  }

  private exchange(
    request: McpJsonRpcRequest,
    signal: AbortSignal,
    onResponse?: () => void,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (this.closed) return Promise.reject(this.terminalReason);
    if (this.pending) throw new Error('Concurrent stdio MCP exchange');
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        throwIfPublicationOutcomeUnknown(signal.reason);
        this.clearPending();
        reject(signal.reason);
      };
      this.pending = {
        id: request.id!,
        stage: request.method,
        signal,
        onAbort,
        onResponse,
        resolve,
        reject,
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        this.write(request);
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        this.clearPending();
        reject(error);
      }
    });
  }

  async discover(signal: AbortSignal): Promise<McpToolDefinition[]> {
    signal.throwIfAborted();
    const response = await this.exchange(
      {
        jsonrpc: '2.0',
        id: this.input.ids.next(),
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: this.input.rootUri ? { roots: { listChanged: false } } : {},
          clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
        },
      },
      signal,
    );
    this.checkDiscovery(response, 'initialize');
    signal.throwIfAborted();
    if (this.closed) throw this.terminalReason;
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const request: McpJsonRpcRequest = {
        jsonrpc: '2.0',
        id: this.input.ids.next(),
        method: 'tools/list',
      };
      if (cursor) request.params = { cursor };
      const page = await this.exchange(request, signal);
      this.checkDiscovery(page, 'tools/list');
      const result = page.result as
        | { tools?: McpToolDefinition[]; nextCursor?: string }
        | undefined;
      if (result && Array.isArray(result.tools)) {
        tools.push(...result.tools);
        cursor = result.nextCursor;
      } else cursor = undefined;
    } while (cursor);
    return tools;
  }

  private checkDiscovery(response: Record<string, unknown>, stage: string): void {
    if (!response.error) return;
    const code = (response.error as { code?: unknown }).code;
    throw new TransportError(
      this.input.serverName,
      `${stage} rejected${typeof code === 'number' && Number.isFinite(code) ? ` (code ${code})` : ''}`,
    );
  }

  async invoke(input: {
    toolName: string;
    args: Record<string, unknown>;
    signal: AbortSignal;
    onResponse: () => void;
  }): Promise<unknown> {
    input.signal.throwIfAborted();
    const response = await this.exchange(
      {
        jsonrpc: '2.0',
        id: this.input.ids.next(),
        method: 'tools/call',
        params: { name: input.toolName, arguments: input.args },
      },
      input.signal,
      input.onResponse,
    );
    return mapToolsCallResponse(response, this.input.serverName, input.toolName);
  }
}
