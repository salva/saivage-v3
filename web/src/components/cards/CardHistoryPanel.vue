<template>
  <section class="detail-section">
    <div class="panel-header-row">
      <div>
        <h3 class="section-heading">Card history</h3>
        <p class="panel-copy">Inspect tracked versions, fetch a full prior snapshot, and compare it to the current card.</p>
      </div>
      <button type="button" class="retry-btn" @click="reloadAll">Refresh history</button>
    </div>

    <div v-if="cardHistoryLoading" class="empty-evidence">Loading card history…</div>
    <div v-else-if="cardHistoryError" class="detail-callout error" role="alert">
      <strong>{{ cardHistoryError.kind === 'unauthorized' ? 'Unauthorized' : 'Card history unavailable' }}</strong>
      <div>{{ cardHistoryError.message }}</div>
    </div>
    <div v-else-if="cardHistory.length === 0" class="empty-evidence">No tracked card history exists yet for this card.</div>
    <template v-else>
      <div class="history-layout">
        <div class="history-list">
          <button
            v-for="entry in cardHistory"
            :key="entry.version_seq"
            type="button"
            class="history-item"
            :class="{ selected: cardHistorySelectedSeq === entry.version_seq }"
            @click="selectVersion(entry.version_seq)"
          >
            <div class="history-item-top">
              <span class="badge subtle">v{{ entry.version_seq }}</span>
              <span class="badge">{{ entry.changed_by_actor }}</span>
              <span class="badge subtle">{{ entry.changed_by_surface }}</span>
            </div>
            <div class="history-summary">{{ entry.change_summary }}</div>
            <div class="history-fields">Changed: {{ entry.changed_fields.join(', ') || 'none recorded' }}</div>
            <div class="history-time">{{ fmtDate(entry.changed_at) }}</div>
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
              <div class="meta-item"><span class="meta-key">Changed at</span><span class="meta-value">{{ fmtDate(cardHistoryEntry.changed_at) }}</span></div>
              <div class="meta-item"><span class="meta-key">Reason</span><span class="meta-value">{{ cardHistoryEntry.change_reason || 'No reason recorded' }}</span></div>
            </div>

            <div class="history-subsection">
              <div class="history-subheading">Diff vs current card</div>
              <div v-if="cardHistoryDiff.length === 0" class="empty-evidence">No diff rows were returned for this version.</div>
              <div v-else class="diff-list">
                <div v-for="row in cardHistoryDiff" :key="row.field" class="diff-row">
                  <div class="diff-field">{{ row.field }}</div>
                  <pre class="diff-side"><code>{{ fmtJson(row.before) }}</code></pre>
                  <pre class="diff-side"><code>{{ fmtJson(row.after) }}</code></pre>
                </div>
              </div>
            </div>

            <div class="history-subsection">
              <div class="history-subheading">Snapshot body</div>
              <pre class="detail-json"><code>{{ fmtJson(cardHistoryEntry.snapshot) }}</code></pre>
            </div>
          </template>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useCardStore } from '../../stores/cards';

const props = defineProps<{ cardId: string }>();
const cardStore = useCardStore();
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

const activeDetailError = computed(() => cardHistoryEntryError.value ?? cardHistoryDiffError.value);
const secretLikeKeyPattern = /(token|secret|password|authorization|auth[_-]?profile|provider|env|config)/i;
const secretLikeValuePattern = /(sk-[A-Za-z0-9_-]+|bearer\s+[A-Za-z0-9._-]+|api[_-]?key|token|secret|password|auth[_-]?profile|env\[[^\]]+\]|process\.env)/i;

function fmtDate(ts: string): string {
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function sanitizeForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForDisplay(item));
  }

  if (value && typeof value === 'object') {
    const sanitizedEntries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => {
      if (secretLikeKeyPattern.test(key)) {
        return [key, '[redacted]'];
      }
      return [key, sanitizeForDisplay(entryValue)];
    });
    return Object.fromEntries(sanitizedEntries);
  }

  if (typeof value === 'string' && secretLikeValuePattern.test(value)) {
    return '[redacted]';
  }

  return value;
}

function fmtJson(value: unknown): string {
  try {
    return JSON.stringify(sanitizeForDisplay(value), null, 2);
  } catch {
    return String(sanitizeForDisplay(value));
  }
}

async function loadHistory(): Promise<void> {
  await cardStore.fetchCardHistoryForCard(props.cardId);
  const firstSeq = cardStore.cardHistory[0]?.version_seq;
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

onMounted(async () => {
  await loadHistory();
});

watch(() => props.cardId, async () => {
  cardStore.clearCardHistoryState();
  await loadHistory();
});
</script>

<style scoped>
.panel-header-row { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:10px; }
.panel-copy { margin:4px 0 0; color:#8b949e; font-size:12px; }
.history-layout { display:grid; grid-template-columns:minmax(240px, 320px) 1fr; gap:16px; }
.history-list { display:flex; flex-direction:column; gap:8px; }
.history-item { text-align:left; padding:10px 12px; background:#161b22; border:1px solid #21262d; border-radius:6px; color:#c9d1d9; cursor:pointer; }
.history-item.selected { border-color:#58a6ff; }
.history-item-top { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px; }
.history-summary { font-size:13px; color:#f0f6fc; margin-bottom:4px; }
.history-fields,.history-time { font-size:11px; color:#8b949e; }
.history-detail { min-width:0; }
.history-meta-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:8px; margin-bottom:12px; }
.history-subsection { margin-top:12px; }
.history-subheading { font-size:12px; font-weight:600; color:#8b949e; text-transform:uppercase; margin-bottom:8px; }
.diff-list { display:flex; flex-direction:column; gap:8px; }
.diff-row { display:grid; grid-template-columns:140px 1fr 1fr; gap:8px; align-items:start; }
.diff-field { font-size:12px; color:#f0f6fc; font-weight:600; }
.diff-side { margin:0; padding:10px; border:1px solid #21262d; border-radius:4px; background:#0d1117; color:#c9d1d9; font-size:11px; white-space:pre-wrap; word-break:break-word; }
@media (max-width: 960px) { .history-layout { grid-template-columns:1fr; } .diff-row { grid-template-columns:1fr; } }
</style>
