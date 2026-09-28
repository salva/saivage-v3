<template>
  <div class="overview-facet" data-testid="facet-overview">
    <section class="overview-section" data-testid="overview-objective">
      <h3 class="overview-label">Objective</h3>
      <ViewState v-if="recordDescriptorsLoading && !bootstrapDescriptor" state="loading" title="Loading objective source" />
      <ViewState v-else-if="recordDescriptorsError" state="error" title="Objective source unavailable" :message="recordDescriptorsError">
        <template #action><button type="button" @click="retryDescriptors">Retry</button></template>
      </ViewState>
      <CardRecordPreview
        v-else-if="bootstrapDescriptor"
        :descriptor="bootstrapDescriptor"
        :slot="recordSlot(bootstrapDescriptor.name)"
        :source-label="`From ${bootstrapDescriptor.name}`"
        @retry="retryRecord"
      />
      <p v-else class="overview-error" role="alert">The required bootstrap record declaration is unavailable.</p>
    </section>

    <section class="overview-section">
      <h3 class="overview-label">Activity and participants</h3>
      <ViewState v-if="sessionsState.loading && sessionsState.sessions.length === 0" state="loading" title="Loading card sessions" />
      <ViewState v-else-if="sessionsState.error && sessionsState.sessions.length === 0" state="error" title="Card sessions unavailable" :message="sessionsState.error">
        <template #action><button type="button" @click="refreshSessions">Retry</button></template>
      </ViewState>
      <template v-else-if="sessionsState.sessions.length">
        <p v-if="sessionsState.error" class="overview-stale" role="alert">Last loaded sessions remain visible. Refresh failed: {{ sessionsState.error }} <button type="button" @click="refreshSessions">Retry</button></p>
        <ul class="overview-sessions" data-testid="overview-participants">
          <li v-for="session in sessionsState.sessions" :key="session.id">
            <router-link :to="{ name: 'agent-detail', params: { id: session.id } }">{{ session.agent_name }}</router-link>
            <span class="overview-session-liveness" :data-liveness="`${session.status}-${session.activity}`">{{ livenessPhrase(session.status, session.activity) }}</span>
            <details class="session-details">
              <summary>Session details</summary>
              <span class="mono">{{ session.status }} · {{ session.activity }}</span>
            </details>
          </li>
        </ul>
      </template>
      <ViewState v-else state="empty" title="No published sessions" message="No session is currently published for this card; this does not prove that nobody has ever worked on it." />
      <p class="overview-action"><router-link :to="{ name: 'card-detail', params: { id: cardId }, query: { facet: 'conversations' } }">Open Conversations…</router-link></p>
    </section>

    <section class="overview-section" data-testid="overview-results-records">
      <h3 class="overview-label">Recorded result and records</h3>
      <template v-if="detail?.lifecycle.result">
        <p class="overview-result-line" data-testid="overview-result-line">Recorded result — {{ resultOneLiner(detail.lifecycle.result) }}</p>
        <p v-if="detail.lifecycle.status === 'done'" class="overview-muted">Accepted as done; not independently verified correctness.</p>
        <p v-else-if="detail.lifecycle.status === 'failed' && detail.lifecycle.completed_at" class="overview-muted">Ended {{ fmtDate(detail.lifecycle.completed_at) }}.</p>
        <details class="overview-result">
          <summary>Full recorded result and provenance (JSON)</summary>
          <CodeBlock :code="formatJson(detail.lifecycle.result)" language="json" copyable />
        </details>
      </template>
      <p v-else class="overview-muted" data-testid="overview-no-result">No result recorded.</p>

      <div v-if="nonBootstrapDescriptors.length" class="overview-records" data-testid="overview-records">
        <article v-for="descriptor in nonBootstrapDescriptors" :key="descriptor.name" class="overview-record">
          <h4>{{ descriptor.name }}</h4>
          <CardRecordPreview
            :descriptor="descriptor"
            :slot="recordSlot(descriptor.name)"
            :source-label="descriptor.name"
            @retry="retryRecord"
          />
        </article>
      </div>
      <p v-else-if="!recordDescriptorsLoading && !recordDescriptorsError" class="overview-muted">No additional records are declared.</p>
      <p class="overview-action"><router-link :to="{ name: 'card-detail', params: { id: cardId }, query: { facet: 'records' } }">Records &amp; History</router-link></p>
    </section>

    <section class="overview-section" data-testid="overview-problems">
      <h3 class="overview-label">Problems and waiting</h3>
      <StatusBanner v-if="detail?.lifecycle.error" tone="danger" title="Reported card error" :message="detail.lifecycle.error" />
      <p v-else class="overview-muted">No card error reported.</p>
      <p v-if="detail?.lifecycle.result && (detail.lifecycle.status === 'blocked' || detail.lifecycle.status === 'failed')" class="overview-muted">The recorded result above contains the reported outcome.</p>
      <p v-else-if="reasonIsUnavailable" class="overview-muted">No reason is supplied by the current card detail; records and conversations may provide context.</p>
    </section>

    <section class="overview-section" data-testid="overview-related-work">
      <h3 class="overview-label">Parent and related work</h3>
      <p v-if="cardId === 'project'" class="overview-parent">Project root</p>
      <p v-else-if="parentCard" class="overview-parent">Parent: <router-link :to="{ name: 'card-detail', params: { id: parentCard.id } }">{{ parentCard.title }}</router-link></p>
      <p v-else class="overview-muted">The represented parent is not loaded.</p>

      <div class="overview-related-group">
        <h4>Child work</h4>
        <p v-if="childState.stale" class="overview-stale">Showing the last loaded child list. {{ childState.refreshError }}</p>
        <p v-if="childState.status === 'undiscovered'" class="overview-muted">Child work has not been requested.</p>
        <p v-else-if="childState.status === 'loading'" class="overview-muted">Loading child work…</p>
        <p v-else-if="childState.status === 'error'" class="overview-error">Child work could not be loaded: {{ childState.error }} <button type="button" @click="retryChildren(cardId)">Retry</button></p>
        <p v-else-if="childState.status === 'confirmed-leaf'" class="overview-muted">No child work is recorded in the loaded hierarchy.</p>
        <ul v-else class="overview-cards" data-testid="overview-children">
          <li v-for="child in children" :key="child.id">
            <router-link :to="{ name: 'card-detail', params: { id: child.id } }">{{ child.title }}</router-link>
            <span class="overview-card-status">{{ child.status }}</span>
          </li>
        </ul>
      </div>

      <div v-if="cardId !== 'project' && parentCard" class="overview-related-group">
        <h4>Other work under {{ parentCard.title }}</h4>
        <p v-if="siblingState.stale" class="overview-stale">Showing the last loaded sibling list. {{ siblingState.refreshError }}</p>
        <p v-if="siblingState.status === 'undiscovered'" class="overview-muted">Other work under this parent has not been requested.</p>
        <p v-else-if="siblingState.status === 'loading'" class="overview-muted">Loading other work…</p>
        <p v-else-if="siblingState.status === 'error'" class="overview-error">Other work could not be loaded: {{ siblingState.error }} <button type="button" @click="retryChildren(parentId)">Retry</button></p>
        <p v-else-if="siblings.length === 0" class="overview-muted">No other work is present in the loaded hierarchy.</p>
        <ul v-else class="overview-cards" data-testid="overview-siblings">
          <li v-for="sibling in siblings" :key="sibling.id">
            <router-link :to="{ name: 'card-detail', params: { id: sibling.id } }">{{ sibling.title }}</router-link>
            <span class="overview-card-status">{{ sibling.status }}</span>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import type { CardDetail, CardHierarchyRecord, CardRecordDescriptor, LiveSyncCardRecordName } from '../../api/types';
