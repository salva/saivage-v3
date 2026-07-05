<template>
  <Section title="Records">
    <ViewState v-if="loading" state="loading" title="Loading records" />
    <div v-else class="records-list">
      <DocumentFrame
        v-for="slot in SLOTS"
        :key="slot.key"
        :name="`${slot.key}.md`"
        :title="slot.label"
        :version="stateValue(slot.key).version"
      >
        <ViewState v-if="stateValue(slot.key).loading" state="loading" :title="`Loading ${slot.key}`" />
        <ViewState v-else-if="stateValue(slot.key).error" state="error" :title="`Could not load ${slot.key}`" :message="stateValue(slot.key).error || ''" />
        <MarkdownText v-else-if="stateValue(slot.key).content" :source="stateValue(slot.key).content || ''" />
        <ViewState v-else state="empty" :title="slot.empty" />
      </DocumentFrame>
    </div>
  </Section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useCardRecords, type RecordSlot } from '../../composables/useCardRecords';
import Section from '../ui/Section.vue';
import ViewState from '../ui/ViewState.vue';
import MarkdownText from '../content/MarkdownText.vue';
import DocumentFrame from '../content/DocumentFrame.vue';

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
</style>
