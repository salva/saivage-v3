import { operatorApiContracts, parseOperatorResponse, type OperatorApiOperationId, type OperatorApiSuccess } from '../contracts/operator-api.js';
import type { RuntimeControlEndpoint } from '../runtime/lock.js';

type RuntimeOperation = 'runtime.status' | 'runtime.pause' | 'runtime.resume' | 'stop_project' | 'restart_server';

export class OperatorRuntimeHttpClient {
  constructor(private readonly request: typeof fetch = fetch) {}

  getRuntimeStatus(endpoint: RuntimeControlEndpoint): Promise<OperatorApiSuccess<'runtime.status'>> { return this.call('runtime.status', endpoint); }
  pauseRuntime(endpoint: RuntimeControlEndpoint): Promise<OperatorApiSuccess<'runtime.pause'>> { return this.call('runtime.pause', endpoint, {}); }
  resumeRuntime(endpoint: RuntimeControlEndpoint): Promise<OperatorApiSuccess<'runtime.resume'>> { return this.call('runtime.resume', endpoint, {}); }
  stopProject(endpoint: RuntimeControlEndpoint): Promise<OperatorApiSuccess<'stop_project'>> { return this.call('stop_project', endpoint, {}); }
  restartServer(endpoint: RuntimeControlEndpoint): Promise<OperatorApiSuccess<'restart_server'>> { return this.call('restart_server', endpoint, { confirmation: 'RESTART SERVER' }); }

  private async call<K extends RuntimeOperation>(operationId: K, endpoint: RuntimeControlEndpoint, body?: unknown): Promise<OperatorApiSuccess<K>> {
    const contract = operatorApiContracts[operationId];
    const headers: Record<string, string> = { accept: 'application/json' };
    if (endpoint.auth === 'bearer') {
      const token = process.env.SAIVAGE_API_TOKEN;
      if (!token) throw new Error('Live service requires bearer authentication; set SAIVAGE_API_TOKEN.');
      headers.authorization = `Bearer ${token}`;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.request(`${endpoint.origin}${contract.path}`, {
      method: contract.method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error(`${operationId} returned a malformed JSON response.`); }
    if (!response.ok) {
      const message = typeof payload === 'object' && payload !== null && 'message' in payload && typeof payload.message === 'string'
        ? payload.message
        : `${operationId} failed with HTTP ${response.status}.`;
      throw new Error(message);
    }
    try { return parseOperatorResponse(operationId as OperatorApiOperationId, payload) as OperatorApiSuccess<K>; }
    catch { throw new Error(`${operationId} response did not match the operator API contract.`); }
  }
}
