<template>
  <header class="card-entity">
    <div class="card-entity__title-row">
      <h1 class="card-entity__title">
        <span v-if="subtitle" class="card-entity__path">{{ subtitle }}</span>
        <span class="card-entity__name">{{ title }}</span>
      </h1>
      <span v-if="type" class="card-entity__type">{{ type }}</span>
      <StatusBadge v-if="status" :status="status" />
      <slot name="actions" />
    </div>

    <div v-if="$slots.meta" class="card-entity__orientation"><slot name="meta" /></div>
    <slot />
  </header>
</template>

<script setup lang="ts">
import type { UiStatus } from '../../utils/status';
import StatusBadge from './StatusBadge.vue';

defineProps<{ title: string; subtitle?: string | null; type?: string; status?: UiStatus }>();
</script>
