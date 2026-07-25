<template>
  <section class="detail-section conversations-section" data-testid="card-conversations">
    <div class="conv-header-row">
      <PanelHeader title="Agent conversations">
        <template #actions>
          <button
            type="button"
            class="conv-refresh"
            :disabled="requestPending"
            @click="loadSessions"
          >
            Refresh
          </button>
        </template>
      </PanelHeader>
    </div>

    <ViewState
      v-if="state.loading && state.sessions.length === 0"
      state="loading"
      title="Loading agent sessions"
    />
    <ViewState
      v-else-if="state.error"
      state="error"
      title="Could not load sessions"
      :message="state.error"
    />

    <ViewState
      v-if="!state.loading && state.sessions.length === 0"
      state="empty"
      title="No agent sessions"
      message="No agent sessions have run against this card yet."
    />
    <ul v-else class="session-list">
      <li v-for="session in state.sessions" :key="session.id">
        <SelectableRow class="session-row" @select="openSession(session.id)">
          <span class="session-role">{{ session.agent_name }}</span>
          <span class="session-time" :title="timestampTitle(session.started_at)">{{
            fmtDate(session.started_at)
          }}</span>
        </SelectableRow>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useCardAgentSessionsStore } from '../../stores/cardAgentSessions';
import { useLiveSyncStore } from '../../stores/liveSync';
import { formatTimestamp, isRecentTimestamp, timestampTitle } from '../../utils/timestamp';
import PanelHeader from '../ui/PanelHeader.vue';
import SelectableRow from '../ui/SelectableRow.vue';
import ViewState from '../ui/ViewState.vue';
import type { ConversationSessionId } from '../../api/contracts';

const props = defineProps<{ cardId: string }>();

const router = useRouter();
const cardSessionsStore = useCardAgentSessionsStore();
const liveSync = useLiveSyncStore();
const state = computed(() => cardSessionsStore.scope(props.cardId));
const leaseReady = ref(false);
const requestPending = computed(
  () => !leaseReady.value || state.value.loading || state.value.refreshing,
);
let close: (() => void) | null = null;

function fmtDate(ts: string): string {
  return ts ? formatTimestamp(ts, isRecentTimestamp(ts) ? 'relative' : 'absolute') : '';
}

function openSession(id: ConversationSessionId): void {
  void router.push({ name: 'agent-detail', params: { id } });
}

async function loadSessions(): Promise<void> {
  if (leaseReady.value) await cardSessionsStore.fetchScope(props.cardId).catch(() => {});
}
function openScope(): void {
  leaseReady.value = false;
  close = liveSync.openCardAgentSessions(props.cardId, async () => {
    leaseReady.value = true;
    await loadSessions();
  });
}
onMounted(openScope);
watch(
  () => props.cardId,
  (cardId, previousCardId) => {
    close?.();
    cardSessionsStore.release(previousCardId);
    openScope();
  },
);
onUnmounted(() => {
  close?.();
  cardSessionsStore.release(props.cardId);
});
</script>

<style scoped>
.conversations-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.conv-header-row {
  display: block;
}
.conv-refresh {
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 10px;
  color: var(--accent-2);
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}
.conv-refresh:disabled {
  opacity: 0.6;
  cursor: default;
}
.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.session-row {
  padding: 8px 12px;
  background: var(--surface-1);
  border: 1px solid var(--surface-3);
  border-left: 3px solid transparent;
  border-radius: 6px;
  color: var(--text);
}
.session-row:hover {
  border-color: var(--border);
}
.session-role {
  font-size: 12px;
  font-weight: 600;
  text-transform: capitalize;
}
.session-time {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
  font-family: 'SF Mono', monospace;
}
</style>
