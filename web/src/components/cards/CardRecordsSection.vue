<template>
  <Section title="Records">
    <ViewState v-if="store.recordDescriptorsLoading && records.length === 0" state="loading" title="Loading record definitions" />
    <ViewState v-else-if="store.recordDescriptorsError" state="error" title="Could not load record definitions" :message="store.recordDescriptorsError" />
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
          <button type="button" class="history-button" @click="history(record.name)">History</button>
          <ViewState v-if="value(record.name).historyLoading && !value(record.name).history" state="loading" title="Loading record history" />
          <div v-if="value(record.name).historyError" class="record-history-error" role="alert">{{ value(record.name).historyError }}</div>
          <ol v-if="value(record.name).history" class="record-history">
            <li v-for="version in value(record.name).history?.versions" :key="version.entry_id">
              <button type="button" @click="select(record.name, version.version)">v{{ version.version }} · {{ version.state }}</button>
            </li>
          </ol>
          <div v-if="value(record.name).selectedError" class="record-history-error" role="alert">{{ value(record.name).selectedError }} <button type="button" @click="retrySelected(record.name)">Retry</button></div>
          <ViewState v-if="value(record.name).selectedLoading" state="loading" title="Loading selected record version" />
          <div v-if="value(record.name).selected" class="selected-record">
            <strong>Selected v{{ value(record.name).selected?.version }}</strong>
            <MarkdownText v-if="selectedContent(record.name) !== null" :source="selectedContent(record.name) ?? ''" />
            <ViewState v-else state="empty" title="Selected view has no effective content." />
            <pre v-if="value(record.name).diff">{{ value(record.name).diff?.hunks }}</pre>
            <div v-if="value(record.name).diffError" class="record-history-error" role="alert">{{ value(record.name).diffError }} <button type="button" @click="retrySelected(record.name)">Retry diff</button></div>
          </div>
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
const records=computed(()=>store.selectedDetail?.cardId===props.cardId?store.recordDescriptors:[]);
function value(name: RecordName): RecordSlotState { const value=store.cardRecords[name];if(!value)throw new Error(`Missing record state for '${name}'.`);return value; }
function contentValue(name: RecordName) { const accepted = value(name).accepted; return accepted?.kind === 'content' ? accepted : null; }
function load(): void { void store.loadCardRecords(props.cardId); }
function retry(name: RecordName): void { void store.retryRecord(name); }
function history(name:RecordName):void{void store.openRecordHistory(name);}
function select(name:RecordName,version:number):void{void store.selectRecordVersion(name,version);}
function retrySelected(name:RecordName):void{const version=value(name).selected?.version??value(name).history?.versions.at(-1)?.version;if(version!==undefined)select(name,version);}
function selectedContent(name:RecordName):string|null{const artifact=value(name).selected?.artifact;if(!artifact)return null;return artifact.state==='open'?artifact.draft?.content??null:artifact.accepted?.content??null;}
onMounted(load);
watch(() => props.cardId, load);
</script>

<style scoped>
.records-list { display:flex; flex-direction:column; gap:12px; }
.record-stale { display:flex; justify-content:space-between; gap:8px; margin-bottom:8px; color:var(--warn); font-size:12px; }
.record-metadata { margin-bottom:8px;color:var(--text-muted);font-size:11px; }
.history-button { margin-top:8px; }
.record-history { margin:8px 0;padding-left:20px; }
.record-history-error { margin-top:8px;color:var(--danger); }
.selected-record { margin-top:8px;border-top:1px solid var(--border);padding-top:8px; }
</style>
