<template>
  <Section title="Records">
    <div class="records-list">
      <DocumentFrame v-for="record in records" :key="record.name" :name="record.name" :title="record.name"
        :version="contentValue(record.name)?.version ?? null"
        :timestamp="contentValue(record.name)?.committedAt ?? null">
        <ViewState v-if="value(record.name).loading && !value(record.name).accepted" state="loading" :title="`Loading ${record.name}`" />
        <ViewState v-else-if="value(record.name).error && !value(record.name).accepted" state="error" :title="`Could not load ${record.name}`" :message="value(record.name).error ?? ''" />
        <div v-else>
          <div class="record-metadata">{{ record.schema }} · {{ record.bootstrap ? 'bootstrap' : 'optional' }} · writers: {{ record.writers.join(', ') || 'none' }}</div>
          <div v-if="value(record.name).stale" class="record-stale" role="alert">
            <span>{{ value(record.name).refreshError ?? `${record.name} is stale.` }}</span>
            <button v-if="value(record.name).staleReason === 'refresh-failed'" type="button" @click="retry(record.name)">Retry</button>
          </div>
          <MarkdownText v-if="contentValue(record.name)" :source="contentValue(record.name)?.content ?? ''" />
          <ViewState v-else state="empty" :title="`No ${record.name} record yet.`" />
        </div>
      </DocumentFrame>
    </div>
  </Section>
</template>

<script setup lang="ts">
import { computed,onMounted, watch } from 'vue';
import type { LiveSyncCardRecordName as RecordName } from '../../api/types';
import { useCardStore, type RecordSlotState } from '../../stores/cards';
import Section from '../ui/Section.vue';
import ViewState from '../ui/ViewState.vue';
import MarkdownText from '../content/MarkdownText.vue';
import DocumentFrame from '../content/DocumentFrame.vue';

const props = defineProps<{ cardId: string }>();
const store = useCardStore();
const records=computed(()=>store.selectedDetail?.cardId===props.cardId?store.selectedDetail.records:[]);
function value(name: RecordName): RecordSlotState { const value=store.cardRecords[name];if(!value)throw new Error(`Missing record state for '${name}'.`);return value; }
function contentValue(name: RecordName) { const accepted = value(name).accepted; return accepted?.kind === 'content' ? accepted : null; }
function load(): void { void store.loadCardRecords(props.cardId); }
function retry(name: RecordName): void { void store.retryRecord(name); }
onMounted(load);
watch(() => props.cardId, load);
</script>

<style scoped>
.records-list { display:flex; flex-direction:column; gap:12px; }
.record-stale { display:flex; justify-content:space-between; gap:8px; margin-bottom:8px; color:var(--warn); font-size:12px; }
.record-metadata { margin-bottom:8px;color:var(--text-muted);font-size:11px; }
</style>
