<template>
  <div class="evidence-facet" data-testid="facet-evidence">
    <section class="evidence-section">
      <h3 class="evidence-label">Card versions</h3>
      <ViewState v-if="cardVersionsLoading" state="loading" title="Reading card version catalog" />
      <ViewState v-else-if="cardVersionsError" state="error" title="Card version catalog unavailable" :message="cardVersionsError">
        <template #action><button type="button" @click="loadCardVersions">Retry</button></template>
      </ViewState>
      <ViewState v-else-if="cardVersions.length === 0" state="empty" title="No tracked card versions" message="Absence of version rows is this source's coverage, not a claim the card never changed." />
      <ol v-else class="evidence-list" data-testid="evidence-card-versions">
        <li v-for="entry in cardVersions" :key="entry.entry_id">
          <router-link :to="versionLink(entry.version)">{{ entry.change?.summary ?? 'Card version' }} · v{{ entry.version }}</router-link>
          <span class="evidence-meta">published {{ formatRecentTimestamp(entry.published_at) }}{{ entry.change ? ` · actor ${entry.change.actor ?? 'unavailable'}` : ' · change metadata unavailable' }}</span>
        </li>
      </ol>
      <p class="evidence-note">Card version publication order is this source's spine only; it is not a cross-resource chronology.</p>
    </section>

    <section class="evidence-section">
      <h3 class="evidence-label">Record revisions</h3>
      <ViewState v-if="recordDescriptorsLoading" state="loading" title="Reading record declarations" />
      <ViewState v-else-if="recordDescriptorsError" state="error" title="Record declarations unavailable" :message="recordDescriptorsError" />
      <template v-else>
        <div v-for="descriptor in recordDescriptors" :key="descriptor.name" class="evidence-record">
          <h4 class="evidence-record-name">{{ descriptor.name }}</h4>
          <button v-if="!(recordHistories[descriptor.name]?.loaded)" type="button" class="evidence-command" @click="loadRecordHistory(descriptor.name)">Load revision catalog</button>
          <template v-else-if="recordHistories[descriptor.name]?.error">
            <span class="evidence-meta error">{{ recordHistories[descriptor.name]?.error }}</span>
            <button type="button" class="evidence-command" @click="loadRecordHistory(descriptor.name)">Retry</button>
          </template>
          <ol v-else-if="(recordHistories[descriptor.name]?.versions ?? []).length > 0" class="evidence-list">
            <li v-for="version in recordHistories[descriptor.name]?.versions ?? []" :key="version.entry_id">
              <router-link :to="recordVersionLink(descriptor.name, version.version)">v{{ version.version }} · {{ version.state }}</router-link>
              <span class="evidence-meta">published {{ formatRecentTimestamp(version.published_at) }}</span>
            </li>
          </ol>
          <span v-else class="evidence-meta">No revisions retained for this record.</span>
        </div>
        <p v-if="recordDescriptors.length === 0" class="evidence-note">This card type declares no records.</p>
      </template>
    </section>

    <section class="evidence-section">
      <h3 class="evidence-label">Session segments</h3>
      <ViewState v-if="sessionsState.loading && sessionsState.sessions.length === 0" state="loading" title="Reading card sessions" />
      <ViewState v-else-if="sessionsState.error" state="error" title="Card sessions unavailable" :message="sessionsState.error" />
      <template v-else>
        <div v-for="session in sessionsState.sessions" :key="session.id" class="evidence-record">
          <h4 class="evidence-record-name">{{ session.agent_name }} · {{ session.id }}</h4>
          <button v-if="!(segmentCatalogs[session.id]?.loaded)" type="button" class="evidence-command" @click="loadSegmentCatalog(session.id)">Load segment catalog</button>
          <template v-else-if="segmentCatalogs[session.id]?.error">
            <span class="evidence-meta error">{{ segmentCatalogs[session.id]?.error }}</span>
            <button type="button" class="evidence-command" @click="loadSegmentCatalog(session.id)">Retry</button>
          </template>
          <ol v-else class="evidence-list">
            <li v-for="version in segmentCatalogs[session.id]?.versions ?? []" :key="version.entry_id">
              <router-link :to="{ name: 'agent-detail', params: { id: session.id } }">Segment {{ version.version }} · {{ version.genesis_kind }}</router-link>
            </li>
          </ol>
        </div>
        <p v-if="sessionsState.sessions.length === 0" class="evidence-note">No published sessions for this card.</p>
      </template>
      <p class="evidence-note">Segments belong to their exact session; they are never merged into a cross-session order.</p>
    </section>

    <section class="evidence-section">
      <h3 class="evidence-label">Retained events (card scope)</h3>
      <EventsPanel :scope="{ cardId: cardId }" test-id="evidence-events" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import type { CardHistoryHeader, CardRecordDescriptor } from '../../api/types';
