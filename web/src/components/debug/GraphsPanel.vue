<template>
  <div class="debug-tab-content" data-testid="debug-graphs-tab">
    <section class="debug-section">
      <div class="debug-section-header operator-header">
        <div>
          <h4 class="debug-section-title">Compiled Workflow Graphs</h4>
          <p class="operator-subtitle">
            Read-only startup artifacts. Configuration changes appear only after server restart.
          </p>
        </div>
        <button class="sv-fetch-btn" :disabled="graphsLoading || graphsRefreshing" @click="emit('refresh')">
          Refresh
        </button>
      </div>
      <StatusBanner v-if="graphsRefreshing" tone="stale" message="Refreshing compiled graphs…" />
      <StatusBanner v-else-if="graphsRefreshError" tone="warning" :message="graphsRefreshError" />
      <ViewState v-if="graphsLoading" state="loading" title="Loading compiled graphs..." />
      <ViewState
        v-else-if="graphsError"
        state="error"
        title="Failed to load compiled graphs"
        :message="graphsError"
      />
      <ViewState
        v-else-if="graphs && graphs.length === 0"
        state="error"
        title="No compiled graphs returned"
        message="A running server must have one compiled graph for every card type."
      />
      <template v-else-if="graphs && selectedGraph">
        <label class="graph-selector-label" for="debug-graph-card-type">Card type</label>
        <select
          id="debug-graph-card-type"
          class="graph-selector"
          :value="selectedGraphCardType"
          @change="selectGraph"
        >
          <option v-for="graph in graphs" :key="graph.card_type" :value="graph.card_type">
            {{ graph.card_type }}
          </option>
        </select>
        <DebugGraphDiagram :graph="selectedGraph" />
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { DeepReadonly } from 'vue';
import type { DebugGraph } from '../../api/types';
import StatusBanner from '../ui/StatusBanner.vue';
import ViewState from '../ui/ViewState.vue';
import DebugGraphDiagram from './DebugGraphDiagram.vue';

defineProps<{
  graphs: readonly DeepReadonly<DebugGraph>[] | null;
  graphsLoading: boolean;
  graphsRefreshing: boolean;
  graphsError: string | null;
  graphsRefreshError: string | null;
  selectedGraphCardType: string | null;
  selectedGraph: DeepReadonly<DebugGraph> | null;
}>();

const emit = defineEmits<{
  refresh: [];
  'select-graph': [cardType: string];
}>();

function selectGraph(event: Event): void {
  emit('select-graph', (event.target as HTMLSelectElement).value);
}
</script>

<style scoped>
.graph-selector-label {
  display: block;
  margin: 4px 0;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
}
.graph-selector {
  margin-bottom: 12px;
  min-width: 220px;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 7px 9px;
}
</style>
