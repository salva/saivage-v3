<template>
  <div class="overview-facet" data-testid="facet-overview">
    <section class="overview-section">
      <h3 class="overview-label">Situation</h3>
      <p class="overview-situation" data-testid="overview-situation">
        <StatusBadge v-if="detail" :status="statusForCard(detail.lifecycle.status)" />
        <span class="overview-situation-text">{{ situationText }}</span>
      </p>
      <StatusBanner v-if="detail?.lifecycle.error" tone="danger" title="Card error" :message="detail.lifecycle.error" />
      <p v-if="detail?.lifecycle.completed_at" class="overview-muted">Completed {{ fmtDate(detail.lifecycle.completed_at) }}. Done means accepted work, not independently verified correctness.</p>
    </section>

    <section class="overview-section">
      <h3 class="overview-label">Participants</h3>
      <ViewState v-if="sessionsState.loading && sessionsState.sessions.length === 0" state="loading" title="Loading card sessions" />
      <ViewState v-else-if="sessionsState.error" state="error" title="Card sessions unavailable" :message="sessionsState.error">
        <template #action><button type="button" @click="refreshSessions">Retry</button></template>
      </ViewState>
      <ViewState v-else-if="sessionsState.sessions.length === 0" state="empty" title="No published sessions for this card" message="No named-agent session has run against this card, or none is currently published." />
      <ul v-else class="overview-sessions" data-testid="overview-participants">
        <li v-for="session in sessionsState.sessions" :key="session.id">
          <router-link :to="{ name: 'agent-detail', params: { id: session.id } }">{{ session.agent_name }}</router-link>
          <span class="overview-session-liveness" :data-liveness="`${session.status}-${session.activity}`">{{ livenessPhrase(session.status, session.activity) }}</span>
          <span class="overview-session-pair">{{ session.status }} · {{ session.activity }}</span>
        </li>
      </ul>
      <p class="overview-muted">Liveness meaning comes only from the backend-decorated session summary.</p>
      <p class="overview-action"><router-link :to="{ name: 'card-detail', params: { id: cardId }, query: { facet: 'conversations' } }">Open Conversations facet…</router-link></p>
    </section>

    <section class="overview-section">
      <h3 class="overview-label">Latest result</h3>
      <template v-if="detail?.lifecycle?.result">
        <p class="overview-result-line" data-testid="overview-result-line">Accepted result — {{ resultOneLiner(detail.lifecycle.result) }}</p>
        <p class="overview-result-context">kind {{ detail.lifecycle.result.kind }}<template v-if="detail.lifecycle.result.terminal"> · terminal {{ detail.lifecycle.result.terminal }}</template></p>
        <details class="overview-result">
          <summary>Full recorded result (JSON)</summary>
          <CodeBlock :code="formatJson(detail.lifecycle.result)" language="json" copyable />
        </details>
      </template>
      <p v-else class="overview-muted" data-testid="overview-no-result">No accepted result is recorded for this card.</p>
      <p class="overview-action"><router-link :to="{ name: 'card-detail', params: { id: cardId }, query: { facet: 'conversations' } }">Open latest activity in Conversations…</router-link></p>
    </section>

    <section class="overview-section">
      <h3 class="overview-label">Declared records</h3>
      <ViewState v-if="recordDescriptorsLoading" state="loading" title="Loading record declarations" />
      <ViewState v-else-if="recordDescriptorsError" state="error" title="Record declarations unavailable" :message="recordDescriptorsError" />
      <template v-else-if="recordDescriptors.length > 0">
        <ul class="overview-records" data-testid="overview-records">
          <li v-for="descriptor in recordDescriptors" :key="descriptor.name">
            {{ descriptor.name }}<span v-if="descriptor.bootstrap"> (bootstrap)</span>
            <span class="overview-record-state">{{ recordStateLabel(descriptor) }}</span>
          </li>
        </ul>
        <p class="overview-action"><router-link :to="{ name: 'card-detail', params: { id: cardId }, query: { facet: 'records' } }">Open Records &amp; History…</router-link></p>
      </template>
      <p v-else class="overview-muted">This card type declares no records.</p>
    </section>

    <section class="overview-section">
      <h3 class="overview-label">Represented children and siblings</h3>
      <p v-if="siblings.length === 0 && children.length === 0" class="overview-muted">No represented children or loaded sibling slice.</p>
      <template v-if="children.length > 0">
        <h4 class="overview-sublabel">Children (committed order)</h4>
        <ul class="overview-cards" data-testid="overview-children">
          <li v-for="child in children" :key="child.id">
            <router-link :to="{ name: 'card-detail', params: { id: child.id } }">{{ child.title }}</router-link>
            <span class="overview-card-status">{{ child.status }}</span>
          </li>
        </ul>
      </template>
      <template v-if="siblings.length > 1">
        <h4 class="overview-sublabel">Siblings in this parent's accepted slice</h4>
        <ul class="overview-cards" data-testid="overview-siblings">
          <li v-for="sibling in siblings" :key="sibling.id" :data-selected="sibling.id === cardId || undefined">
            <router-link :to="{ name: 'card-detail', params: { id: sibling.id } }">{{ sibling.title }}</router-link>
            <span class="overview-card-status">{{ sibling.status }}</span>
          </li>
        </ul>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import type { CardDetail, CardHierarchyRecord, CardRecordDescriptor } from '../../api/types';
