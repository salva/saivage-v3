<template>
  <Section title="Records">
    <ViewState v-if="store.recordDescriptorsLoading && records.length === 0" state="loading" title="Loading record definitions" />
    <ViewState v-else-if="store.recordDescriptorsError" state="error" title="Could not load record definitions" :message="store.recordDescriptorsError" />
    <ViewState v-if="unavailableRecord" state="empty" title="Requested record unavailable" :message="`Record '${unavailableRecord}' is not configured for this card.`" />
    <div class="records-list">
      <DocumentFrame v-for="record in records" :key="record.name" :name="record.name" :title="record.name"
        :version="null"
        :timestamp="contentValue(record.name)?.committedAt ?? null">
        <ViewState v-if="value(record.name).loading && !value(record.name).accepted" state="loading" :title="`Loading ${record.name}`" />
        <ViewState v-else-if="value(record.name).error && !value(record.name).accepted" state="error" :title="`Could not load ${record.name}`" :message="value(record.name).error ?? ''" />
        <div v-else>
          <div class="record-metadata">{{ record.schema }} · {{ record.bootstrap ? 'bootstrap' : 'optional' }}</div>
          <p v-if="value(record.name).current">Current revision {{ value(record.name).current?.record.revision }} · {{ value(record.name).current?.record.effective_content_source ?? 'empty' }}</p>
          <div v-if="value(record.name).current?.record.accepted_version_url" class="record-locator">
            <router-link :to="recordLink(record.name, value(record.name).current!.record.accepted!.source_version)">Latest accepted v{{ value(record.name).current?.record.accepted?.source_version }}</router-link>
            <ExactValue :value="value(record.name).current!.record.accepted_version_url!" label="accepted record locator" />
          </div>
          <div v-if="value(record.name).stale" class="record-stale" role="alert">
            <span>{{ value(record.name).refreshError ?? `${record.name} is stale.` }}</span>
            <button v-if="value(record.name).staleReason === 'refresh-failed'" type="button" @click="retry(record.name)">Retry</button>
          </div>
          <MarkdownText v-if="contentValue(record.name)" :source="contentValue(record.name)?.content ?? ''" />
          <ViewState v-else state="empty" :title="`No ${record.name} record yet.`" />
          <details v-if="value(record.name).current?.record.draft && value(record.name).current?.record.accepted">
            <summary>Prior accepted content</summary>
            <MarkdownText :source="value(record.name).current!.record.accepted!.content" />
          </details>
        </div>
        <button type="button" class="history-button" :disabled="!historicalActionsReady(record.name)" @click="history(record.name)">History</button>
        <ViewState v-if="value(record.name).historyLoading && !value(record.name).history" state="loading" title="Loading record history" />
        <div v-if="value(record.name).historyError" class="record-history-error" role="alert">{{ value(record.name).historyError }}</div>
        <ol v-if="value(record.name).history" class="record-history">
          <li v-for="version in value(record.name).history?.versions" :key="version.entry_id">
            <button type="button" :disabled="!historicalActionsReady(record.name)" @click="select(record.name, version.version)">v{{ version.version }} · accepted</button>
          </li>
        </ol>
        <div v-if="value(record.name).selectedError" class="record-history-error" role="alert">{{ value(record.name).selectedError }} <button type="button" :disabled="!historicalActionsReady(record.name)" @click="retrySelected(record.name)">Retry</button></div>
        <ViewState v-if="value(record.name).selectedLoading" state="loading" title="Loading selected record version" />
        <div v-if="value(record.name).selected" class="selected-record">
          <strong>Selected v{{ value(record.name).selected?.version }}</strong>
          <ExactValue :value="value(record.name).selected!.version_url" label="selected record locator" />
          <p>Observed card mutation revision {{ value(record.name).selected!.artifact.accepted.card_version_seq }} · ordinary history
            <router-link :to="{ name: 'card-detail', params: { id: cardId }, query: { facet: 'records', version: String(value(record.name).selected!.artifact.accepted.card_history_version) } }">v{{ value(record.name).selected!.artifact.accepted.card_history_version }}</router-link>
            <ExactValue :value="`card:///${cardId}?v=${value(record.name).selected!.artifact.accepted.card_history_version}#entry=${value(record.name).selected!.artifact.accepted.card_history_entry_id}`" label="provenance locator" />
          </p>
          <MarkdownText v-if="selectedContent(record.name) !== null" :source="selectedContent(record.name) ?? ''" />
          <ViewState v-else state="empty" title="Selected view has no effective content." />
          <div v-if="value(record.name).diff" class="record-diff">
            <div class="record-diff-label">Selected accepted version vs current content</div>
            <p>{{ diffTargetLabel(record.name) }}</p>
            <CodeBlock :code="hunksText(record.name)" language="text" copyable />
          </div>
          <div v-if="value(record.name).diffError" class="record-history-error" role="alert">{{ value(record.name).diffError }} <button type="button" :disabled="!historicalActionsReady(record.name)" @click="retrySelected(record.name)">Retry diff</button></div>
        </div>
      </DocumentFrame>
    </div>
  </Section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { LiveSyncCardRecordName as RecordName } from '../../api/types';
