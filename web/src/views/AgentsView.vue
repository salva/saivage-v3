<template>
  <div data-testid="route-agents">
    <EntityInspectorShell
      :selected="routeSession.kind !== 'none'"
      list-label="Agent sessions"
      detail-label="Agent conversation"
      empty-title="Select an agent session to inspect"
      back-label="Back to Agents"
      :detail-title="selectedSessionId"
      @back="backToAgents"
    >
      <template #list>
      <ViewState v-if="sessionsLoading" class="agents-loading" state="loading" title="Loading agents" />
      <ViewState v-else-if="sessionsUnauthorized && !agentStore.sessionsLoaded" class="agents-unauthorized" state="unauthorized" title="Agent sessions unavailable" message="Provide a valid API token to load agent sessions." />
      <ViewState v-else-if="errorMsg" class="agents-error" state="error" title="Could not load agents" :message="errorMsg" />
      <div v-else class="agents-content">
        <StatusBanner v-if="isStale" class="agents-stale" tone="stale" message="Agent session data is stale. Refresh or wait for reconnect to resync with the authoritative REST state." />
        <StatusBanner v-if="sessionsRefreshError" tone="warning" :message="sessionsRefreshError" />
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
                :selected="selectedSessionId === session.id"
                @select="selectSession(session.id)"
              >
                <div class="session-top">
                  <span class="session-model">{{ session.model || 'default' }}</span>
                  <StatusBadge :status="statusForAgentSession(session.status)" show-dot />
                </div>
                <div class="session-meta">
                  <button v-if="session.goal_card_id" type="button" class="session-card-link" @click.stop="goToCard(session.goal_card_id!)">{{ cardTitle(session.goal_card_id) }}</button>
                  <button v-if="session.card_id && session.card_id !== session.goal_card_id" type="button" class="session-card-link" @click.stop="goToCard(session.card_id!)">{{ cardTitle(session.card_id) }}</button>
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

      <template #detail>
        <ViewState v-if="routeSession.kind === 'invalid'" state="error" title="Invalid agent session" message="The route does not contain a canonical agent session identity." />
        <AgentConversationView v-else-if="selectedSessionId" :key="selectedSessionId" :session-id="selectedSessionId" />
      </template>
    </EntityInspectorShell>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useAgentStore } from '../stores/agents';
import { useCardStore } from '../stores/cards';
import type { AgentRole, AgentSession } from '../types/view-models';
import type { ConversationSessionId } from '../api/contracts';
import { parseAgentDetailRouteParam } from '../router/agent-session-route';
import { formatTimestamp, isRecentTimestamp, timestampTitle } from '../utils/timestamp';
import { statusForAgentSession } from '../utils/status';
import AgentConversationView from '../components/agents/AgentConversationView.vue';
import EntityInspectorShell from '../components/layout/EntityInspectorShell.vue';
import SelectableRow from '../components/ui/SelectableRow.vue';
import StatusBadge from '../components/ui/StatusBadge.vue';
import StatusBanner from '../components/ui/StatusBanner.vue';
import ViewState from '../components/ui/ViewState.vue';

const route = useRoute();
const router = useRouter();
const agentStore = useAgentStore();
const cardStore = useCardStore();
const { sessionsByRole, sessionsLoading, sessionsError, sessionsRefreshError, sessionsUnauthorized, isStale } = storeToRefs(agentStore);
const errorMsg = computed(() => sessionsError.value);

const routeSession = computed(() => parseAgentDetailRouteParam(route.params.id));
const selectedSessionId = computed(() => routeSession.value.kind === 'valid' ? routeSession.value.sessionId : null);

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

function selectSession(id: ConversationSessionId): void { void router.push({ name: 'agent-detail', params: { id } }); }
function backToAgents(): void { void router.push({ name: 'agents' }); }
function goToCard(id: string): void { void router.push({ name: 'card-detail', params: { id } }); }
function cardTitle(id: string | null | undefined): string {
  if (!id) return '';
  const card = cardStore.cards.find((c) => c.id === id);
  return card?.title ?? id;
}

</script>

<style scoped>
.agents-content { flex:1; overflow-y:auto; padding:16px; }
.agents-content > :deep(.status-banner) { margin:0 0 12px; }
.agents-loading, .agents-unauthorized, .agents-error { padding:32px; justify-content:center; text-align:center; }
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
.session-meta { display:flex; gap:var(--space-4); font-size:var(--font-size-sm); margin-bottom:var(--space-2); flex-wrap:wrap; }
.session-card-link { background:none; border:none; cursor:pointer; font:inherit; font-size:var(--font-size-sm); color:var(--accent-2); text-decoration:underline; padding:0; }
.session-card-link:hover { color:var(--accent); }
.session-time { font-size:11px; color:var(--border-strong); }
</style>
