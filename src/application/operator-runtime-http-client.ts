import {
  operatorApiContracts,
  parseOperatorResponse,
  type OperatorApiSuccess,
  type WorkGcRequest,
} from '../contracts/index.js';
import type { RuntimeControlEndpoint } from '../runtime/runtime-api.js';
import { Agent, request as undiciRequest } from 'undici';

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
  ): Promise<OperatorApiSuccess<'runtime.gcWork'>> {
    const contract = operatorApiContracts['runtime.gcWork'];
    const headers = this.headers(endpoint, body);
    // This transport belongs to this call only. Other operator requests keep their
    // ordinary fetch policy; GC has no elapsed response/maintenance deadline.
    const dispatcher = new Agent({ connect: { timeout: 10_000 } });
    try {
      let response;
      let text: string;
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
        text = await response.body.text();
      } catch (cause) {
        throw new Error('runtime.gcWork transport or response body read failed.', { cause });
      }
      return this.interpret('runtime.gcWork', response.statusCode, text);
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
