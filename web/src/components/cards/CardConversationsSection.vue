<template>
  <section class="detail-section conversations-section" data-testid="card-conversations">
    <div class="conv-header-row">
      <h3 class="section-heading">Agent conversations</h3>
      <button v-if="selectedSessionId" type="button" class="conv-back" @click="selectedSessionId = null">← All sessions</button>
      <button v-else type="button" class="conv-refresh" :disabled="loading" @click="loadSessions">Refresh</button>
    </div>

    <div v-if="loading && sessions.length === 0" class="conv-hint">Loading agent sessions…</div>
    <div v-else-if="loadError" class="conv-error">Could not load sessions: {{ loadError }}</div>

    <template v-if="!selectedSessionId">
      <div v-if="!loading && cardSessions.length === 0" class="conv-empty">No agent sessions have run against this card yet.</div>
      <ul v-else class="session-list">
        <li v-for="session in cardSessions" :key="session.id">
          <button type="button" class="session-row" :class="'status-' + session.status" @click="selectedSessionId = session.id">
            <span class="session-role">{{ session.role }}</span>
            <span class="session-model">{{ session.model || 'default' }}</span>
            <span class="session-status" :class="'s-' + session.status">{{ session.status }}</span>
            <span class="session-time" :title="timestampTitle(session.started_at)">{{ fmtDate(session.started_at) }}</span>
          </button>
        </li>
      </ul>
    </template>

    <div v-else class="conversation-frame">
      <AgentConversationView :session-id="selectedSessionId" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { listAgentSessions, ApiError } from '../../api/client';
import type { AgentSession } from '../../api/types';
import { formatTimestamp, isRecentTimestamp, timestampTitle } from '../../utils/timestamp';
import AgentConversationView from '../agents/AgentConversationView.vue';

const props = defineProps<{ cardId: string }>();

const sessions = ref<AgentSession[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
const selectedSessionId = ref<string | null>(null);

const cardSessions = computed(() =>
  sessions.value.filter((s) => s.card_id === props.cardId || s.goal_card_id === props.cardId),
);

function fmtDate(ts: string): string {
  return ts ? formatTimestamp(ts, isRecentTimestamp(ts) ? 'relative' : 'absolute') : '';
}

async function loadSessions(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const res = await listAgentSessions();
    sessions.value = res.sessions;
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => { void loadSessions(); });
watch(() => props.cardId, () => { selectedSessionId.value = null; void loadSessions(); });
</script>

<style scoped>
.conversations-section { display: flex; flex-direction: column; gap: 10px; }
.conv-header-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.conv-refresh, .conv-back { background: none; border: 1px solid var(--border); border-radius: 4px; padding: 3px 10px; color: var(--accent-2); font-size: 12px; cursor: pointer; font-family: inherit; }
.conv-refresh:disabled { opacity: 0.6; cursor: default; }
.conv-hint, .conv-empty { font-size: 13px; color: var(--text-muted); }
.conv-error { font-size: 12px; color: var(--danger); }
.session-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.session-row { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 8px 12px; background: var(--surface-1); border: 1px solid var(--surface-3); border-left: 3px solid transparent; border-radius: 6px; cursor: pointer; font: inherit; color: var(--text); }
.session-row:hover { border-color: var(--border); }
.session-row.status-active { border-left-color: var(--accent-2); }
.session-row.status-waiting { border-left-color: var(--warn); }
.session-row.status-done { border-left-color: var(--accent); }
.session-row.status-blocked, .session-row.status-failed { border-left-color: var(--danger); }
.session-role { font-size: 12px; font-weight: 600; text-transform: capitalize; }
.session-model { font-size: 11px; color: var(--text-muted); font-family: 'SF Mono', monospace; }
.session-status { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 8px; text-transform: uppercase; }
.session-status.s-active { background: var(--entry-user-bg); color: var(--accent-2); }
.session-status.s-waiting { background: var(--entry-warn-bg); color: var(--warn); }
.session-status.s-done { background: var(--entry-accent-bg); color: var(--accent); }
.session-status.s-blocked, .session-status.s-failed { background: var(--entry-danger-bg); color: var(--danger); }
.session-time { margin-left: auto; font-size: 11px; color: var(--text-muted); font-family: 'SF Mono', monospace; }
.conversation-frame { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; height: 480px; display: flex; flex-direction: column; }
</style>
