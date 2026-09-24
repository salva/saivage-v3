<template>
  <div class="session-route" data-testid="route-session">
    <ViewState
      v-if="routeSession.kind === 'invalid'"
      state="error"
      title="Invalid agent session"
      message="The route does not contain a canonical agent session identity."
      data-testid="session-invalid"
    />
    <template v-else-if="sessionId">
      <div v-if="scopeLoading && !scopeSummary" class="session-scope-state"><ViewState state="loading" title="Resolving exact session scope" /></div>
      <div v-else-if="scopeError && !scopeSummary" class="session-scope-state">
        <ViewState state="error" title="Session scope unavailable" :message="scopeError">
          <template #action><button type="button" @click="resolveScope">Retry</button></template>
        </ViewState>
      </div>

      <template v-if="scopeSummary">
        <CardFlowHeader
          v-if="scopeSummary.session_scope === 'card' && scopeSummary.card_id"
          :card-id="scopeSummary.card_id"
          :detail="cardContext.detail.value"
          :flow-unavailable="cardContext.unavailable.value"
          :position="cardPosition"
        />
        <header v-else class="session-global-header" data-testid="session-global-header">
          <h2 class="session-global-title">{{ scopeSummary.agent_name }}</h2>
          <span class="session-global-scope">Global session · {{ scopeSummary.id }}</span>
          <p class="session-global-note">This session is global: it is not owned by a card flow.</p>
        </header>

        <div v-if="scopeSummary.session_scope === 'card' && scopeSummary.card_id && cardContext.loading.value && !cardContext.detail.value && !cardContext.unavailable.value" class="session-scope-state">
          <ViewState state="loading" title="Requesting admitted card context" />
        </div>

        <div class="session-body" :class="{ 'session-body--with-rail': showRail }">
          <ParticipantRail
            v-if="showRail && scopeSummary.card_id"
            :card-id="scopeSummary.card_id"
            :detail="cardContext.detail.value"
            :selected-session-id="sessionId"
            @select="openSession"
          />
          <div class="session-reader" aria-label="Exact session reader">
            <button
              v-if="scopeSummary.session_scope === 'card' && scopeSummary.card_id"
              type="button"
              class="session-back-to-card"
              :disabled="cardContext.unavailable.value"
              data-testid="back-to-card"
              @click="backToCard(scopeSummary.card_id)"
            >Back to card {{ scopeSummary.card_id }}</button>
            <AgentConversationView :key="sessionId" :session-id="sessionId" :entry-id="entryId" />
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { AgentSession } from '../api/types';
import type { ConversationSessionId } from '../api/contracts';
import { OperatorApiError, getAgentSession } from '../api/client';
import { parseAgentDetailRouteParam } from '../router/agent-session-route';
import { useRuntimeStore } from '../stores/runtime';
import { useSessionCardContext } from '../composables/useSessionCardContext';
import AgentConversationView from '../components/agents/AgentConversationView.vue';
import CardFlowHeader from '../components/cockpit/CardFlowHeader.vue';
import ParticipantRail from '../components/cockpit/ParticipantRail.vue';
import ViewState from '../components/ui/ViewState.vue';

const route = useRoute();
const router = useRouter();
const runtimeStore = useRuntimeStore();

const routeSession = computed(() => parseAgentDetailRouteParam(route.params.id));
const sessionId = computed(() => (routeSession.value.kind === 'valid' ? routeSession.value.sessionId : null));
const entryId = computed(() => {
  const value = route.query.entry;
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
});

const scopeSummary = ref<AgentSession | null>(null);
const scopeLoading = ref(false);
const scopeError = ref<string | null>(null);
let scopeGeneration = 0;

function resolveScope(): void {
  const id = sessionId.value;
  const generation = ++scopeGeneration;
  scopeSummary.value = null;
  scopeError.value = null;
  if (!id) return;
  scopeLoading.value = true;
  getAgentSession(id)
    .then((response) => {
      if (generation !== scopeGeneration) return;
      scopeSummary.value = response.session;
    })
    .catch((cause: unknown) => {
      if (generation !== scopeGeneration) return;
      if (cause instanceof OperatorApiError && cause.isNotFound) {
        scopeError.value = 'This exact session is not available. No replacement is searched.';
        return;
      }
      scopeError.value = cause instanceof Error ? cause.message : String(cause);
    })
    .finally(() => {
      if (generation === scopeGeneration) scopeLoading.value = false;
    });
}

watch(sessionId, resolveScope, { immediate: true });

const cardContext = useSessionCardContext(() => (scopeSummary.value?.session_scope === 'card' ? scopeSummary.value.card_id : null));
const cardPosition = computed(() => {
  const cardId = scopeSummary.value?.session_scope === 'card' ? scopeSummary.value.card_id : null;
  return cardId ? runtimeStore.cardWorkflowPosition(cardId) : null;
});
const showRail = computed(() =>
  scopeSummary.value?.session_scope === 'card'
  && !!scopeSummary.value.card_id
  && (!!cardContext.detail.value || cardContext.unavailable.value),
);

function backToCard(cardId: string): void {
  if (cardContext.unavailable.value) return;
  void router.push({ name: 'card-detail', params: { id: cardId } });
}
function openSession(id: ConversationSessionId): void {
  void router.push({ name: 'agent-detail', params: { id } });
}
</script>

<style scoped>
.session-route { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }
.session-scope-state { padding: 24px; display: flex; justify-content: center; }
.session-scope-state > :deep(.view-state) { padding: 16px; }
.session-global-header { padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--surface-1); flex-shrink: 0; }
.session-global-title { margin: 0; font-size: 16px; font-weight: 700; color: var(--text); text-transform: capitalize; }
.session-global-scope { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); }
.session-global-note { margin: 6px 0 0; font-size: 11px; color: var(--text-muted); }
.session-body { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; overflow: hidden; }
.session-body--with-rail { grid-template-columns: minmax(220px, 1fr) minmax(0, 3fr); }
.session-body > :deep(.participant-rail) { border-right: 1px solid var(--border); }
.session-reader { display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; position: relative; }
.session-back-to-card {
  position: absolute; top: 8px; right: 16px; z-index: 5;
  padding: 3px 10px; border: 1px solid var(--border-strong); border-radius: 6px;
  background: var(--surface-2); color: var(--text); font: inherit; font-size: 11px; cursor: pointer;
}
.session-back-to-card:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
