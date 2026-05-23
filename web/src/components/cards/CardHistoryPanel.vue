<template>
  <section class="detail-section">
    <div class="panel-header-row">
      <div>
        <h3 class="section-heading">Card history</h3>
        <p class="panel-copy">Inspect tracked versions, fetch a full prior snapshot, and compare it to the current card.</p>
      </div>
      <div class="panel-header-actions">
        <button
          type="button"
          class="filter-chip"
          :class="{ active: analystOnly }"
          @click="analystOnly = !analystOnly"
          :title="analystOnly ? 'Showing analyst web-chat history only' : 'Filter card history by editor (currently: analyst)'"
        >{{ analystOnly ? 'all history' : 'by analyst' }}</button>
        <button type="button" class="retry-btn" @click="reloadAll">Refresh history</button>
      </div>
    </div>

    <div v-if="cardHistoryLoading" class="empty-evidence">Loading card history…</div>
    <div v-else-if="cardHistoryError" class="detail-callout error" role="alert">
      <strong>{{ cardHistoryError.kind === 'unauthorized' ? 'Unauthorized' : 'Card history unavailable' }}</strong>
      <div>{{ cardHistoryError.message }}</div>
    </div>
    <div v-else-if="filteredHistory.length === 0" class="empty-evidence">No tracked card history exists yet for this card.</div>
    <template v-else>
      <div class="history-layout">
        <div class="history-list">
          <button
            v-for="entry in filteredHistory"
            :key="entry.version_seq"
            type="button"
            class="history-item"
            :class="{ selected: cardHistorySelectedSeq === entry.version_seq }"
            @click="selectVersion(entry.version_seq)"
          >
            <div class="history-item-top">
              <span class="badge subtle">v{{ entry.version_seq }}</span>
              <span class="badge">{{ entry.changed_by_actor }}</span>
              <span v-if="isAnalystEntry(entry)" class="badge analyst-badge">analyst (web-chat)</span>
              <span class="badge subtle">{{ entry.changed_by_surface }}</span>
            </div>
            <div class="history-summary">{{ entry.change_summary }}</div>
            <div class="history-fields">Changed: {{ entry.changed_fields.join(', ') || 'none recorded' }}</div>
            <div class="history-time" :title="timestampTitle(entry.changed_at)">{{ fmtDate(entry.changed_at) }}</div>
          </button>
        </div>

        <div class="history-detail">
          <div v-if="cardHistoryEntryLoading || cardHistoryDiffLoading" class="empty-evidence">Loading history details…</div>
          <div v-else-if="cardHistoryEntryError || cardHistoryDiffError" class="detail-callout error" role="alert">
            <strong>{{ activeDetailError?.kind === 'unauthorized' ? 'Unauthorized' : 'History detail unavailable' }}</strong>
            <div>{{ activeDetailError?.message }}</div>
          </div>
          <div v-else-if="!cardHistoryEntry" class="empty-evidence">Select a version to inspect its snapshot and diff.</div>
          <template v-else>
            <div class="history-meta-grid">
              <div class="meta-item"><span class="meta-key">Snapshot version</span><span class="meta-value">v{{ cardHistoryEntry.version_seq }}</span></div>
              <div class="meta-item"><span class="meta-key">Changed by</span><span class="meta-value">{{ cardHistoryEntry.changed_by_actor }} via {{ cardHistoryEntry.changed_by_surface }}</span></div>
              <div class="meta-item"><span class="meta-key">Changed at</span><span class="meta-value" :title="timestampTitle(cardHistoryEntry.changed_at)">{{ fmtDate(cardHistoryEntry.changed_at) }}</span></div>
              <div class="meta-item"><span class="meta-key">Reason</span><span class="meta-value">{{ cardHistoryEntry.change_reason || 'No reason recorded' }}</span></div>
            </div>

            <div class="history-subsection">
              <div class="history-subheading">Diff vs current card</div>
              <div v-if="cardHistoryDiff.length === 0" class="empty-evidence">No diff rows were returned for this version.</div>
              <div v-else class="diff-list">
                <div v-for="row in cardHistoryDiff" :key="row.field" class="diff-row">
                  <div class="diff-field">{{ row.field }}</div>
                  <CodeBlock :code="formatJson(row.before, { redactor: sanitizeCardHistoryValue })" language="json" copyable />
                  <CodeBlock :code="formatJson(row.after, { redactor: sanitizeCardHistoryValue })" language="json" copyable />
                </div>
              </div>
            </div>

            <div class="history-subsection">
              <div class="history-subheading">Snapshot body</div>
              <CodeBlock :code="formatJson(cardHistoryEntry.snapshot, { redactor: sanitizeCardHistoryValue })" language="json" copyable />
            </div>
          </template>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useCardStore } from '../../stores/cards';