import type { ConversationSessionId } from '../../api/contracts';
import { listCardHistory, listRecordHistory, listAgentConversationVersions } from '../../api/client';
import { useCardStore } from '../../stores/cards';
import { useCardAgentSessionsStore } from '../../stores/cardAgentSessions';
import { useSyncStore } from '../../stores/sync';
import { useEventsStore } from '../../stores/events';
import { formatRecentTimestamp } from '../../utils/timestamp';
import EventsPanel from '../system/EventsPanel.vue';
import ViewState from '../ui/ViewState.vue';

const props = defineProps<{ cardId: string }>();

const cardStore = useCardStore();
const cardSessionsStore = useCardAgentSessionsStore();
const liveSync = useSyncStore();
const eventsStore = useEventsStore();
const { recordDescriptors, recordDescriptorsLoading, recordDescriptorsError } = storeToRefs(cardStore);

const cardVersions = ref<CardHistoryHeader[]>([]);
const cardVersionsLoading = ref(false);
const cardVersionsError = ref<string | null>(null);

const recordHistories = reactive<Record<string, { loaded: boolean; error: string | null; versions: { entry_id: string; version: number; state: string; published_at: string }[] }>>({});
const segmentCatalogs = reactive<Record<string, { loaded: boolean; error: string | null; versions: { entry_id: string; version: number; genesis_kind: string }[] }>>({});

const sessionsState = computed(() => cardSessionsStore.scope(props.cardId));
let closeSessions: (() => void) | null = null;

function loadCardVersions(): void {
  cardVersionsLoading.value = true;
  cardVersionsError.value = null;
  listCardHistory(props.cardId)
    .then((response) => { cardVersions.value = response.versions; })
    .catch((error: unknown) => { cardVersionsError.value = error instanceof Error ? error.message : String(error); })
    .finally(() => { cardVersionsLoading.value = false; });
}

function loadRecordHistory(name: string): void {
  recordHistories[name] = { loaded: false, error: null, versions: [] };
  listRecordHistory(props.cardId, name)
    .then((response) => { recordHistories[name] = { loaded: true, error: null, versions: response.versions }; })
    .catch((error: unknown) => { recordHistories[name] = { loaded: true, error: error instanceof Error ? error.message : String(error), versions: [] }; });
}

function loadSegmentCatalog(sessionId: ConversationSessionId): void {
  segmentCatalogs[sessionId] = { loaded: false, error: null, versions: [] };
  listAgentConversationVersions(sessionId)
    .then((response) => { segmentCatalogs[sessionId] = { loaded: true, error: null, versions: response.versions }; })
    .catch((error: unknown) => { segmentCatalogs[sessionId] = { loaded: true, error: error instanceof Error ? error.message : String(error), versions: [] }; });
}

function versionLink(version: number) {
  return { name: 'card-detail', params: { id: props.cardId }, query: { facet: 'records', version: String(version) } };
}
function recordVersionLink(name: string, version: number) {
  return { name: 'card-detail', params: { id: props.cardId }, query: { facet: 'records', record: name, version: String(version) } };
}

function loadDeclarations(): void {
  try { void cardStore.loadRecordDescriptors(props.cardId).catch(() => {}); } catch { /* selection not owned yet */ }
}

function openScope(): void {
  closeSessions?.();
  closeSessions = liveSync.openCardAgentSessions(props.cardId, async () => {
    await cardSessionsStore.fetchScope(props.cardId).catch(() => {});
  });
}

onMounted(() => {
  loadCardVersions();
  loadDeclarations();
  openScope();
});
watch(() => props.cardId, () => {
  loadCardVersions();
  loadDeclarations();
  openScope();
});
onUnmounted(() => {
  closeSessions?.();
  cardSessionsStore.release(props.cardId);
  void eventsStore.release({ cardId: props.cardId });
});
</script>

<style scoped>
.evidence-facet { flex: 1; min-height: 0; overflow-y: auto; }
.evidence-section { padding: 14px 16px; border-bottom: 1px solid var(--surface-3); }
.evidence-label { margin: 0 0 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
.evidence-record { margin-bottom: 10px; }
.evidence-record-name { margin: 0 0 4px; font-size: 12px; font-weight: 600; color: var(--text); font-family: var(--font-mono); }
.evidence-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.evidence-list li { display: flex; flex-direction: column; gap: 1px; }
.evidence-list a { color: var(--accent-2); text-decoration: underline; font-size: 12px; }
.evidence-meta { font-size: 10px; color: var(--text-muted); }
.evidence-meta.error { color: var(--danger); }
.evidence-command { padding: 2px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-2); color: var(--text); font: inherit; font-size: 11px; cursor: pointer; }
.evidence-note { margin: 8px 0 0; font-size: 10px; color: var(--text-muted); }
.evidence-section > :deep(.view-state) { padding: 8px 0; }
</style>
