import { defineStore } from 'pinia';
import { computed, readonly, ref, shallowRef } from 'vue';
import type {
  AgentConversationEntry,
  DetailErrorState,
  RestartChatAcknowledgement,
} from '../api/types';
import {
  OperatorApiError,
  getChatEntries,
  getAgentConversation,
  isOperatorApiError,
  sendChatMessage,
} from '../api/client';
import { useWorkspaceRouteStore } from './workspaceRoute';
import { useFeedbackStore } from './feedback';
import type { ConversationSessionId } from '../api/contracts';
import { DURABLE_PRIMARY_CONTENT_POLICY, workspaceNavigationIntentSchema } from '../api/contracts';
import { createConversationFetch, type ConversationFrame } from './conversation-fetch';

function nowIso(): string {
  return new Date().toISOString();
}

function buildErrorState(err: unknown, fallback: string): DetailErrorState {
  if (err instanceof OperatorApiError) {
    if (err.isUnauthorized) {
      return { kind: 'unauthorized', status: err.status, message: err.message || 'Unauthorized.' };
    }
    if (err.status >= 500) {
      return { kind: 'server', status: err.status, message: err.message || fallback };
    }
    return { kind: 'unknown', status: err.status, message: err.message || fallback };
  }
  if (err instanceof Error) {
    return { kind: 'network', status: null, message: err.message || fallback };
  }
  return { kind: 'unknown', status: null, message: fallback };
}

function optimisticUserMessage(
  sessionId: ConversationSessionId,
  content: string,
  timestamp: string,
  index: number,
): AgentConversationEntry {
  return {
    id: `${sessionId}-user-optimistic-${Date.now()}`,
    session_id: sessionId,
    role: 'user',
    kind: 'text',
    content,
    context_policy: DURABLE_PRIMARY_CONTENT_POLICY,
    round_id: `r-user-${Date.now().toString(16).padStart(32, '0').slice(-32)}`,
    message_index: index,
    block_index: 0,
    timestamp,
  };
}

type PendingMessage = {
  owner: symbol;
  entry: AgentConversationEntry;
};

type AnalystIdentityState =
  | { kind: 'pending' }
  | { kind: 'resolved'; sessionId: ConversationSessionId }
  | { kind: 'failed'; error: DetailErrorState };

function authoritativeContainsPending(
  entries: AgentConversationEntry[],
  pending: AgentConversationEntry,
): boolean {
  return entries.some(
    (entry) =>
      entry.id === pending.id ||
      (entry.session_id === pending.session_id &&
        entry.role === 'user' &&
        entry.content === pending.content),
  );
}

