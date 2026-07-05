<template>
  <div class="conversation-timeline">
    <RoundCard
      v-for="round in timeline.rounds"
      :key="round.id"
      :round="round"
      :expanded-ids="expandedIds"
      @toggle="(id) => emit('toggle', id)"
    />
  </div>
</template>

<script setup lang="ts">
import type { AgentTimeline } from '../../utils/agent-timeline';
import RoundCard from './RoundCard.vue';

defineProps<{ timeline: AgentTimeline; expandedIds: Set<string> }>();
const emit = defineEmits<{ toggle: [id: string] }>();
</script>

<style scoped>
.conversation-timeline { display:flex; flex-direction:column; gap:12px; }
</style>
