<template>
  <Section title="Records">
    <div class="records-list">
      <DocumentFrame v-for="slot in SLOTS" :key="slot.key" :name="`${slot.key}.md`" :title="slot.label"
        :version="contentValue(slot.key)?.version ?? null"
        :timestamp="contentValue(slot.key)?.committedAt ?? null">
        <ViewState v-if="value(slot.key).loading && !value(slot.key).accepted" state="loading" :title="`Loading ${slot.key}`" />
        <ViewState v-else-if="value(slot.key).error && !value(slot.key).accepted" state="error" :title="`Could not load ${slot.key}`" :message="value(slot.key).error ?? ''" />
        <div v-else>
          <div v-if="value(slot.key).stale" class="record-stale" role="alert">
            <span>{{ value(slot.key).refreshError ?? `${slot.label} is stale.` }}</span>
            <button v-if="value(slot.key).staleReason === 'refresh-failed'" type="button" @click="retry(slot.key)">Retry</button>
          </div>
          <MarkdownText v-if="contentValue(slot.key)" :source="contentValue(slot.key)?.content ?? ''" />
          <ViewState v-else state="empty" :title="slot.empty" />
        </div>
      </DocumentFrame>
    </div>
  </Section>
</template>

<script setup lang="ts">
import { onMounted, watch } from 'vue';
import type { LiveSyncCardRecordSlot as RecordSlot } from '../../api/types';
import { useCardStore, type RecordSlotState } from '../../stores/cards';
import Section from '../ui/Section.vue';
import ViewState from '../ui/ViewState.vue';
import MarkdownText from '../content/MarkdownText.vue';
import DocumentFrame from '../content/DocumentFrame.vue';

const props = defineProps<{ cardId: string }>();
const store = useCardStore();
const SLOTS: { key: RecordSlot; label: string; empty: string }[] = [
  { key: 'brief', label: 'Brief', empty: 'No brief recorded for this card yet.' },
  { key: 'status', label: 'Status', empty: 'No status record yet.' },
  { key: 'review', label: 'Review', empty: 'No review record yet.' },
];
function value(slot: RecordSlot): RecordSlotState { return store.cardRecords[slot]; }
function contentValue(slot: RecordSlot) { const accepted = value(slot).accepted; return accepted?.kind === 'content' ? accepted : null; }
function load(): void { void store.loadCardRecords(props.cardId); }
function retry(slot: RecordSlot): void { void store.retryRecord(slot); }
onMounted(load);
watch(() => props.cardId, load);
</script>

<style scoped>
.records-list { display:flex; flex-direction:column; gap:12px; }
.record-stale { display:flex; justify-content:space-between; gap:8px; margin-bottom:8px; color:var(--warn); font-size:12px; }
</style>