export const useAnalystChat = defineStore('analyst-chat', () => {
  let identityEpoch = 0;
  let identityController: AbortController | null = null;
  const mutableIdentityState = shallowRef<AnalystIdentityState>({ kind: 'pending' });
  const identityState = readonly(mutableIdentityState);
  const activeSessionId = computed(() =>
    mutableIdentityState.value.kind === 'resolved'
      ? mutableIdentityState.value.sessionId
      : null,
  );
  const pendingMessages = ref<PendingMessage[]>([]);
  type Handoff = {
    identityEpoch: number;
    sessionId: ConversationSessionId;
    owner: symbol | null;
    acknowledged: boolean;
    pending: boolean;
  };
  const handoff = shallowRef<Handoff | null>(null);
  const transcript = createConversationFetch<undefined, DetailErrorState>({
    isOwnerCurrent: () => handoff.value?.owner !== null && handoff.value?.acknowledged === true,
    async request(signal, requestCursor) {
      const sessionId = activeSessionId.value;
      if (!sessionId) throw new Error('Analyst transcript request has no session identity.');
      const response = await getAgentConversation(
        sessionId,
        signal,
        requestCursor?.message_id
          ? { segmentVersion: requestCursor.segment_version, messageId: requestCursor.message_id }
          : undefined,
      );
      return { response, metadata: undefined };
    },
    projectError: (error) => buildErrorState(error, 'Failed to load analyst chat messages.'),
    onFailure() {},
    onAccepted({ responseEntries }) {
      pendingMessages.value = pendingMessages.value.filter(
        (pending) => !authoritativeContainsPending(responseEntries, pending.entry),
      );
    },
  });
  const authoritativeMessages = transcript.entries;
  const messages = computed(() => [
    ...authoritativeMessages.value,
    ...pendingMessages.value.map((pending) => pending.entry),
  ]);
  const draft = ref('');
  const messagesLoading = computed(
    () =>
      mutableIdentityState.value.kind === 'pending' ||
      transcript.coldLoading.value ||
      (!transcript.baselineAccepted.value && handoff.value?.pending === true),
  );
  const messagesError = computed(
    () =>
      (mutableIdentityState.value.kind === 'failed' ? mutableIdentityState.value.error : null) ??
      transcript.initialError.value ??
      transcript.refreshError.value,
  );
  const sending = ref(false);
  const sendError = ref<DetailErrorState | null>(null);
  const restartAcknowledgement = ref<RestartChatAcknowledgement | null>(null);

  function setDraft(value: string): void {
    draft.value = value;
  }

  function presentRestartAcknowledgement(restart: RestartChatAcknowledgement | null): void {
    restartAcknowledgement.value = restart?.status === 'confirmation_required' ? restart : null;
    if (restart?.status === 'scheduled') {
      useFeedbackStore().notify({
        tone: 'warning',
        title: 'Server restart scheduled',
        message:
          'The server is shutting down. This does not confirm that a replacement is running.',
      });
    }
  }

  function beginIdentityResolution(): { epoch: number; controller: AbortController } {
    const nextIdentityEpoch = ++identityEpoch;
    identityController?.abort();
    transcript.reset();
    pendingMessages.value = [];
    handoff.value = null;
    mutableIdentityState.value = { kind: 'pending' };
    const controller = new AbortController();
    identityController = controller;
    return { epoch: nextIdentityEpoch, controller };
  }

  async function resolveIdentity(): Promise<void> {
    const owner = beginIdentityResolution();
    try {
      const identity = await getChatEntries(owner.controller.signal);
      if (owner.epoch !== identityEpoch || identityController !== owner.controller) return;
      mutableIdentityState.value = { kind: 'resolved', sessionId: identity.session_id };
      handoff.value = {
        identityEpoch: owner.epoch,
        sessionId: identity.session_id,
        owner: null,
        acknowledged: false,
        pending: true,
      };
    } catch (error) {
      if (
        owner.epoch !== identityEpoch ||
        identityController !== owner.controller ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) return;
      mutableIdentityState.value = {
        kind: 'failed',
        error: buildErrorState(error, 'Failed to load analyst chat identity.'),
      };
      throw error;
    } finally {
      if (owner.epoch === identityEpoch && identityController === owner.controller) {
        identityController = null;
      }
    }
  }

  async function fetchMessages(): Promise<void> {
    if (mutableIdentityState.value.kind !== 'resolved') return;
    if (!handoff.value?.owner || !handoff.value.acknowledged || handoff.value.pending) return;
    await transcript.fetch();
  }

  function claimTranscriptLease(sessionId: ConversationSessionId): {
    onFrame(frame: ConversationFrame | null): Promise<void>;
    release(): void;
  } {
    if (activeSessionId.value !== sessionId) {
      throw new Error(`Cannot claim Analyst transcript lease for non-current session '${sessionId}'.`);
    }
    if (
      !handoff.value ||
      handoff.value.identityEpoch !== identityEpoch ||
      handoff.value.sessionId !== sessionId
    ) throw new Error('Cannot claim Analyst transcript lease without its current identity handoff.');
    transcript.cancel();
    const owner = Symbol('analyst-transcript-lease');
    handoff.value = { ...handoff.value, owner, acknowledged: false, pending: true };

    const isCurrent = () =>
      handoff.value?.identityEpoch === identityEpoch &&
      handoff.value.sessionId === sessionId &&
      handoff.value.owner === owner;

    return {
      onFrame(frame) {
        if (!isCurrent()) return Promise.resolve();
        if (frame === null) {
          if (handoff.value!.pending) {
            handoff.value = { ...handoff.value!, acknowledged: true, pending: false };
            return transcript.fetch();
          }
          if (handoff.value!.acknowledged) return transcript.fetch();
          return Promise.resolve();
        }
        if (handoff.value!.pending || !handoff.value!.acknowledged) return Promise.resolve();
        return transcript.onFrame(frame);
      },
      release() {
        if (!isCurrent()) return;
        handoff.value = {
          ...handoff.value!,
          owner: null,
          acknowledged: false,
          pending: true,
        };
        transcript.cancel();
      },
    };
  }

  async function sendMessage(): Promise<void> {
    if (sending.value) return;
    const content = draft.value.trim();
    if (!content) return;
    if (!activeSessionId.value) throw new Error('Analyst session identity is not loaded.');
    sending.value = true;
    sendError.value = null;
    const previousDraft = draft.value;
    const pendingOwner = Symbol('analyst-send');
    let sendAccepted = false;
    try {
      const workspaceRoute = useWorkspaceRouteStore();
      const workspaceContext = workspaceRoute.current ?? {
        view: null,
        entityId: null,
        refinement: null,
      };
      draft.value = '';
      const optimisticMessage = optimisticUserMessage(
        activeSessionId.value,
        content,
        nowIso(),
        messages.value.length,
      );
      pendingMessages.value = [
        ...pendingMessages.value,
        { owner: pendingOwner, entry: optimisticMessage },
      ];
      const response = await sendChatMessage(content, workspaceContext);
      sendAccepted = true;
      presentRestartAcknowledgement(response.restart);

      for (const invocation of response.toolInvocations) {
        if (
          (invocation.tool !== 'navigate_workspace' && invocation.tool !== 'navigate_back')
        )
          continue;
        if (invocation.result.success !== true) continue;
        const intent = workspaceNavigationIntentSchema.parse(invocation.result.data);
        if (intent.intent !== invocation.tool) {
          throw new Error(`Navigation tool ${invocation.tool} returned ${intent.intent} intent.`);
        }
        workspaceRoute.apply(intent);
      }

      try {
        await fetchMessages();
      } catch {
        // The send was accepted. Refresh state is reported independently by fetchMessages.
      }
    } catch (err) {
      if (sendAccepted) throw err;
      sendError.value = isOperatorApiError(err, 'chats.send', 409)
        ? {
            kind: 'busy',
            status: 409,
            message: err.data.message,
          }
        : buildErrorState(err, 'Failed to send analyst chat message.');
      pendingMessages.value = pendingMessages.value.filter(
        (pending) => pending.owner !== pendingOwner,
      );
      if (draft.value === '') draft.value = previousDraft;
      useFeedbackStore().notifyError('Failed to send Analyst message', sendError.value.message);
      throw err;
    } finally {
      sending.value = false;
    }
  }

  function ingestWsEvent(payload: Record<string, unknown>): void {
    const event = typeof payload.event === 'string' ? payload.event : null;
    if (event === 'notification_added') {
      return;
    }
    if (event === 'control_action_recorded') {
      if (payload.actor === 'analyst' && payload.surface === 'web-chat') {
        const action = typeof payload.action === 'string' ? payload.action : 'action';
        const targetId = typeof payload.target_id === 'string' ? payload.target_id : 'unknown';
        const id = typeof payload.id === 'string' ? payload.id : `${Date.now()}`;
        useFeedbackStore().notify({
          id,
          tone: 'neutral',
          title: `Analyst ${action}`,
          message: targetId,
        });
      }
    }
  }

  function ingestRestartAcknowledgement(restart: RestartChatAcknowledgement | null): void {
    presentRestartAcknowledgement(restart);
  }

  return {
    identityState,
    activeSessionId,
    messages,
    draft,
    messagesLoading,
    messagesError,
    sending,
    sendError,
    restartAcknowledgement,
    setDraft,
    resolveIdentity,
    fetchMessages,
    claimTranscriptLease,
    sendMessage,
    ingestWsEvent,
    ingestRestartAcknowledgement,
  };
});
