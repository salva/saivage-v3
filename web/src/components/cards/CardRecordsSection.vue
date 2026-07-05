<template>
  <Section title="Records">
    <div v-if="loading" class="records-hint">Loading records…</div>
    <div v-else class="records-list">
      <RecordDocument
        v-for="slot in SLOTS"
        :key="slot.key"
        :name="`${slot.key}.md`"
        :human-label="slot.label"
        :version="stateValue(slot.key).version"
      >
        <div v-if="stateValue(slot.key).loading" class="records-hint">Loading {{ slot.key }}…</div>
        <div v-else-if="stateValue(slot.key).error" class="records-error">Could not load {{ slot.key }}: {{ stateValue(slot.key).error }}</div>
        <MarkdownText v-else-if="stateValue(slot.key).content" :source="stateValue(slot.key).content || ''" />
        <EmptyState v-else :message="slot.empty" />
      </RecordDocument>
    </div>
  </Section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useCardRecords, type RecordSlot } from '../../composables/useCardRecords';
import Section from '../ui/Section.vue';
import EmptyState from '../ui/EmptyState.vue';
import RecordDocument from './RecordDocument.vue';
import MarkdownText from '../content/MarkdownText.vue';

const props = defineProps<{ cardId: string; refreshKey?: number }>();

const cardIdRef = computed(() => props.cardId);
const { state, loading } = useCardRecords(cardIdRef);

const SLOTS: { key: RecordSlot; label: string; empty: string }[] = [
  { key: 'brief', label: 'Brief', empty: 'No brief recorded for this card yet.' },
  { key: 'status', label: 'Status', empty: 'No status record yet.' },
  { key: 'review', label: 'Review', empty: 'No review record yet.' },
];

function stateValue(key: RecordSlot) {
  return state.value[key];
}
</script>

<style scoped>
.records-list { display: flex; flex-direction: column; gap: 12px; }
.records-hint { font-size: 12px; color: var(--text-muted); }
.records-error { font-size: 12px; color: var(--danger); }
</style>
