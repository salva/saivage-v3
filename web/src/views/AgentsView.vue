<template>
  <div class="agents-layout">
    <div v-if="selectedSessionId" class="agent-detail-view">
      <div class="detail-header-bar">
        <button class="back-btn" @click="backToAgents">Back to Agents</button>
        <span class="agent-session-id">{{ selectedSessionId }}</span>
      </div>
      <AgentConversationView :session-id="selectedSessionId" />
    </div>

    <template v-else>
      <ViewState v-if="loading" class="agents-loading" state="loading" title="Loading agents" />
      <ViewState v-else-if="unauthorized" class="agents-unauthorized" state="unauthorized" title="Agent sessions unavailable" message="Provide a valid API token to load agent sessions." />
      <ViewState v-else-if="errorMsg" class="agents-error" state="error" title="Could not load agents" :message="errorMsg" />
      <div v-else class="agents-content">
        <StatusBanner v-if="isStale" class="agents-stale" tone="stale" message="Agent session data is stale. Refresh or wait for reconnect to resync with the authoritative REST state." />
        <StatusBanner v-if="conversationWarning" tone="warning" :message="conversationWarning" />
        <template v-for="entry in roleEntries" :key="entry.role">
          <div class="role-section">
            <h3 class="role-heading">
              <span class="role-icon">{{ roleIcon(entry.role) }}</span>
              {{ entry.role }}
              <span class="role-count">{{ entry.sessions.length }}</span>
            </h3>
            <div class="session-list">
              <SelectableRow
                v-for="session in entry.sessions"
                :key="session.id"
                class="session-card"
                :class="'status-' + session.status"
                @select="selectSession(session.id)"
              >
                <div class="session-top">
                  <span class="session-model">{{ session.model || 'default' }}</span>
                  <StatusBadge :status="statusForAgentSession(session.status)" show-dot />
                </div>
                <div class="session-meta">
                  <span v-if="session.goal_card_id" class="session-goal">Goal: {{ session.goal_card_id }}</span>
                  <span v-if="session.card_id" class="session-card-ref">Card: {{ session.card_id }}</span>
                </div>
                <div class="session-time">
                  Started: <span :title="timestampTitle(session.started_at)">{{ fmtDate(session.started_at) }}</span>
                  <span v-if="session.completed_at"> | Completed: <span :title="timestampTitle(session.completed_at)">{{ fmtDate(session.completed_at) }}</span></span>
                </div>
              </SelectableRow>
            </div>
          </div>
        </template>
        <ViewState v-if="roleEntries.length === 0" class="agents-empty" state="empty" title="No agent sessions recorded yet" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useAgentStore } from '../stores/agents';
import type { AgentRole, AgentSession } from '../types/view-models';
import { createLogger } from '../utils/logger';
import { formatTimestamp, isRecentTimestamp, timestampTitle } from '../utils/timestamp';
import { statusForAgentSession } from '../utils/status';
import AgentConversationView from '../components/agents/AgentConversationView.vue';
import SelectableRow from '../components/ui/SelectableRow.vue';
import StatusBadge from '../components/ui/StatusBadge.vue';
import StatusBanner from '../components/ui/StatusBanner.vue';
import ViewState from '../components/ui/ViewState.vue';

const log = createLogger('view:agents');
const route = useRoute();
const router = useRouter();
const agentStore = useAgentStore();
const { sessionsByRole, loading, error, unauthorized, isStale, conversationWarning } = storeToRefs(agentStore);
const errorMsg = computed(() => error.value);

const selectedSessionId = computed(() => typeof route.params.id === 'string' ? route.params.id : null);

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

function selectSession(id: string): void { void router.push({ name: 'agent-detail', params: { id } }); }
function backToAgents(): void { void router.push({ name: 'agents' }); }

onMounted(() => {
  agentStore.fetchSessions().catch((err) => {
    log.warn('fetchSessions failed', err);
  });
});
</script>

<style scoped>
.agents-layout { height:100%; display:flex; flex-direction:column; }
.agents-layout > :deep(.view-state) { padding:32px; justify-content:center; text-align:center; }
.agents-content { flex:1; overflow-y:auto; padding:16px; }
.agents-content > :deep(.status-banner) { margin:0 0 12px; }
.role-section { margin-bottom:20px; }
.role-heading { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; color:var(--text); margin:0 0 10px 0; text-transform:capitalize; }
.role-icon { font-size:11px; color:var(--text-muted); font-family:'SF Mono',monospace; }
.role-count { font-size:11px; padding:1px 8px; border-radius:10px; background:var(--surface-3); color:var(--text-muted); }
.session-list { display:flex; flex-direction:column; gap:8px; }
.session-card { display:block; padding:12px; background:var(--surface-1); border:1px solid var(--surface-3); border-radius:6px; transition:border-color .15s; border-left:3px solid transparent; }
.session-card:hover { border-color:var(--border); }
.session-card.status-active { border-left-color:var(--accent-2); }
.session-card.status-waiting { border-left-color:var(--warn); }
.session-card.status-done { border-left-color:var(--accent); }
.session-card.status-blocked { border-left-color:var(--warn); }
.session-card.status-failed { border-left-color:var(--danger); }
.session-top { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.session-model { font-size:11px; color:var(--text-muted); font-family:'SF Mono',monospace; }
.session-meta { display:flex; gap:12px; font-size:11px; color:var(--text-muted); margin-bottom:4px; }
.session-goal,.session-card-ref { font-family:'SF Mono',monospace; }
.session-time { font-size:11px; color:var(--border-strong); }
.detail-header-bar { display:flex; align-items:center; gap:12px; padding:8px 16px; background:var(--surface-1); border-bottom:1px solid var(--border); flex-shrink:0; }
.back-btn { background:none; border:1px solid var(--border); border-radius:4px; padding:4px 10px; color:var(--accent-2); font-size:12px; cursor:pointer; font-family:inherit; }
.back-btn:hover { background:var(--surface-3); }
.agent-session-id { font-size:11px; color:var(--border-strong); font-family:'SF Mono',monospace; }
.agent-detail-view { height:100%; display:flex; flex-direction:column; overflow:hidden; }
</style>