import { cardRouteChain, useCardStore, type RecordSlotState } from '../../stores/cards';
import { useCardAgentSessionsStore } from '../../stores/cardAgentSessions';
import { useSyncStore } from '../../stores/sync';
import { formatRecentTimestamp } from '../../utils/timestamp';
import { formatJson } from '../../utils/format-json';
import { livenessPhrase, resultOneLiner } from '../../utils/legibility';
import CodeBlock from '../content/CodeBlock.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import ViewState from '../ui/ViewState.vue';
import CardRecordPreview from './CardRecordPreview.vue';

const props = defineProps<{ cardId: string; detail: CardDetail | null }>();
const cardStore = useCardStore();
const cardSessionsStore = useCardAgentSessionsStore();
const liveSync = useSyncStore();
const { cardRecords, recordDescriptors, recordDescriptorsLoading, recordDescriptorsError } = storeToRefs(cardStore);

const sessionsState = computed(() => cardSessionsStore.scope(props.cardId));
let closeSessions: (() => void) | null = null;
function openScope(): void {
  closeSessions?.();
  closeSessions = liveSync.openCardAgentSessions(props.cardId, async () => {
    await cardSessionsStore.fetchScope(props.cardId).catch(() => {});
  });
}
function refreshSessions(): void { void cardSessionsStore.fetchScope(props.cardId).catch(() => {}); }
onMounted(openScope);
watch(() => props.cardId, openScope);
onUnmounted(() => { closeSessions?.(); cardSessionsStore.release(props.cardId); });

