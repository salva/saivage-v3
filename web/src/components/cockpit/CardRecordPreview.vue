<template>
  <div class="record-preview" :data-record-name="descriptor.name">
    <div class="record-source-line">
      <strong>{{ sourceLabel }}</strong>
      <span class="record-source-state" data-testid="record-source-state">{{ stateLabel }}</span>
      <span v-if="slot?.stale" class="record-stale-label">Last loaded · stale</span>
      <span v-else-if="slot?.accepted" class="record-fresh-label">Current observation</span>
    </div>

    <ViewState v-if="slot?.loading && !slot.accepted" state="loading" :title="`Loading ${descriptor.name}`" />
    <ViewState v-else-if="slot?.error && !slot.accepted" state="error" :title="`Could not load ${descriptor.name}`" :message="slot.error">
      <template #action><button type="button" @click="$emit('retry', descriptor.name)">Retry</button></template>
    </ViewState>
    <template v-else-if="content !== null">
      <p v-if="content.length === 0" class="record-empty" data-testid="record-empty-content">Effective content is empty.</p>
      <p v-else class="record-excerpt" data-testid="record-excerpt">{{ excerpt }}</p>
      <p v-if="slot?.stale" class="record-stale" role="alert">
        {{ slot.refreshError ?? `${descriptor.name} is stale.` }}
        <button v-if="slot.staleReason === 'refresh-failed'" type="button" @click="$emit('retry', descriptor.name)">Retry</button>
      </p>
      <details class="record-full-content">
        <summary>Full content</summary>
        <MarkdownText :source="content" />
      </details>
    </template>
    <p v-else-if="descriptor.bootstrap" class="record-error" role="alert">Required objective content is unavailable.</p>
    <p v-else class="record-empty">Not yet published.</p>

    <details class="record-details">
      <summary>Record details</summary>
      <dl>
        <dt>Name</dt><dd class="mono">{{ descriptor.name }}</dd>
        <dt>Schema</dt><dd>{{ descriptor.schema }}</dd>
        <template v-if="slot?.current">
          <dt>Artifact state</dt><dd>{{ artifactState }}</dd>
          <dt>Head revision</dt><dd>{{ slot.current.record.head_version }}</dd>
          <dt>Accepted source revision</dt><dd>{{ slot.current.record.accepted?.source_version ?? 'none' }}</dd>
          <dt>Effective content</dt><dd>{{ stateLabel }}</dd>
        </template>
      </dl>
      <p>Card revision counts card publications. Each record has its own revision sequence; neither measures work completed.</p>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CardRecordDescriptor, LiveSyncCardRecordName } from '../../api/types';
import type { RecordSlotState } from '../../stores/cards';
import MarkdownText from '../content/MarkdownText.vue';
import ViewState from '../ui/ViewState.vue';

const props = defineProps<{
  descriptor: CardRecordDescriptor;
  slot: RecordSlotState | null;
  sourceLabel: string;
}>();
defineEmits<{ retry: [name: LiveSyncCardRecordName] }>();

const content = computed(() => props.slot?.accepted?.kind === 'content' ? props.slot.accepted.content : null);
const excerpt = computed(() => {
  const characters = Array.from(content.value ?? '');
  return characters.length > 600 ? `${characters.slice(0, 600).join('')}…` : characters.join('');
});
const stateLabel = computed(() => {
  const source = props.slot?.current?.record.effective_content_source;
  if (source === 'draft') return 'Draft';
  if (source === 'accepted') return 'Accepted';
  if (props.slot?.loading) return 'Loading';
  if (props.slot?.error) return 'Read failed';
  if (props.slot?.accepted?.kind === 'empty' || props.descriptor.current === null) return 'Not yet published';
  return 'Unavailable';
});
const artifactState = computed(() => {
  const state = props.slot?.current?.record.state;
  if (state === 'open') return 'Open (draft)';
  if (state === 'closed') return 'Closed (accepted)';
  if (state === 'discarded') return 'Discarded';
  return 'Not yet published';
});
</script>

<style scoped>
.record-preview { min-width: 0; }
.record-source-line { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; font-size: 12px; }
.record-source-state, .record-stale-label, .record-fresh-label { color: var(--text-muted); font-size: 11px; }
.record-stale-label, .record-error, .record-stale { color: var(--warn); }
.record-excerpt { margin: 7px 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.45; }
.record-empty, .record-error, .record-stale { margin: 7px 0; font-size: 11px; }
.record-full-content, .record-details { margin-top: 6px; overflow-wrap: anywhere; }
.record-full-content > summary, .record-details > summary { cursor: pointer; color: var(--text-muted); font-size: 12px; }
.record-full-content :deep(.markdown-text) { margin-top: 8px; }
.record-details dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 10px; margin: 7px 0; font-size: 11px; }
.record-details dt { color: var(--text-muted); }
.record-details dd { margin: 0; overflow-wrap: anywhere; }
.record-details p { margin: 6px 0 0; color: var(--text-muted); font-size: 11px; }
.record-preview :deep(.view-state) { padding: 8px 0; }
.mono { font-family: var(--font-mono); }
</style>
