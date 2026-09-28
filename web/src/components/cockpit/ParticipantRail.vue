<template>
  <aside class="participant-rail" aria-label="Card participants">
    <h3 class="rail-label">Participants</h3>
    <ViewState v-if="state.loading && state.sessions.length === 0" state="loading" title="Loading card sessions" />
    <ViewState v-else-if="state.error" state="error" title="Card sessions unavailable" :message="state.error">
      <template #action><button type="button" @click="refresh">Retry</button></template>
    </ViewState>
    <ViewState v-else-if="state.sessions.length === 0" state="empty" title="No published sessions" message="No named-agent session has run against this card, or none is currently published." />
    <template v-else>
      <div v-for="group in railGroups" :key="group.agentName" class="rail-group">
        <h4 class="rail-group-label">{{ group.agentName }}</h4>
        <p v-for="nodeId in group.configuredNodes" :key="nodeId" class="rail-node-label">Configured node/role: <span class="mono">{{ nodeId }}</span></p>
        <button
          v-for="session in group.sessions"
          :key="session.id"
          type="button"
          class="rail-session"
          :class="{ selected: session.id === selectedSessionId }"
          :aria-pressed="session.id === selectedSessionId"
          :title="session.id"
          @click="emit('select', session.id)"
        >
          <span class="rail-session-head">
            <span class="rail-session-liveness" :data-liveness="`${session.status}-${session.activity}`">{{ livenessPhrase(session.status, session.activity) }}</span>
            <span class="rail-session-started">started {{ fmtDate(session.started_at) }}</span>
          </span>
          <span class="rail-session-pair">{{ session.status }} · {{ session.activity }}</span>
          <span class="rail-session-identity mono">{{ session.id }}</span>
        </button>
      </div>
      <p v-if="hasUnassociatedMetadata" class="rail-note">Sessions without a configured node assignment in the current compiled graph remain listed under their exact agent identity, unassociated.</p>
    </template>
    <p class="rail-note">Liveness meaning comes only from backend-decorated session summaries; configured node labels are workflow facts, not execution.</p>
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import type { CardDetail } from '../../api/types';
import type { ConversationSessionId } from '../../api/contracts';
import { useCardAgentSessionsStore } from '../../stores/cardAgentSessions';
import { useSyncStore } from '../../stores/sync';
import { useDebugStore } from '../../stores/debug';
import { formatRecentTimestamp } from '../../utils/timestamp';
import { livenessPhrase } from '../../utils/legibility';
import ViewState from '../ui/ViewState.vue';

const props = defineProps<{ cardId: string; detail: CardDetail | null; selectedSessionId: ConversationSessionId | null }>();
const emit = defineEmits<{
  select: [id: ConversationSessionId];
  'auto-select': [id: ConversationSessionId];
}>();

const cardSessionsStore = useCardAgentSessionsStore();
const liveSync = useSyncStore();
const debugStore = useDebugStore();
const { graphs } = storeToRefs(debugStore);

const state = computed(() => cardSessionsStore.scope(props.cardId));
let close: (() => void) | null = null;
let focusedOnce = false;

interface RailGroup {
  agentName: string;
  sessions: ReturnType<typeof cardSessionsStore.scope>['sessions'];
  configuredNodes: string[];
}

const railGroups = computed<RailGroup[]>(() => {
  const graph = graphs.value?.find((candidate) => candidate.card_type === props.detail?.type) ?? null;
  const byAgent = new Map<string, RailGroup>();
  for (const session of state.value.sessions) {
    const group = byAgent.get(session.agent_name) ?? { agentName: session.agent_name, sessions: [], configuredNodes: [] };
    group.sessions.push(session);
    byAgent.set(session.agent_name, group);
  }
  if (graph) {
    for (const group of byAgent.values()) {
      group.configuredNodes = graph.nodes
        .filter((node) => node.agent_name === group.agentName)
        .map((node) => node.node_id);
    }
  }
  return [...byAgent.values()];
});

const hasUnassociatedMetadata = computed(() => railGroups.value.some((group) => group.configuredNodes.length === 0));

async function observeScopeAndMaybeFocus(): Promise<void> {
  const cardId = props.cardId;
  try {
    await cardSessionsStore.fetchScope(cardId);
  } catch {
    return;
  }
  if (props.cardId !== cardId) return;
  maybeFocusSoleActiveMember();
}

function refresh(): void {
  void observeScopeAndMaybeFocus();
}

function openScope(): void {
  focusedOnce = false;
  close?.();
  close = liveSync.openCardAgentSessions(props.cardId, async () => {
    await observeScopeAndMaybeFocus();
  });
}

function maybeFocusSoleActiveMember(): void {
  if (focusedOnce || props.selectedSessionId) return;
  const active = state.value.sessions.filter((session) => session.status === 'active');
  focusedOnce = true;
  if (active.length === 1 && active[0]) emit('auto-select', active[0].id);
}

function fmtDate(ts: string): string { return ts ? formatRecentTimestamp(ts) : ''; }

onMounted(() => {
  if (graphs.value === null) void debugStore.fetchGraphs().catch(() => {});
  openScope();
});
watch(() => props.cardId, openScope);
onUnmounted(() => {
  close?.();
  cardSessionsStore.release(props.cardId);
});
</script>

<style scoped>
.participant-rail { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; padding: 12px; background: var(--bg); }
.rail-label { margin: 0 0 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
.rail-group { margin-bottom: 14px; }
.rail-group-label { margin: 0 0 4px; font-size: 12px; font-weight: 700; color: var(--text); text-transform: capitalize; }
.rail-node-label { margin: 0 0 4px; font-size: 10px; color: var(--text-muted); }
.rail-node-label .mono { font-family: var(--font-mono); }
.rail-session {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; box-sizing: border-box;
  padding: 6px 8px; margin-bottom: 4px; border: 1px solid var(--surface-3); border-left: 3px solid transparent;
  border-radius: 6px; background: var(--surface-1); cursor: pointer; text-align: left; font: inherit;
}
.rail-session:hover { border-color: var(--border); }
.rail-session.selected { border-left-color: var(--accent-2); background: var(--entry-user-bg); }
.rail-session-head { display: flex; align-items: baseline; gap: 8px; width: 100%; }
.rail-session-liveness { font-size: 12px; color: var(--text); font-weight: 600; }
.rail-session-liveness[data-liveness='active-busy'] { color: var(--accent); }
.rail-session-started { font-size: 10px; color: var(--border-strong); margin-left: auto; }
.rail-session-pair { font-size: 10px; color: var(--text-muted); }
.rail-session-identity { font-size: 10px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.rail-note { margin: 8px 0 0; font-size: 10px; color: var(--text-muted); line-height: 1.4; }
.participant-rail > :deep(.view-state) { padding: 12px 4px; }
.mono { font-family: var(--font-mono); }
</style>
