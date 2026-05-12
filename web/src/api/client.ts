/**
 * Saivage v3 API Client
 *
 * Typed fetch wrappers for all REST endpoints documented in 08-server-api.md.
 * Auth token comes from localStorage ('saivage_api_token') or the URL query
 * parameter 'token', falling back to VITE_SAIVAGE_API_TOKEN from import.meta.env.
 */

import type {
  CardListResponse,
  CardDetailResponse,
  CardCreateResponse,
  CardUpdateResponse,
  CreateCardPayload,
  UpdateCardPayload,
  RuntimeStateResponse,
  ConfigResponse,
  ProvidersResponse,
  AgentConversationResponse,
  NotesListResponse,
  NotesClearResponse,
  NoteRecord,
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
  FreezeResponse,
  ResumeFromFreezeResponse,
  ProcessListResponse,
  ProcessDetailResponse,
} from './types';
import { getAuthToken } from './auth';

// ── Auth Headers Helper ───────────────────────────────────────

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

// ── Base Fetch Wrapper ────────────────────────────────────────

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

  // 204 No Content — return empty object
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
    throw new ApiError(
      response.status,
      (responseBody['message'] as string) || (responseBody['error'] as string) || response.statusText,
      responseBody,
    );
  }

  return responseBody as T;
}

// ── Health ────────────────────────────────────────────────────

export async function getHealth(): Promise<{ status: string; version: string; project: string; runtime: string }> {
  const headers = authHeaders();
  const response = await fetch('/health', { headers });
  if (!response.ok) {
    throw new ApiError(response.status, 'Health check failed', {});
  }
  return response.json() as Promise<{ status: string; version: string; project: string; runtime: string }>;
}

// ── Cards ─────────────────────────────────────────────────────

export function listCards(query?: {
  status?: string;
  type?: string;
  parent?: string;
  tag?: string;
}): Promise<CardListResponse> {
  return request<CardListResponse>('GET', '/api/cards', query as Record<string, string>);
}

export function getCard(id: string): Promise<CardDetailResponse> {
  return request<CardDetailResponse>('GET', `/api/cards/${encodeURIComponent(id)}`);
}

export function createCard(payload: CreateCardPayload): Promise<CardCreateResponse> {
  return request<CardCreateResponse>('POST', '/api/cards', undefined, payload);
}

export function updateCard(id: string, payload: UpdateCardPayload): Promise<CardUpdateResponse> {
  return request<CardUpdateResponse>('PATCH', `/api/cards/${encodeURIComponent(id)}`, undefined, payload);
}

export function deleteCard(id: string): Promise<void> {
  return request<void>('DELETE', `/api/cards/${encodeURIComponent(id)}`);
}

// ── Runtime ───────────────────────────────────────────────────

export function getRuntimeState(): Promise<RuntimeStateResponse> {
  return request<RuntimeStateResponse>('GET', '/api/state');
}

export function pauseRuntime(): Promise<{ status: string }> {
  return request<{ status: string }>('POST', '/api/runtime/pause');
}

export function resumeRuntime(): Promise<{ status: string }> {
  return request<{ status: string }>('POST', '/api/runtime/resume');
}

// ── Freeze / Resume from Freeze ───────────────────────────────

export function freezeRuntime(reason?: string): Promise<FreezeResponse> {
  return request<FreezeResponse>('POST', '/api/runtime/freeze', undefined, reason ? { reason } : {});
}

export function resumeRuntimeFromFreeze(): Promise<ResumeFromFreezeResponse> {
  return request<ResumeFromFreezeResponse>('POST', '/api/runtime/resume-from-freeze');
}

// ── Agents ────────────────────────────────────────────────────

export function getAgentConversation(sessionId: string): Promise<AgentConversationResponse> {
  return request<AgentConversationResponse>('GET', `/api/agents/${encodeURIComponent(sessionId)}/conversation`);
}

// ── Configuration ─────────────────────────────────────────────

export function getConfig(): Promise<ConfigResponse> {
  return request<ConfigResponse>('GET', '/api/config');
}

export function getProviders(): Promise<ProvidersResponse> {
  return request<ProvidersResponse>('GET', '/api/providers');
}

// ── Notes ─────────────────────────────────────────────────────

export function listNotes(): Promise<NotesListResponse> {
  return request<NotesListResponse>('GET', '/api/notes');
}

export function acknowledgeNote(noteId: string): Promise<{ note: NoteRecord }> {
  return request<{ note: NoteRecord }>('POST', `/api/notes/${encodeURIComponent(noteId)}/acknowledge`);
}

export function deleteNote(noteId: string): Promise<void> {
  return request<void>('DELETE', `/api/notes/${encodeURIComponent(noteId)}`);
}

export function clearAllNotes(): Promise<NotesClearResponse> {
  return request<NotesClearResponse>('DELETE', '/api/notes');
}

// ── Chats ─────────────────────────────────────────────────────

export function listChatSessions(): Promise<ChatSessionsResponse> {
  return request<ChatSessionsResponse>('GET', '/api/chats');
}

export function getChatMessages(sessionId: string): Promise<ChatMessagesResponse> {
  return request<ChatMessagesResponse>('GET', `/api/chats/${encodeURIComponent(sessionId)}`);
}

export function sendChatMessage(sessionId: string, content: string): Promise<ChatResponse> {
  return request<ChatResponse>('POST', `/api/chats/${encodeURIComponent(sessionId)}`, undefined, { content });
}

// ── Files ─────────────────────────────────────────────────────

export function listFiles(path?: string): Promise<FilesListResponse> {
  return request<FilesListResponse>('GET', '/api/files', path ? { path } : undefined);
}

export function getFileContent(path: string): Promise<FileContent> {
  return request<FileContent>('GET', '/api/files/content', { path });
}

// ── Processes ─────────────────────────────────────────────────

/**
 * List all processes.
 */
export function listProcesses(): Promise<ProcessListResponse> {
  return request<ProcessListResponse>('GET', '/api/processes');
}

/**
 * Get a single process by ID.
 */
export function getProcess(processId: string): Promise<ProcessDetailResponse> {
  return request<ProcessDetailResponse>('GET', `/api/processes/${encodeURIComponent(processId)}`);
}

// ── Debug ─────────────────────────────────────────────────────

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

// ── MCP ───────────────────────────────────────────────────────

export function getMcpTools(): Promise<McpToolsResponse> {
  return request<McpToolsResponse>('GET', '/api/mcp/tools');
}

export { ApiError };