let recordsRequestedFor: string | null = null;
function requestRecordsIfReady(): void {
  if (props.detail?.id !== props.cardId || recordsRequestedFor === props.cardId) return;
  recordsRequestedFor = props.cardId;
  void cardStore.loadCardRecords(props.cardId).catch(() => {});
}
watch(() => [props.cardId, props.detail?.id] as const, () => {
  if (recordsRequestedFor !== props.cardId) recordsRequestedFor = null;
  requestRecordsIfReady();
}, { immediate: true });

async function retryDescriptors(): Promise<void> {
  await cardStore.loadRecordDescriptors(props.cardId).catch(() => {});
  if (!cardStore.recordDescriptorsError) await cardStore.loadCardRecords(props.cardId).catch(() => {});
}
function retryRecord(name: LiveSyncCardRecordName): void { void cardStore.retryRecord(name).catch(() => {}); }
function recordSlot(name: LiveSyncCardRecordName): RecordSlotState | null { return cardRecords.value[name] ?? null; }

const bootstrapDescriptor = computed<CardRecordDescriptor | null>(() => recordDescriptors.value.find((descriptor) => descriptor.bootstrap) ?? null);
const nonBootstrapDescriptors = computed(() => recordDescriptors.value.filter((descriptor) => !descriptor.bootstrap));
const reasonIsUnavailable = computed(() => !!props.detail && ['running', 'changed', 'stopped', 'cancelled'].includes(props.detail.lifecycle.status));

const chain = computed(() => cardRouteChain(props.cardId));
const parentId = computed(() => chain.value.length > 1 ? chain.value.at(-2)! : 'project');
const parentCard = computed<CardHierarchyRecord | null>(() => props.cardId === 'project' ? null : cardStore.hierarchyCardById(parentId.value));
const children = computed<readonly CardHierarchyRecord[]>(() => cardStore.loadedChildrenFor(props.cardId) ?? []);
const childState = computed(() => cardStore.childrenLoadState(props.cardId));
const siblingState = computed(() => cardStore.childrenLoadState(parentId.value));
const siblings = computed<readonly CardHierarchyRecord[]>(() => (cardStore.loadedChildrenFor(parentId.value) ?? []).filter((card) => card.id !== props.cardId));
function retryChildren(id: string): void { void cardStore.retryChildren(id).catch(() => {}); }
function fmtDate(ts: string): string { return formatRecentTimestamp(ts); }
</script>

<style scoped>
.overview-facet { display: flex; flex-direction: column; min-width: 0; }
.overview-section { padding: 14px 16px; border-bottom: 1px solid var(--surface-3); min-width: 0; }
.overview-label { margin: 0 0 9px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
.overview-muted, .overview-error, .overview-stale { margin: 6px 0 0; font-size: 11px; color: var(--text-muted); }
.overview-error { color: var(--danger); }
.overview-stale { color: var(--warn); }
.overview-sessions, .overview-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.overview-sessions li, .overview-cards li { display: flex; align-items: baseline; flex-wrap: wrap; gap: 7px; font-size: 12px; }
.overview-sessions a, .overview-cards a, .overview-parent a { color: var(--accent-2); text-decoration: underline; }
.overview-session-liveness { font-weight: 600; }
.overview-session-liveness[data-liveness='active-busy'] { color: var(--accent); }
.session-details { font-size: 11px; color: var(--text-muted); }
.session-details > summary { cursor: pointer; }
.overview-action { margin: 9px 0 0; font-size: 12px; }
.overview-action a { color: var(--accent-2); text-decoration: underline; }
.overview-result-line { margin: 0; font-size: 12px; font-weight: 600; }
.overview-result { margin-top: 6px; }
.overview-result > summary { cursor: pointer; font-size: 12px; color: var(--text-muted); }
.overview-records { display: flex; flex-direction: column; gap: 14px; margin-top: 14px; }
.overview-record { border-top: 1px solid var(--surface-3); padding-top: 10px; min-width: 0; }
.overview-record h4, .overview-related-group h4 { margin: 0 0 6px; font-size: 12px; }
.overview-parent { margin: 0; font-size: 12px; }
.overview-related-group { margin-top: 12px; }
.overview-cards span { color: var(--text-muted); font-size: 11px; }
.overview-section > :deep(.view-state) { padding: 8px 0; }
.overview-section > :deep(.status-banner) { margin: 0; }
.mono { font-family: var(--font-mono); }
</style>