import { useWsStore } from '../../stores/ws';
import type { CardHistoryHeader } from '../../api/types';
import { formatTimestamp, isRecentTimestamp, timestampTitle } from '../../utils/timestamp';
import { formatJson } from '../../utils/format-json';
import { sanitizeCardHistoryValue } from '../../utils/sanitize-card-history';
import CodeBlock from '../code/CodeBlock.vue';

const props = defineProps<{ cardId: string }>();
const cardStore = useCardStore();
const wsStore = useWsStore();
const {
  cardHistory,
  cardHistoryLoading,
  cardHistoryError,
  cardHistorySelectedSeq,
  cardHistoryEntry,
  cardHistoryEntryLoading,
  cardHistoryEntryError,
  cardHistoryDiff,
  cardHistoryDiffLoading,
  cardHistoryDiffError,
} = storeToRefs(cardStore);

const analystOnly = ref(false);
const activeDetailError = computed(() => cardHistoryEntryError.value ?? cardHistoryDiffError.value);
const filteredHistory = computed(() => analystOnly.value ? cardHistory.value.filter((entry) => isAnalystEntry(entry)) : cardHistory.value);

function isAnalystEntry(entry: CardHistoryHeader): boolean {
  return entry.changed_by_actor === 'analyst' && entry.changed_by_surface === 'web-chat';
}

function fmtDate(ts: string): string {
  return formatTimestamp(ts, isRecentTimestamp(ts) ? 'relative' : 'absolute');
}

async function loadHistory(): Promise<void> {
  await cardStore.fetchCardHistoryForCard(props.cardId);
  const firstSeq = filteredHistory.value[0]?.version_seq ?? cardStore.cardHistory[0]?.version_seq;
  if (firstSeq && cardStore.cardHistorySelectedSeq !== firstSeq) {
    await cardStore.selectCardHistoryVersion(props.cardId, firstSeq);
  }
}

async function selectVersion(seq: number): Promise<void> {
  await cardStore.selectCardHistoryVersion(props.cardId, seq);
}

async function reloadAll(): Promise<void> {
  await loadHistory();
}

const unsubscribe = wsStore.onType('activity', (envelope) => {
  const event = envelope.content?.event;
  const cardId = typeof envelope.content?.card_id === 'string'
    ? envelope.content.card_id
    : typeof envelope.content?.related_card_id === 'string'
      ? envelope.content.related_card_id
      : null;
  if ((event === 'card_history_appended' || event === 'analyst_tool_invoked') && cardId === props.cardId) {
    void loadHistory().catch(() => {});
  }
});

onMounted(async () => {
  await loadHistory();
});

onUnmounted(() => {
  unsubscribe();
});

watch(() => props.cardId, async () => {
  cardStore.clearCardHistoryState();
  await loadHistory();
});

watch(analystOnly, async () => {
  const firstSeq = filteredHistory.value[0]?.version_seq;
  if (firstSeq) {
    await cardStore.selectCardHistoryVersion(props.cardId, firstSeq);
  }
});
</script>

<style scoped>
.panel-header-row { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:10px; }
.panel-header-actions { display:flex; gap:8px; align-items:center; }
.panel-copy { margin:4px 0 0; color:#8b949e; font-size:12px; }
.filter-chip { border:1px solid #30363d; background:#161b22; color:#c9d1d9; border-radius:999px; padding:6px 10px; cursor:pointer; }
.filter-chip.active { border-color:#58a6ff; color:#58a6ff; }
.history-layout { display:grid; grid-template-columns:minmax(240px, 320px) 1fr; gap:16px; }
.history-list { display:flex; flex-direction:column; gap:8px; }
.history-item { text-align:left; padding:10px 12px; background:#161b22; border:1px solid #21262d; border-radius:6px; color:#c9d1d9; cursor:pointer; }
.history-item.selected { border-color:#58a6ff; }
.history-item-top { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px; }
.analyst-badge { background:#1c2738; color:#79c0ff; }
.history-summary { font-size:13px; color:#f0f6fc; margin-bottom:4px; }
.history-fields,.history-time { font-size:11px; color:#8b949e; }
.history-detail { min-width:0; }
.history-meta-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:8px; margin-bottom:12px; }
.history-subsection { margin-top:12px; }
.history-subheading { font-size:12px; font-weight:600; color:#8b949e; text-transform:uppercase; margin-bottom:8px; }
.diff-list { display:flex; flex-direction:column; gap:8px; }
.diff-row { display:grid; grid-template-columns:140px 1fr 1fr; gap:8px; align-items:start; }
.diff-field { font-size:12px; color:#f0f6fc; font-weight:600; }
@media (max-width: 960px) { .history-layout { grid-template-columns:1fr; } .diff-row { grid-template-columns:1fr; } }
</style>
