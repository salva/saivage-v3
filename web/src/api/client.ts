/**
 * Saivage v3 API Client
 *
 * Typed fetch wrappers for all REST endpoints documented in docs/design/server-api.md.
 * Auth token comes from localStorage ('saivage_api_token'), falling back to
 * VITE_SAIVAGE_API_TOKEN from import.meta.env. URL query tokens are ignored.
 */

import type {
  CardListResponse,
  CardDetailResponse,
  RuntimeStateResponse,
  AgentConversationResponse,
  AgentSessionsResponse,
  ChatSessionsResponse,
  ChatEntriesResponse,
  ChatResponse,
  ChatWorkspaceContext,
  FilesListResponse,
  FileContent,
  DebugStateResponse,
  DebugErrorsResponse,
  DebugTimelineResponse,
  DoctorResponse,
  SupervisionResponse,
  McpToolsResponse,
  ProcessListResponse,
  CardHistoryListResponse,
  CardHistoryEntryResponse,
  CardDiffResponse,
  ControlActionsListResponse,
} from './types';
import { getAuthToken } from './auth';
import {
  operatorApiContracts,
  parseOperatorResponse,
  type OperatorApiOperationId,
  type OperatorApiParams,
  type OperatorApiBody,
  type OperatorApiSuccess,
} from './contracts';
import type { ProviderExchangePayload } from './contracts';
import { dispatchApiAuthRequired } from '../utils/auth-events';

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;

  constructor(status: number, message: string, body: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

async function request<T>(
  method: string,
  path: string,
  query?: Record<string, string>,
  body?: unknown,
  operationId?: OperatorApiOperationId,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, value);
      }
    }
  }

  const init: RequestInit = {
    method,
    headers: authHeaders(),
    signal,
  };

  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), init);

  if (response.status === 204) {
    return {} as T;
  }

  let responseBody: Record<string, unknown>;
  try {
    responseBody = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new ApiError(response.status, `Invalid JSON response`, {});
  }

  if (!response.ok) {
    if (response.status === 401) {
      dispatchApiAuthRequired({ status: response.status, path });
    }
    throw new ApiError(
      response.status,
      (responseBody['message'] as string) || (responseBody['error'] as string) || response.statusText,
      responseBody,
    );
  }

  if (operationId) {
    return parseOperatorResponse(operationId, responseBody) as T;
  }

  return responseBody as T;
}

type OperatorRequestOptions<K extends OperatorApiOperationId> = {
  params?: OperatorApiParams<K>;
  query?: Record<string, string | undefined>;
  body?: OperatorApiBody<K>;
  signal?: AbortSignal;
};

function buildOperatorPath<K extends OperatorApiOperationId>(operationId: K, params?: OperatorApiParams<K>): string {
  const contract = operatorApiContracts[operationId];
  const values = (params ?? {}) as Record<string, unknown>;
  return contract.path.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
    const value = values[key];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`Missing path param '${key}' for operator API operation '${operationId}'.`);
    }
    return encodeURIComponent(String(value));
  });
}

function normalizeQuery(query?: Record<string, string | undefined>): Record<string, string> | undefined {
  if (!query) return undefined;
  const entries = Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function operatorRequest<K extends OperatorApiOperationId>(
  operationId: K,
  options: OperatorRequestOptions<K> = {},
): Promise<OperatorApiSuccess<K>> {
  const contract = operatorApiContracts[operationId];
  return request<OperatorApiSuccess<K>>(
    contract.method,
    buildOperatorPath(operationId, options.params),
    normalizeQuery(options.query),
    options.body,
    operationId,
    options.signal,
  );
}


export function issueWebSocketTicket(): Promise<OperatorApiSuccess<'auth.wsTicket'>> {
  return operatorRequest('auth.wsTicket');
}

export function listCards(signal?: AbortSignal): Promise<CardListResponse> {
  return operatorRequest('cards.list', { signal });
}

export function getCard(id: string, signal?: AbortSignal): Promise<CardDetailResponse> {
  return operatorRequest('cards.get', { params: { id }, signal }) as Promise<CardDetailResponse>;
}

export function listCardHistory(id: string): Promise<CardHistoryListResponse> {
  return operatorRequest('cards.history.list', { params: { id } });
}

export function getCardHistoryEntry(id: string, seq: number): Promise<CardHistoryEntryResponse> {
  return operatorRequest('cards.history.get', { params: { id, seq: String(seq) } });
}

export function getCardDiff(id: string, from: number, to: number): Promise<CardDiffResponse> {
  return operatorRequest('cards.diff', { params: { id }, query: {
    from: String(from),
    to: String(to),
  } }) as Promise<CardDiffResponse>;
}




export function getRuntimeState(signal?: AbortSignal): Promise<RuntimeStateResponse> {
  return operatorRequest('runtime.getState', { signal });
}







export function listAgentSessions(signal?: AbortSignal): Promise<AgentSessionsResponse> {
  return operatorRequest('agents.list', { signal }) as Promise<AgentSessionsResponse>;
}

export function getAgentConversation(sessionId: string, signal?: AbortSignal): Promise<AgentConversationResponse> {
  return operatorRequest('agents.conversation', { params: { id: sessionId }, signal }) as Promise<AgentConversationResponse>;
}

export function getAgentLlmExchange(sessionId: string): Promise<{ exchange: ProviderExchangePayload }> {
  return operatorRequest('agents.llmExchange', { params: { id: sessionId } }) as Promise<{ exchange: ProviderExchangePayload }>;
}

export function listControlActions(query?: { card_id?: string; since?: string }): Promise<ControlActionsListResponse> {
  return operatorRequest('controlActions.list', { query });
}

export function listChatSessions(signal?: AbortSignal): Promise<ChatSessionsResponse> {
  return operatorRequest('chats.list', { signal });
}

export function getChatEntries(sessionId: string, signal?: AbortSignal): Promise<ChatEntriesResponse> {
  return operatorRequest('chats.get', { params: { sessionId }, signal }) as Promise<ChatEntriesResponse>;
}

export function sendChatMessage(sessionId: string, content: string, workspaceContext?: ChatWorkspaceContext): Promise<ChatResponse> {
  const body = workspaceContext === undefined ? { content } : { content, workspaceContext };
  return operatorRequest('chats.send', { params: { sessionId }, body });
}

export function listFiles(path?: string): Promise<FilesListResponse> {
  return operatorRequest('files.list', { query: path ? { path } : undefined });
}

export function getFileContent(path: string): Promise<FileContent> {
  return operatorRequest('files.content', { query: { path } }) as Promise<FileContent>;
}

export function listProcesses(): Promise<ProcessListResponse> {
  return operatorRequest('processes.list');
}

export function getDebugState(): Promise<DebugStateResponse> {
  return operatorRequest('debug.state') as Promise<DebugStateResponse>;
}

export function getDebugErrors(): Promise<DebugErrorsResponse> {
  return operatorRequest('debug.errors') as Promise<DebugErrorsResponse>;
}

export function getDebugTimeline(): Promise<DebugTimelineResponse> {
  return operatorRequest('debug.timeline') as Promise<DebugTimelineResponse>;
}

export function getDoctor(): Promise<DoctorResponse> {
  return request<DoctorResponse>('GET', '/api/debug/doctor');
}

export function getDebugSupervision(): Promise<SupervisionResponse> {
  return request<SupervisionResponse>('GET', '/api/debug/supervision');
}

export function getMcpTools(): Promise<McpToolsResponse> {
  return operatorRequest('mcp.tools');
}

export { ApiError };