import { cardRouteChain, useCardStore } from '../../stores/cards';
import { useCardAgentSessionsStore } from '../../stores/cardAgentSessions';
import { useSyncStore } from '../../stores/sync';
import { formatRecentTimestamp } from '../../utils/timestamp';
import { statusForCard } from '../../utils/status';
import { formatJson } from '../../utils/format-json';
import { livenessPhrase, resultOneLiner } from '../../utils/legibility';
import CodeBlock from '../content/CodeBlock.vue';
import StatusBadge from '../ui/StatusBadge.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import ViewState from '../ui/ViewState.vue';

const props = defineProps<{ cardId: string; detail: CardDetail | null }>();

const cardStore = useCardStore();
const cardSessionsStore = useCardAgentSessionsStore();
const liveSync = useSyncStore();
const { recordDescriptors, recordDescriptorsLoading, recordDescriptorsError } = storeToRefs(cardStore);

const sessionsState = computed(() => cardSessionsStore.scope(props.cardId));
let closeSessions: (() => void) | null = null;
const leaseReady = ref(false);

function openScope(): void {
  leaseReady.value = false;
  closeSessions?.();
  closeSessions = liveSync.openCardAgentSessions(props.cardId, async () => {
    leaseReady.value = true;
    await cardSessionsStore.fetchScope(props.cardId).catch(() => {});
  });
}
function refreshSessions(): void {
  void cardSessionsStore.fetchScope(props.cardId).catch(() => {});
}
onMounted(openScope);
watch(() => props.cardId, openScope);
onUnmounted(() => {
  closeSessions?.();
  cardSessionsStore.release(props.cardId);
});

function loadDeclarations(): void {
  try { void cardStore.loadRecordDescriptors(props.cardId).catch(() => {}); } catch { /* selection does not own this card yet */ }
}
onMounted(loadDeclarations);
watch(() => props.cardId, loadDeclarations);

const situationText = computed(() => {
  if (!props.detail) return 'Card detail is unavailable.';
  const map: Record<string, string> = {
    backlog: 'Planned but not started.',
    running: 'Running. Status records may be incomplete until the active work finishes.',
    blocked: 'Blocked. Check blockers, tool errors, review findings, and notes before retrying.',
    changed: 'Changed; needs planner attention before completion can proceed.',
    stopped: 'Stopped after its prior live process was discarded. It remains inactive until explicitly activated.',
    done: 'Marked done. Review status and review records before treating it as accepted.',
    failed: 'Failed. Inspect error, status records, and agent/review context.',
    cancelled: 'Cancelled; should not be treated as completed work.',
  };
  return map[props.detail.lifecycle.status] ?? '';
});

function recordStateLabel(descriptor: CardRecordDescriptor): string {
  if (!descriptor.current) return 'not yet published';
  if (descriptor.current.state === 'discarded') return 'discarded';
  if (descriptor.current.draft_present) return `draft on v${descriptor.current.head_version}`;
  return `v${descriptor.current.head_version}`;
}

const children = computed<readonly CardHierarchyRecord[]>(() => cardStore.loadedChildrenFor(props.cardId) ?? []);
const siblings = computed<readonly CardHierarchyRecord[]>(() => {
  const chain = cardRouteChain(props.cardId);
  const parent = chain.length >= 2 ? chain[chain.length - 2] : 'project';
  return cardStore.loadedChildrenFor(parent) ?? [];
});

function fmtDate(ts: string): string { return ts ? formatRecentTimestamp(ts) : ''; }
</script>

<style scoped>
.overview-facet { display: flex; flex-direction: column; gap: 0; }
.overview-section { padding: 14px 16px; border-bottom: 1px solid var(--surface-3); }
.overview-label { margin: 0 0 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
.overview-sublabel { margin: 10px 0 4px; font-size: 11px; color: var(--text-muted); }
.overview-situation { margin: 0; display: flex; align-items: center; gap: 8px; }
.overview-situation-text { font-size: 12px; color: var(--text-muted); }
.overview-muted { margin: 6px 0 0; font-size: 11px; color: var(--text-muted); }
.overview-sessions, .overview-records, .overview-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.overview-sessions li, .overview-records li, .overview-cards li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
.overview-sessions a, .overview-cards a { color: var(--accent-2); text-decoration: underline; }
.overview-session-liveness { font-size: 12px; color: var(--text); font-weight: 600; }
.overview-session-liveness[data-liveness='active-busy'] { color: var(--accent); }
.overview-session-pair { font-size: 11px; color: var(--text-muted); }
.overview-record-state { font-size: 11px; color: var(--text-muted); }
.overview-card-status { font-size: 11px; color: var(--text-muted); }
.overview-cards li[data-selected] { font-weight: 700; }
.overview-action { margin: 8px 0 0; font-size: 12px; }
.overview-action a { color: var(--accent-2); text-decoration: underline; }
.overview-result-line { margin: 0; font-size: 12px; font-weight: 600; color: var(--text); }
.overview-result-context { margin: 2px 0 4px; font-size: 11px; color: var(--text-muted); }
.overview-result > summary { cursor: pointer; font-size: 12px; color: var(--text-muted); }
.overview-result { margin-top: 4px; }
.overview-section > :deep(.view-state) { padding: 8px 0; }
.overview-section > :deep(.status-banner) { margin: 8px 0 0; }
</style>
