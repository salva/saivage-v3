/**
 * Saivage v3 API Client
 *
 * Typed fetch wrappers for all REST endpoints documented in docs/spec/system-specification.md.
 * Auth token comes from localStorage ('saivage_api_token'), falling back to
 * VITE_SAIVAGE_API_TOKEN from import.meta.env. URL query tokens are ignored.
 */

import type {
  CardChildrenResponse,
  CardDetailResponse,
  CardRecordListResponse,
  CardRecordContentResponse,
  RuntimeStateResponse,
  AgentConversationResponse,
  AgentLlmExchangeResponse,
  AgentSessionsResponse,
  AgentDetailResponse,
  CardAgentSessionsResponse,
  ChatEntriesResponse,
  ChatResponse,
  ChatWorkspaceContext,
  FilesListResponse,
  FileContent,
  DebugErrorsResponse,
  DoctorResponse,
  McpToolsResponse,
  ProcessListResponse,
  CardHistoryListResponse,
  CardHistoryEntryResponse,
  CardDiffResponse,
  ContentPolicyRuntimeResponse,
} from './types';
import { type ConversationSessionId } from './contracts';
import { getAuthToken } from './auth';
import {
  operatorApiContracts,
  parseOperatorResponse,
  type OperatorApiOperationId,
  type OperatorApiParams,
  type OperatorApiBody,
  type OperatorApiResponseStatus,
  type OperatorApiResponse,
  type OperatorApiSuccess,
} from './contracts';
import { dispatchApiAuthRequired } from '../utils/auth-events';

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

type OperatorApiFailureStatus<K extends OperatorApiOperationId> = Exclude<
  OperatorApiResponseStatus<K>,
  200
>;

function responseErrorMessage(data: unknown, status: number, statusText: string): string {
  if (data && typeof data === 'object') {
    const responseData = data as { message?: unknown; error?: unknown };
    if (typeof responseData.message === 'string' && responseData.message.length > 0) {
      return responseData.message;
    }
    if (typeof responseData.error === 'string' && responseData.error.length > 0) {
      return responseData.error;
    }
  }
  return statusText || `HTTP ${status}`;
}

export class OperatorApiError<
  K extends OperatorApiOperationId = OperatorApiOperationId,
  S extends OperatorApiFailureStatus<K> = OperatorApiFailureStatus<K>,
