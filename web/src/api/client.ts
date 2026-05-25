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
  ConfigResponse,
  ProvidersResponse,
  AgentConversationResponse,
  AgentSessionsResponse,
  NotesListResponse,
  ChatSessionsResponse,
  ChatMessagesResponse,
  ChatResponse,
  FilesListResponse,
  FileContent,
  DebugStateResponse,
  DebugErrorsResponse,
  DebugTimelineResponse,
  DoctorResponse,
  SupervisionResponse,
  McpToolsResponse,
  ProcessListResponse,
  ProcessDetailResponse,
  CardHistoryListResponse,
  CardHistoryEntryResponse,
  CardDiffResponse,
  NotificationsListResponse,
  ControlActionsListResponse,
} from './types';
import { getAuthToken } from './auth';
import { parseOperatorResponse, type OperatorApiOperationId, type OperatorApiSuccess } from './contracts';
import type { LlmExchange } from './contracts';
import type { RuntimeState } from './types';
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

function operatorRequest<K extends OperatorApiOperationId>(
  operationId: K,
  method: string,
  path: string,
  query?: Record<string, string>,
  body?: unknown,
): Promise<OperatorApiSuccess<K>> {
  return request<OperatorApiSuccess<K>>(method, path, query, body, operationId);
}


export interface WebSocketTicketResponse {
  ticket: string;
  expiresAt: string;
}

export function issueWebSocketTicket(): Promise<WebSocketTicketResponse> {
  return request<WebSocketTicketResponse>('POST', '/api/auth/ws-ticket');
}

export async function getHealth(): Promise<{ status: string; version: string; project: string; runtime: string }> {
  const headers = authHeaders();
  const response = await fetch('/health', { headers });
  if (!response.ok) {
    throw new ApiError(response.status, 'Health check failed', {});
  }
  return response.json() as Promise<{ status: string; version: string; project: string; runtime: string }>;
}

export function listCards(query?: {
  status?: string;
  type?: string;
  parent?: string;
  tag?: string;
}): Promise<CardListResponse> {
  return operatorRequest('cards.list', 'GET', '/api/cards', query as Record<string, string>) as unknown as Promise<CardListResponse>;
}

export function getCard(id: string): Promise<CardDetailResponse> {
  return operatorRequest('cards.get', 'GET', `/api/cards/${encodeURIComponent(id)}`) as unknown as Promise<CardDetailResponse>;
}

export function listCardHistory(id: string): Promise<CardHistoryListResponse> {
  return request<CardHistoryListResponse>('GET', `/api/cards/${encodeURIComponent(id)}/history`);
}

export function getCardHistoryEntry(id: string, seq: number): Promise<CardHistoryEntryResponse> {
  return request<CardHistoryEntryResponse>('GET', `/api/cards/${encodeURIComponent(id)}/history/${seq}`);
}

export function getCardDiff(id: string, from: number, to: number): Promise<CardDiffResponse> {
  return request<CardDiffResponse>('GET', `/api/cards/${encodeURIComponent(id)}/diff`, {
    from: String(from),
    to: String(to),
  });
}




export function getRuntimeState(): Promise<RuntimeStateResponse> {
  return operatorRequest('runtime.getState', 'GET', '/api/state') as unknown as Promise<RuntimeStateResponse>;
}







export function listAgentSessions(): Promise<AgentSessionsResponse> {
  return request<AgentSessionsResponse>('GET', '/api/agents');
}

export function getAgentConversation(sessionId: string): Promise<AgentConversationResponse> {
  return request<AgentConversationResponse>('GET', `/api/agents/${encodeURIComponent(sessionId)}/conversation`);
}

export function getAgentLlmExchange(sessionId: string): Promise<{ exchange: LlmExchange }> {
  return request<{ exchange: LlmExchange }>('GET', `/api/agents/${encodeURIComponent(sessionId)}/llm-exchange`);
}

export function getConfig(): Promise<ConfigResponse> {
  return request<ConfigResponse>('GET', '/api/config');
}

export function getProviders(): Promise<ProvidersResponse> {
  return request<ProvidersResponse>('GET', '/api/providers');
}

export function listNotes(): Promise<NotesListResponse> {
  return request<NotesListResponse>('GET', '/api/notes');
}




export function listNotifications(): Promise<NotificationsListResponse> {
  return request<NotificationsListResponse>('GET', '/api/notifications');
}


export function listControlActions(query?: { card_id?: string; since?: string }): Promise<ControlActionsListResponse> {
  return request<ControlActionsListResponse>('GET', '/api/control-actions', query as Record<string, string> | undefined);
}

export function listChatSessions(): Promise<ChatSessionsResponse> {
  return request<ChatSessionsResponse>('GET', '/api/chats');
}

export function getChatMessages(sessionId: string): Promise<ChatMessagesResponse> {
  return request<ChatMessagesResponse>('GET', `/api/chats/${encodeURIComponent(sessionId)}`);
}

export function sendChatMessage(sessionId: string, content: string): Promise<ChatResponse> {
  return request<ChatResponse>('POST', `/api/chats/${encodeURIComponent(sessionId)}`, undefined, { content });
}

export function listFiles(path?: string): Promise<FilesListResponse> {
  return request<FilesListResponse>('GET', '/api/files', path ? { path } : undefined);
}

export function getFileContent(path: string): Promise<FileContent> {
  return request<FileContent>('GET', '/api/files/content', { path });
}

export function listProcesses(): Promise<ProcessListResponse> {
  return request<ProcessListResponse>('GET', '/api/processes');
}

export function getProcess(processId: string): Promise<ProcessDetailResponse> {
  return request<ProcessDetailResponse>('GET', `/api/processes/${encodeURIComponent(processId)}`);
}


export function getDebugState(): Promise<DebugStateResponse> {
  return request<DebugStateResponse>('GET', '/api/debug/state');
}

export function getDebugErrors(): Promise<DebugErrorsResponse> {
  return request<DebugErrorsResponse>('GET', '/api/debug/errors');
}

export function getDebugTimeline(): Promise<DebugTimelineResponse> {
  return request<DebugTimelineResponse>('GET', '/api/debug/timeline');
}

export function getDoctor(): Promise<DoctorResponse> {
  return request<DoctorResponse>('GET', '/api/debug/doctor');
}

export function getDebugSupervision(): Promise<SupervisionResponse> {
  return request<SupervisionResponse>('GET', '/api/debug/supervision');
}

export function getMcpTools(): Promise<McpToolsResponse> {
  return request<McpToolsResponse>('GET', '/api/mcp/tools');
}

export { ApiError };
