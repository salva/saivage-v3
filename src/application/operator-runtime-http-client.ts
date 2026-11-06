import {
  operatorApiContracts,
  parseOperatorResponse,
  type OperatorApiSuccess,
  type WorkGcRequest,
  WorkGcFrameSchema,
  WORK_GC_FRAME_MAX_BYTES,
  type WorkGcResponse,
  type WorkGcProgressObserver,
} from '../contracts/index.js';
import type { RuntimeControlEndpoint } from '../runtime/runtime-api.js';
import { Agent, request as undiciRequest } from 'undici';

/** Byte-bounded line framing; terminal is authoritative only after a clean EOF. */
export async function readWorkGcFrames(
  source: AsyncIterable<Uint8Array>,
  observer?: WorkGcProgressObserver,
): Promise<WorkGcResponse> {
  let pending = Buffer.alloc(0);
  let result: WorkGcResponse | undefined;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const bytes of source) {
    const chunk = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const piece = chunk.subarray(start, end === -1 ? chunk.length : end);
      if (pending.length + piece.length + 1 > WORK_GC_FRAME_MAX_BYTES)
        throw new Error('Work GC frame exceeds protocol bound.');
      pending = Buffer.concat([pending, piece]);
      if (end === -1) break;
      if (result) throw new Error('Work GC frame after terminal result.');
      const frame = WorkGcFrameSchema.parse(JSON.parse(decoder.decode(pending)));
      pending = Buffer.alloc(0);
      if (frame.type === 'result') result = frame.response;
      else observer?.(frame.progress);
      start = end + 1;
    }
  }
  if (pending.length || !result)
    throw new Error('Work GC stream ended without a complete terminal result.');
  return result;
}

type RuntimeOperation =
  | 'runtime.gcWork'
  | 'runtime.status'
  | 'runtime.pause'
  | 'runtime.resume'
  | 'stop_project'
  | 'restart_server';

export class OperatorRuntimeHttpClient {
  constructor(private readonly request: typeof fetch = fetch) {}

  async gcWork(
    endpoint: RuntimeControlEndpoint,
    body: WorkGcRequest,
    signal?: AbortSignal,
    progress?: WorkGcProgressObserver,
  ): Promise<OperatorApiSuccess<'runtime.gcWork'>> {
    const contract = operatorApiContracts['runtime.gcWork'];
    const headers = this.headers(endpoint, body);
    headers.accept = 'application/x-ndjson';
    // This transport belongs to this call only. Other operator requests keep their
    // ordinary fetch policy; GC has no elapsed response/maintenance deadline.
    const dispatcher = new Agent({ connect: { timeout: 10_000 } });
    try {
      let response;
      try {
        response = await undiciRequest(`${endpoint.origin}${contract.path}`, {
          dispatcher,
          method: contract.method,
          headers,
          body: JSON.stringify(body),
          signal,
          headersTimeout: 0,
          bodyTimeout: 0,
        });
      } catch (cause) {
        throw new Error('runtime.gcWork transport or response body read failed.', { cause });
      }
      if (response.statusCode !== 200) {
        let text = '';
        for await (const chunk of response.body) {
          if (Buffer.byteLength(text) + chunk.length > WORK_GC_FRAME_MAX_BYTES)
            throw new Error('Work GC error response exceeds protocol bound.');
          text += chunk.toString('utf8');
        }
        return this.interpret('runtime.gcWork', response.statusCode, text);
      }
      const contentType = response.headers['content-type'];
      if (typeof contentType !== 'string' || contentType.split(';')[0] !== 'application/x-ndjson')
        throw new Error('Work GC returned an unsupported content type.');
      return await readWorkGcFrames(response.body, progress);
    } finally {
      await dispatcher.destroy();
    }
  }

  getRuntimeStatus(
    endpoint: RuntimeControlEndpoint,
  ): Promise<OperatorApiSuccess<'runtime.status'>> {
    return this.call('runtime.status', endpoint);
  }
  pauseRuntime(endpoint: RuntimeControlEndpoint): Promise<OperatorApiSuccess<'runtime.pause'>> {
    return this.call('runtime.pause', endpoint);
  }
  resumeRuntime(endpoint: RuntimeControlEndpoint): Promise<OperatorApiSuccess<'runtime.resume'>> {
    return this.call('runtime.resume', endpoint);
  }
  stopProject(endpoint: RuntimeControlEndpoint): Promise<OperatorApiSuccess<'stop_project'>> {
    return this.call('stop_project', endpoint);
  }
  restartServer(endpoint: RuntimeControlEndpoint): Promise<OperatorApiSuccess<'restart_server'>> {
    return this.call('restart_server', endpoint, { confirmation: 'RESTART SERVER' });
  }

  private async call<K extends RuntimeOperation>(
    operationId: K,
    endpoint: RuntimeControlEndpoint,
    body?: unknown,
  ): Promise<OperatorApiSuccess<K>> {
    const contract = operatorApiContracts[operationId];
    const headers = this.headers(endpoint, body);
    const response = await this.request(`${endpoint.origin}${contract.path}`, {
      method: contract.method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return this.interpret(operationId, response.status, text);
  }

  private headers(endpoint: RuntimeControlEndpoint, body?: unknown): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (endpoint.auth === 'bearer') {
      const token = process.env.SAIVAGE_API_TOKEN;
      if (!token || token.trim() === '')
        throw new Error(
          'Live service requires bearer authentication; set a non-blank SAIVAGE_API_TOKEN.',
        );
      headers.authorization = `Bearer ${token}`;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    return headers;
  }

  private interpret<K extends RuntimeOperation>(
    operationId: K,
    status: number,
    text: string,
  ): OperatorApiSuccess<K> {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`${operationId} returned a malformed JSON response.`);
    }
    if (status < 200 || status >= 300) {
      const message =
        typeof payload === 'object' &&
        payload !== null &&
        'message' in payload &&
        typeof payload.message === 'string'
          ? payload.message
          : `${operationId} failed with HTTP ${status}.`;
      throw new Error(message);
    }
    try {
      return parseOperatorResponse(operationId, status, payload) as OperatorApiSuccess<K>;
    } catch {
      throw new Error(`${operationId} response did not match the operator API contract.`);
    }
  }
}
