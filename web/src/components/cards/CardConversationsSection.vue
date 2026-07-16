<template>
  <section class="detail-section conversations-section" data-testid="card-conversations">
    <div class="conv-header-row">
      <PanelHeader title="Agent conversations">
        <template #actions>
          <button type="button" class="conv-refresh" :disabled="loading" @click="loadSessions">Refresh</button>
        </template>
      </PanelHeader>
    </div>

    <ViewState v-if="loading && sessions.length === 0" state="loading" title="Loading agent sessions" />
    <ViewState v-else-if="loadError" state="error" title="Could not load sessions" :message="loadError" />

    <ViewState v-if="!loading && cardSessions.length === 0" state="empty" title="No agent sessions" message="No agent sessions have run against this card yet." />
    <ul v-else class="session-list">
      <li v-for="session in cardSessions" :key="session.id">
        <SelectableRow class="session-row" :class="'status-' + session.status" @select="openSession(session.id)">
          <span class="session-role">{{ session.role }}</span>
          <span class="session-model">{{ session.model || 'default' }}</span>
          <StatusBadge :status="statusForAgentSession(session.status)" />
          <span class="session-time" :title="timestampTitle(session.started_at)">{{ fmtDate(session.started_at) }}</span>
        </SelectableRow>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useAgentStore } from '../../stores/agents';
import { formatTimestamp, isRecentTimestamp, timestampTitle } from '../../utils/timestamp';
import { statusForAgentSession } from '../../utils/status';
import PanelHeader from '../ui/PanelHeader.vue';
import SelectableRow from '../ui/SelectableRow.vue';
import StatusBadge from '../ui/StatusBadge.vue';
import ViewState from '../ui/ViewState.vue';

const props = defineProps<{ cardId: string }>();

const router = useRouter();
const agentStore = useAgentStore();
const { sessions, sessionsLoading: loading, sessionsError: loadError } = storeToRefs(agentStore);

const cardSessions = computed(() =>
  sessions.value.filter((s) => s.card_id === props.cardId || s.goal_card_id === props.cardId),
);

function fmtDate(ts: string): string {
  return ts ? formatTimestamp(ts, isRecentTimestamp(ts) ? 'relative' : 'absolute') : '';
}

function openSession(id: string): void {
  void router.push({ name: 'agent-detail', params: { id } });
}

async function loadSessions(): Promise<void> {
  await agentStore.fetchSessions().catch(() => {});
}

onMounted(() => { void loadSessions(); });
watch(() => props.cardId, () => { void loadSessions(); });
</script>

<style scoped>
.conversations-section { display: flex; flex-direction: column; gap: 10px; }
.conv-header-row { display: block; }
.conv-refresh { background: none; border: 1px solid var(--border); border-radius: 4px; padding: 3px 10px; color: var(--accent-2); font-size: 12px; cursor: pointer; font-family: inherit; }
.conv-refresh:disabled { opacity: 0.6; cursor: default; }
.session-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.session-row { padding: 8px 12px; background: var(--surface-1); border: 1px solid var(--surface-3); border-left: 3px solid transparent; border-radius: 6px; color: var(--text); }
.session-row:hover { border-color: var(--border); }
.session-row.status-active { border-left-color: var(--accent-2); }
.session-row.status-waiting { border-left-color: var(--warn); }
.session-row.status-done { border-left-color: var(--accent); }
.session-row.status-blocked, .session-row.status-failed { border-left-color: var(--danger); }
.session-role { font-size: 12px; font-weight: 600; text-transform: capitalize; }
.session-model { font-size: 11px; color: var(--text-muted); font-family: 'SF Mono', monospace; }
.session-time { margin-left: auto; font-size: 11px; color: var(--text-muted); font-family: 'SF Mono', monospace; }
</style>