> extends Error {
  readonly operationId: K;
  readonly status: S;
  readonly data: OperatorApiResponse<K, S>;

  constructor(operationId: K, status: S, data: OperatorApiResponse<K, S>, statusText = '') {
    super(responseErrorMessage(data, status, statusText));
    this.name = 'OperatorApiError';
    this.operationId = operationId;
    this.status = status;
    this.data = data;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export function isOperatorApiError<
  K extends OperatorApiOperationId,
  S extends OperatorApiFailureStatus<K>,
>(error: unknown, operationId: K, status: S): error is OperatorApiError<K, S> {
  return error instanceof OperatorApiError
    && error.operationId === operationId
    && error.status === status;
}

async function operatorRequest<K extends OperatorApiOperationId>(
  operationId: K,
  options: OperatorRequestOptions<K> = {},
): Promise<OperatorApiSuccess<K>> {
  const contract = operatorApiContracts[operationId];
  const method = contract.method;
  const path = buildOperatorPath(operationId, options.params);
  const query = normalizeQuery(options.query);
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
    signal: options.signal,
  };

  if (options.body !== undefined && method !== 'GET') {
    init.body = JSON.stringify(options.body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }

  const response = await fetch(url.toString(), init);

  if (!Object.hasOwn(contract.response, response.status)) {
    throw new Error(
      `Operator API operation ${operationId} does not declare response status ${response.status}.`,
    );
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new Error(
      `Operator API operation ${operationId} returned invalid JSON for declared response status ${response.status}.`,
    );
  }

  const parsed = parseOperatorResponse(operationId, response.status, responseBody);

  if (response.status === 200) {
    return parsed as OperatorApiSuccess<K>;
  }

  if (response.status === 401) {
    dispatchApiAuthRequired({ status: response.status, path });
  }
  throw new OperatorApiError(
    operationId,
    response.status as OperatorApiFailureStatus<K>,
    parsed as OperatorApiResponse<K, OperatorApiFailureStatus<K>>,
    response.statusText,
  );
}

type OperatorRequestOptions<K extends OperatorApiOperationId> = {
  params?: OperatorApiParams<K>;
  query?: Record<string, string | undefined>;
  body?: OperatorApiBody<K>;
  signal?: AbortSignal;
};

function buildOperatorPath<K extends OperatorApiOperationId>(
  operationId: K,
  params?: OperatorApiParams<K>,
): string {
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

function normalizeQuery(
  query?: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (!query) return undefined;
  const entries = Object.entries(query).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function issueWebSocketTicket(): Promise<OperatorApiSuccess<'auth.wsTicket'>> {
  return operatorRequest('auth.wsTicket');
}

export function getCardChildren(id: string, signal?: AbortSignal): Promise<CardChildrenResponse> {
  return operatorRequest('cards.children', { params: { id }, signal });
}

export function getCard(id: string, signal?: AbortSignal): Promise<CardDetailResponse> {
  return operatorRequest('cards.get', { params: { id }, signal });
}

export function listCardRecords(id: string, signal?: AbortSignal): Promise<CardRecordListResponse> {
  return operatorRequest('cards.records.list', { params: { id }, signal });
}

export function getCardRecord(id: string, name: string, signal?: AbortSignal): Promise<CardRecordContentResponse> {
  return operatorRequest('cards.records.get', { params: { id, name }, signal });
}

export function listRecordHistory(id: string, name: string, signal?: AbortSignal) {
  return operatorRequest('cards.records.history.list', { params: { id, name }, signal });
}

export function getRecordVersion(id: string, name: string, version: number, signal?: AbortSignal) {
  return operatorRequest('cards.records.versions.get', { params: { id, name, version }, signal });
}

export function getRecordDiff(id: string, name: string, from: number, to: number | 'current' = 'current', view: 'effective' | 'accepted' | 'draft' = 'effective', signal?: AbortSignal) {
  return operatorRequest('cards.records.diff', { params: { id, name }, query: { from: String(from), to: typeof to === 'number' ? String(to) : to, view }, signal });
}

export function listCardHistory(
  id: string,
  signal?: AbortSignal,
): Promise<CardHistoryListResponse> {
  return operatorRequest('cards.history.list', { params: { id }, signal });
}

export function getCardHistoryEntry(
  id: string,
  version: number,
  signal?: AbortSignal,
): Promise<CardHistoryEntryResponse> {
  return operatorRequest('cards.history.get', { params: { id, version }, signal });
}

export interface CurrentCardDiffKey {
  cardId: string;
  fromSeq: number;
  to: 'current';
}

export function getCardDiff(
  key: CurrentCardDiffKey,
  signal?: AbortSignal,
): Promise<CardDiffResponse> {
  return operatorRequest('cards.diff', {
    params: { id: key.cardId },
    query: {
      from: String(key.fromSeq),
      to: key.to,
    },
    signal,
  });
}

export function getRuntimeState(signal?: AbortSignal): Promise<RuntimeStateResponse> {
  return operatorRequest('runtime.getState', { signal });
}
export function getContentPolicyRuntime(signal?: AbortSignal): Promise<ContentPolicyRuntimeResponse> {
  return operatorRequest('runtime.contentPolicy', { signal });
}

export function getRuntimeStatus(
  signal?: AbortSignal,
): Promise<OperatorApiSuccess<'runtime.status'>> {
  return operatorRequest('runtime.status', { signal });
}
export function stopProject(): Promise<OperatorApiSuccess<'stop_project'>> {
  return operatorRequest('stop_project');
}
export function restartServer(): Promise<OperatorApiSuccess<'restart_server'>> {
  return operatorRequest('restart_server', { body: { confirmation: 'RESTART SERVER' } });
}

export function listAgentSessions(signal?: AbortSignal): Promise<AgentSessionsResponse> {
  return operatorRequest('agents.list', { signal });
}
export function getCardAgentSessions(
  cardId: string,
  signal?: AbortSignal,
): Promise<CardAgentSessionsResponse> {
  return operatorRequest('agents.cardSessions', { params: { id: cardId }, signal });
}
export function getAgentSession(
  sessionId: ConversationSessionId,
  signal?: AbortSignal,
): Promise<AgentDetailResponse> {
  return operatorRequest('agents.detail', { params: { id: sessionId }, signal });
}

export function getAgentConversation(
  sessionId: ConversationSessionId,
  signal?: AbortSignal,
  cursor?: { segmentVersion: number; messageId: string },
): Promise<AgentConversationResponse> {
  return operatorRequest('agents.conversation', {
    params: { id: sessionId },
    query: cursor ? { segment_version: String(cursor.segmentVersion), since: cursor.messageId } : undefined,
    signal,
  });
}
export function listAgentConversationVersions(sessionId: ConversationSessionId, signal?: AbortSignal) { return operatorRequest('agents.conversationVersions.list', { params: { id: sessionId }, signal }); }
export function getAgentConversationVersion(sessionId: ConversationSessionId, version: number, signal?: AbortSignal) { return operatorRequest('agents.conversationVersions.get', { params: { id: sessionId, version }, signal }); }

export function getAgentLlmExchange(
  sessionId: ConversationSessionId,
  signal?: AbortSignal,
): Promise<AgentLlmExchangeResponse> {
  return operatorRequest('agents.llmExchange', {
    params: { id: sessionId },
    signal,
  });
}

export function getChatEntries(signal?: AbortSignal): Promise<ChatEntriesResponse> {
  return operatorRequest('chats.get', { signal });
}

export function sendChatMessage(
  content: string,
  workspaceContext?: ChatWorkspaceContext,
): Promise<ChatResponse> {
  const body = workspaceContext === undefined ? { content } : { content, workspaceContext };
  return operatorRequest('chats.send', { body });
}

export function listFiles(path?: string, signal?: AbortSignal): Promise<FilesListResponse> {
  return operatorRequest('files.list', { query: path ? { path } : undefined, signal });
}

export function getFileContent(path: string, signal?: AbortSignal): Promise<FileContent> {
  return operatorRequest('files.content', { query: { path }, signal });
}

export function listProcesses(): Promise<ProcessListResponse> {
  return operatorRequest('processes.list');
}

export function getDebugErrors(): Promise<DebugErrorsResponse> {
  return operatorRequest('debug.errors');
}

export function getDebugGraphs(
  signal?: AbortSignal,
): Promise<import('./types').DebugGraphsResponse> {
  return operatorRequest('debug.graphs', { signal });
}

export function getDoctor(): Promise<DoctorResponse> {
  return operatorRequest('debug.doctor');
}

export function getMcpTools(): Promise<McpToolsResponse> {
  return operatorRequest('mcp.tools');
}