import { useCardStore, type RecordSlotState } from '../../stores/cards';
import Section from '../ui/Section.vue';
import ViewState from '../ui/ViewState.vue';
import MarkdownText from '../content/MarkdownText.vue';
import CodeBlock from '../content/CodeBlock.vue';
import DocumentFrame from '../content/DocumentFrame.vue';
import ExactValue from '../ui/ExactValue.vue';

const props = defineProps<{ cardId: string; recordRefinement?: { record: string | null; version: number | null } }>();
const store = useCardStore();
const records=computed(()=>store.selectedDetail?.cardId===props.cardId?store.recordDescriptors:[]);
function value(name: RecordName): RecordSlotState { const value=store.cardRecords[name];if(!value)throw new Error(`Missing record state for '${name}'.`);return value; }
function contentValue(name: RecordName) { const accepted = value(name).accepted; return accepted?.kind === 'content' ? accepted : null; }
const initialLoadCompletedFor = ref<string | null>(null);
const descriptorsReady = computed(() => store.selectedCardId === props.cardId &&
  store.selectedDetail?.cardId === props.cardId &&
  !store.recordDescriptorsLoading && !store.recordDescriptorsError);
const unavailableRecord = computed(() => {
  const name = props.recordRefinement?.record;
  return descriptorsReady.value && name && !records.value.some((record) => record.name === name) ? name : null;
});
function historicalActionsReady(name: RecordName): boolean {
  return descriptorsReady.value && initialLoadCompletedFor.value === props.cardId &&
    records.value.some((record) => record.name === name) &&
    !(value(name).loading && !value(name).accepted);
}
const refinementReady = computed(() => {
  const name = props.recordRefinement?.record;
  return !!name && historicalActionsReady(name) && !value(name).loading && !value(name).refreshing;
});
function recordLink(name: string, version: number) { return { name: 'card-detail', params: { id: props.cardId }, query: { facet: 'records', record: name, version: String(version) } }; }
function retry(name: RecordName): void { void store.retryRecord(name); }
function history(name:RecordName):void{if(historicalActionsReady(name))void store.openRecordHistory(name);}
function hunksText(name: RecordName): string {
  const hunks = value(name).diff?.hunks;
  return hunks ? hunks.flatMap((hunk) => hunk.lines).join('\n') : '';
}
function diffTargetLabel(name: RecordName): string {
  const target = value(name).diff?.to;
  return target?.kind === 'current' ? `Current record revision ${target.revision}` : target ? `Accepted version ${target.version}` : '';
}

function select(name:RecordName,version:number):void{if(historicalActionsReady(name))void store.selectRecordVersion(name,version);}
function retrySelected(name:RecordName):void{if(!historicalActionsReady(name))return;const version=value(name).selectedVersion;if(version!==null)select(name,version);}
function selectedContent(name:RecordName):string|null{return value(name).selected?.artifact.accepted.content ?? null;}
watch(() => props.cardId, (cardId, _prior, onCleanup) => {
  initialLoadCompletedFor.value = null;
  let active = true;
  onCleanup(() => { active = false; });
  void store.loadCardRecords(cardId).then(() => {
    if (active) initialLoadCompletedFor.value = cardId;
  });
}, { immediate: true });
watch([() => props.cardId, () => props.recordRefinement?.record, () => props.recordRefinement?.version, refinementReady],
  ([_cardId, name, version, ready]) => {
    if (ready && name && version != null) {
      void store.openRecordHistory(name);
      void store.selectRecordVersion(name, version);
    }
  }, { immediate: true });
</script>

<style scoped>
.record-diff-label { font-size: 11px; color: var(--text-muted); margin-bottom: 2px; }
.records-list { display:flex; flex-direction:column; gap:12px; }
.record-stale { display:flex; justify-content:space-between; gap:8px; margin-bottom:8px; color:var(--warn); font-size:12px; }
.record-metadata { margin-bottom:8px;color:var(--text-muted);font-size:11px; }
.history-button { margin-top:8px; }
.record-history { margin:8px 0;padding-left:20px; }
.record-history-error { margin-top:8px;color:var(--danger); }
.selected-record { margin-top:8px;border-top:1px solid var(--border);padding-top:8px; }
.record-locator { display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline; }
.selected-record > .exact-value { margin-left:8px; }
</style>
