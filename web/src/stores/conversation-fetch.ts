import { ref, shallowRef, type Ref, type ShallowRef } from 'vue';
import type { AgentConversationEntry, AgentConversationResponse } from '../api/types';
import { isOperatorApiError } from '../api/client';

export type ConversationCursor = AgentConversationResponse['cursor'];
export type ConversationFrame = {
  segment_version: number;
  visible_message_id: string | null;
};

export interface ConversationAcceptance<Metadata> {
  responseEntries: AgentConversationEntry[];
  acceptedEntries: AgentConversationEntry[];
  response: AgentConversationResponse;
  metadata: Metadata;
}

interface ConversationFetchOptions<Metadata, ErrorState> {
  isOwnerCurrent(): boolean;
  request(
    signal: AbortSignal,
    cursor: ConversationCursor | null,
  ): Promise<{ response: AgentConversationResponse; metadata: Metadata }>;
  projectError(error: unknown): ErrorState;
  onFailure(error: unknown): void;
  onAccepted(acceptance: ConversationAcceptance<Metadata>): void;
}

export interface ConversationFetch<ErrorState> {
  entries: Ref<AgentConversationEntry[]>;
  baselineAccepted: Ref<boolean>;
  cursor: Ref<ConversationCursor | null>;
  coldLoading: Ref<boolean>;
  refreshing: Ref<boolean>;
  initialError: ShallowRef<ErrorState | null>;
  refreshError: ShallowRef<ErrorState | null>;
  fetch(): Promise<void>;
  onFrame(frame: ConversationFrame): Promise<void>;
  cancel(): void;
  reset(): void;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function createConversationFetch<Metadata, ErrorState>(
  options: ConversationFetchOptions<Metadata, ErrorState>,
): ConversationFetch<ErrorState> {
  const entries = ref<AgentConversationEntry[]>([]);
  const baselineAccepted = ref(false);
  const cursor = ref<ConversationCursor | null>(null);
  const coldLoading = ref(false);
  const refreshing = ref(false);
  const initialError = shallowRef<ErrorState | null>(null);
  const refreshError = shallowRef<ErrorState | null>(null);
  let controller: AbortController | null = null;
  let epoch = 0;

  function current(requestEpoch: number): boolean {
    return requestEpoch === epoch && options.isOwnerCurrent();
  }

  async function fetch(): Promise<void> {
    const requestEpoch = ++epoch;
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    const refresh = baselineAccepted.value;
    coldLoading.value = !refresh;
    refreshing.value = refresh;
    initialError.value = null;
    refreshError.value = null;
    const requestCursor = cursor.value?.message_id ? cursor.value : null;
    let acceptedCursor = requestCursor;

    try {
      let result: { response: AgentConversationResponse; metadata: Metadata };
      try {
        result = await options.request(requestController.signal, requestCursor);
      } catch (error) {
        if (!current(requestEpoch) || isAbortError(error)) return;
        if (!requestCursor || !isOperatorApiError(error, 'agents.conversation', 409)) throw error;
        acceptedCursor = null;
        result = await options.request(requestController.signal, null);
      }
      const acceptedEntries =
        acceptedCursor === null || acceptedCursor.segment_version !== result.response.segment_version
          ? [...result.response.entries]
          : [...entries.value, ...result.response.entries];
      if (!current(requestEpoch)) return;
      entries.value = acceptedEntries;
      cursor.value = result.response.cursor;
      baselineAccepted.value = true;
      initialError.value = null;
      refreshError.value = null;
      options.onAccepted({
        responseEntries: result.response.entries,
        acceptedEntries,
        response: result.response,
        metadata: result.metadata,
      });
    } catch (error) {
      if (!current(requestEpoch) || isAbortError(error)) return;
      const projected = options.projectError(error);
      if (refresh) refreshError.value = projected;
      else initialError.value = projected;
      options.onFailure(error);
      throw error;
    } finally {
      if (current(requestEpoch)) {
        coldLoading.value = false;
        refreshing.value = false;
        controller = null;
      }
    }
  }

  async function onFrame(frame: ConversationFrame): Promise<void> {
    if (cursor.value) {
      if (frame.segment_version !== cursor.value.segment_version) cursor.value = null;
      else if (frame.visible_message_id === cursor.value.message_id) return;
    }
    await fetch();
  }

  function cancel(): void {
    ++epoch;
    controller?.abort();
    controller = null;
    coldLoading.value = false;
    refreshing.value = false;
  }

  function reset(): void {
    cancel();
    entries.value = [];
    baselineAccepted.value = false;
    cursor.value = null;
    initialError.value = null;
    refreshError.value = null;
  }

  return {
    entries,
    baselineAccepted,
    cursor,
    coldLoading,
    refreshing,
    initialError,
    refreshError,
    fetch,
    onFrame,
    cancel,
    reset,
  };
}
