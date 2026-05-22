<template>
  <div class="agents-layout">
    <div v-if="selectedSessionId" class="agent-detail-view">
      <div class="detail-header-bar">
        <button class="back-btn" @click="selectedSessionId = null">Back to Agents</button>
        <span class="agent-session-id">{{ selectedSessionId }}</span>
      </div>
      <AgentConversationView :session-id="selectedSessionId" />
    </div>

    <template v-else>
      <div v-if="loading" class="agents-loading">Loading agents...</div>
      <div v-else-if="unauthorized" class="agents-state agents-unauthorized">
        Agent sessions are unavailable until a valid API token is provided.
      </div>
      <div v-else-if="errorMsg" class="agents-state agents-error">{{ errorMsg }}</div>
      <div v-else class="agents-content">
        <div v-if="isStale" class="agents-state agents-stale">
          Agent session data is stale. Refresh or wait for reconnect to resync with the authoritative REST state.
        </div>
        <div v-if="conversationWarning" class="agents-state agents-warning">
          {{ conversationWarning }}
        </div>
        <template v-for="entry in roleEntries" :key="entry.role">
          <div class="role-section">
            <h3 class="role-heading">
              <span class="role-icon">{{ roleIcon(entry.role) }}</span>
              {{ entry.role }}
              <span class="role-count">{{ entry.sessions.length }}</span>
            </h3>
            <div class="session-list">
              <div
                v-for="session in entry.sessions"
                :key="session.id"
                class="session-card"
                :class="'status-' + session.status"
                @click="selectSession(session.id)"
              >
                <div class="session-top">
                  <span class="session-status-dot" :class="'s-' + session.status"></span>
                  <span class="session-model">{{ session.model || 'default' }}</span>
                  <span class="session-status-badge" :class="'s-' + session.status">{{ session.status }}</span>
                </div>
                <div class="session-meta">
                  <span v-if="session.goal_card_id" class="session-goal">Goal: {{ session.goal_card_id }}</span>
                  <span v-if="session.card_id" class="session-card-ref">Card: {{ session.card_id }}</span>
                </div>
                <div class="session-time">
                  Started: <span :title="timestampTitle(session.started_at)">{{ fmtDate(session.started_at) }}</span>
                  <span v-if="session.completed_at"> | Completed: <span :title="timestampTitle(session.completed_at)">{{ fmtDate(session.completed_at) }}</span></span>
                </div>
              </div>
            </div>
          </div>
        </template>
        <div v-if="roleEntries.length === 0" class="agents-empty">No agent sessions recorded yet.</div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useAgentStore } from '../stores/agents';
import type { AgentRole, AgentSession } from '../api/types';
import { createLogger } from '../utils/logger';
import { formatTimestamp, isRecentTimestamp, timestampTitle } from '../utils/timestamp';
import AgentConversationView from '../components/agents/AgentConversationView.vue';

const log = createLogger('view:agents');
const route = useRoute();
const agentStore = useAgentStore();
const { sessionsByRole, loading, error, unauthorized, isStale, conversationWarning } = storeToRefs(agentStore);
const errorMsg = computed(() => error.value);

const selectedSessionId = ref<string | null>(null);

interface RoleEntry { role: AgentRole; sessions: AgentSession[] }
const roleEntries = computed<RoleEntry[]>(() => {
  const entries: RoleEntry[] = [];
  for (const [role, sessions] of sessionsByRole.value) {
    entries.push({ role, sessions });
  }
  return entries;
});

const ROLE_ICONS: Record<string, string> = {
  analyst: '(AN)', planner: '(PL)', executor: '(EX)',
  reviewer: '(RV)', content_supervisor: '(CS)',
};
function roleIcon(role: AgentRole): string { return ROLE_ICONS[role] || '(?)'; }
function fmtDate(ts: string): string { return formatTimestamp(ts, isRecentTimestamp(ts) ? 'relative' : 'absolute'); }

function selectSession(id: string): void { selectedSessionId.value = id; }

watch(() => route.params.id, (nid) => {
  if (nid && typeof nid === 'string') {
    selectedSessionId.value = nid;
  } else {
    selectedSessionId.value = null;
  }
}, { immediate: true });

onMounted(() => {
  agentStore.setupWsListener();
  agentStore.fetchSessions().catch((err) => {
    log.warn('fetchSessions failed', err);
  });
});
</script>

<style scoped>
.agents-layout { height:100%; display:flex; flex-direction:column; }
.agents-loading,.agents-empty,.agents-state { padding:32px; text-align:center; color:#8b949e; font-size:13px; }
.agents-error { color:#f85149; }
.agents-unauthorized { color:#ffb86b; }
.agents-stale { margin:0 16px 12px; padding:12px 16px; border:1px solid #30363d; border-radius:8px; background:#161b22; text-align:left; }
.agents-warning { margin:0 16px 12px; padding:12px 16px; border:1px solid #5a4a1a; border-radius:8px; background:#201a10; color:#ffb86b; text-align:left; }
.agents-content { flex:1; overflow-y:auto; padding:16px; }
.role-section { margin-bottom:20px; }
.role-heading { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; color:#f0f6fc; margin:0 0 10px 0; text-transform:capitalize; }
.role-icon { font-size:11px; color:#8b949e; font-family:'SF Mono',monospace; }
.role-count { font-size:11px; padding:1px 8px; border-radius:10px; background:#21262d; color:#8b949e; }
.session-list { display:flex; flex-direction:column; gap:8px; }
.session-card { padding:12px; background:#161b22; border:1px solid #21262d; border-radius:6px; cursor:pointer; transition:border-color .15s; border-left:3px solid transparent; }
.session-card:hover { border-color:#30363d; }
.session-card.status-active { border-left-color:#58a6ff; }
.session-card.status-waiting { border-left-color:#d29922; }
.session-card.status-done { border-left-color:#3fb950; }
.session-card.status-blocked { border-left-color:#d29922; }
.session-card.status-failed { border-left-color:#f85149; }
.session-top { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.session-status-dot { width:8px; height:8px; border-radius:50%; }
.s-active { background:#58a6ff; }
.s-waiting { background:#d29922; }
.s-done { background:#3fb950; }
.s-blocked { background:#d29922; }
.s-failed { background:#f85149; }
.session-model { font-size:11px; color:#8b949e; font-family:'SF Mono',monospace; }
.session-status-badge { font-size:10px; font-weight:600; padding:1px 6px; border-radius:8px; text-transform:uppercase; }
.session-status-badge.s-active { background:#1c2738; color:#58a6ff; }
.session-status-badge.s-waiting { background:#241f18; color:#d29922; }
.session-status-badge.s-done { background:#1a2418; color:#7ee787; }
.session-status-badge.s-blocked { background:#241f18; color:#d29922; }
.session-status-badge.s-failed { background:#241818; color:#f85149; }
.session-meta { display:flex; gap:12px; font-size:11px; color:#8b949e; margin-bottom:4px; }
.session-goal,.session-card-ref { font-family:'SF Mono',monospace; }
.session-time { font-size:11px; color:#484f58; }
.detail-header-bar { display:flex; align-items:center; gap:12px; padding:8px 16px; background:#161b22; border-bottom:1px solid #30363d; flex-shrink:0; }
.back-btn { background:none; border:1px solid #30363d; border-radius:4px; padding:4px 10px; color:#58a6ff; font-size:12px; cursor:pointer; font-family:inherit; }
.back-btn:hover { background:#21262d; }
.agent-session-id { font-size:11px; color:#484f58; font-family:'SF Mono',monospace; }
.agent-detail-view { height:100%; display:flex; flex-direction:column; overflow:hidden; }
</style>
