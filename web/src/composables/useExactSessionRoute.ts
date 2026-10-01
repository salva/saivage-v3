import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { AgentSession } from '../api/types';
import { getAgentSession, OperatorApiError } from '../api/client';
import { parseAgentDetailRouteParam } from '../router/agent-session-route';
import { createOwnedFetch } from '../stores/owned-fetch';

const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function useExactSessionRoute() {
  const route = useRoute();
  const parsed = computed(() => route.name === 'agent-detail'
    ? parseAgentDetailRouteParam(route.params.id)
    : { kind: 'absent' as const });
  const sessionId = computed(() => parsed.value.kind === 'valid' ? parsed.value.sessionId : null);
  const entryId = computed(() => {
    const value = route.query.entry;
    return typeof value === 'string' && ENTRY_ID.test(value) ? value : null;
  });
  const summary = ref<AgentSession | null>(null);
  const request = createOwnedFetch();
  const loading = request.pending;
  const error = ref<string | null>(null);

  function resolve(): void {
    const id = sessionId.value;
    request.cancel();
    summary.value = null;
    error.value = null;
    if (!id) return;
    void request.run((signal) => getAgentSession(id, signal), (response) => {
        summary.value = response.session;
      }, (cause: unknown) => {
        error.value = cause instanceof OperatorApiError && cause.isNotFound
          ? 'This exact session is not available. No replacement is searched.'
          : cause instanceof Error ? cause.message : String(cause);
      });
  }

  watch(sessionId, resolve, { immediate: true });
  onBeforeUnmount(request.cancel);

  return { parsed, sessionId, entryId, summary, loading, error, resolve };
}
