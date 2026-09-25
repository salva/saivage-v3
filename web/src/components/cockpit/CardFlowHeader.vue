<template>
  <header class="card-flow-header" :data-flow-unavailable="flowUnavailable ? 'true' : undefined">
    <div class="flow-title-row">
      <h2 class="flow-title" data-testid="card-flow-title">{{ detail?.title ?? cardId }}</h2>
      <span class="flow-id mono" :title="cardId" data-testid="card-flow-id">{{ cardId }}</span>
      <span v-if="detail" class="flow-kind">{{ labelForCardType(detail.type) }}</span>
      <StatusBadge v-if="detail" :status="statusForCard(detail.lifecycle.status)" />
      <span v-if="detail" class="flow-meta">v{{ detail.version_seq }} · updated {{ fmtDate(detail.updated_at) }}</span>
      <span v-if="flowUnavailable" class="flow-unavailable" data-testid="card-flow-unavailable">Card flow unavailable</span>
    </div>

    <StatusBanner v-if="detail?.lifecycle.error" tone="danger" title="Card error" :message="detail.lifecycle.error" />

    <div class="flow-questions">
      <section class="flow-question" aria-label="Context">
        <h3 class="flow-question-label">Context</h3>
        <template v-if="flowUnavailable">
          <p class="flow-unavailable-note" data-testid="card-flow-context-unavailable">
            The represented chain for this card is not available. No hierarchy is inferred.
          </p>
        </template>
        <template v-else>
          <p v-if="chainCards.length === 0" class="flow-muted" data-testid="card-flow-chain-unrepresented">Represented chain not loaded for this card.</p>
          <ol v-else class="flow-chain" data-testid="card-flow-chain">
            <li v-for="card in chainCards" :key="card.id">
              <router-link :to="{ name: 'card-detail', params: { id: card.id } }">{{ card.title }}</router-link>
              <span class="flow-chain-kind">{{ labelForCardType(card.type) }}</span>
            </li>
          </ol>
          <p v-if="children.length > 0" class="flow-children">
            <span class="flow-question-sub">Represented children:</span>
            <router-link v-for="child in children" :key="child.id" :to="{ name: 'card-detail', params: { id: child.id } }" class="flow-child-link">
              {{ child.title }}<span class="flow-child-kind"> · {{ labelForCardType(child.type) }}</span>
            </router-link>
          </p>
          <p v-else-if="childrenLoadState === 'undiscovered'" class="flow-muted">Children undiscovered. Expand the card in the tree to discover them.</p>
        </template>
      </section>

      <section class="flow-question" aria-label="Observed now">
        <h3 class="flow-question-label">Observed now</h3>
        <p v-if="positionLabel" class="flow-position" data-testid="card-flow-position">{{ positionLabel }}</p>
        <p v-if="positionGlossText" class="flow-muted flow-position-gloss" data-testid="card-flow-position-gloss">{{ positionGlossText }}</p>
        <p v-else-if="positionLabel" class="flow-muted flow-position-gloss"></p>
        <p v-if="!positionLabel" class="flow-muted" data-testid="card-flow-position-unavailable">No projected workflow position for this card. Unavailable is not “finished” or “idle”.</p>
        <p class="flow-muted">Position comes from the runtime projection only; card lifecycle and transcript history are separate facts.</p>
      </section>

      <section class="flow-question" aria-label="Possible outcomes">
        <h3 class="flow-question-label">Possible outcomes</h3>
        <template v-if="graph">
          <ul v-if="positionOutcomes.length > 0" class="flow-outcomes" data-testid="card-flow-outcomes">
            <li v-for="outcome in positionOutcomes" :key="outcome.label">
              {{ outcome.label }}
            </li>
          </ul>
          <p v-else-if="position?.kind === 'terminal'" class="flow-muted">Observed at terminal {{ position.terminal }}; a terminal has no configured outgoing outcomes.</p>
          <p v-else class="flow-muted" data-testid="card-flow-outcomes-unpinned">The observed position is not pinned to configured outgoing outcomes; the full configured workflow below is possibility, not a predicted destination.</p>
          <details class="flow-graph-details">
            <summary>Configured workflow ({{ graph.card_type }})</summary>
            <div class="flow-graph-text">
              <p class="flow-graph-row"><span class="flow-graph-label">Nodes:</span>
                <span v-for="node in graph.nodes" :key="node.node_id" class="flow-graph-item">{{ node.agent_name }} — node <span class="mono">{{ node.node_id }}</span></span>
              </p>
              <p class="flow-graph-row"><span class="flow-graph-label">Entries:</span>
                <span v-for="entry in graph.entries" :key="entry.entry" class="flow-graph-item"><span class="mono">{{ entry.entry }}</span> → node <span class="mono">{{ entry.node_id }}</span></span>
              </p>
              <p class="flow-graph-row"><span class="flow-graph-label">Edges:</span>
                <span v-for="edge in graph.edges" :key="`${edge.source_node_id}:${edge.outcome}`" class="flow-graph-item"><span class="mono">{{ edge.source_node_id }}</span> —{{ edge.outcome }}→ {{ edge.target.kind === 'node' ? `node ${edge.target.node_id}` : `terminal ${edge.target.terminal}` }}</span>
              </p>
              <p class="flow-graph-row"><span class="flow-graph-label">Terminals:</span>
                <span v-for="terminal in graph.terminals" :key="terminal.terminal" class="flow-graph-item">{{ terminal.terminal }}</span>
              </p>
              <p class="flow-graph-row"><span class="flow-graph-label">Records:</span>
                <span v-for="record in graph.records" :key="record.name" class="flow-graph-item">{{ record.name }}{{ record.bootstrap ? ' (bootstrap)' : '' }}</span>
              </p>
            </div>
          </details>
        </template>
        <ViewState v-else-if="graphsLoading" state="loading" title="Loading configured workflow" />
        <ViewState v-else-if="graphsError" state="error" title="Configured workflow unavailable" :message="graphsError">
          <template #action><button type="button" @click="retryGraphs">Retry</button></template>
        </ViewState>
        <p v-else class="flow-muted">No installed workflow is projected for this card type.</p>
      </section>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import type { CardDetail, CardWorkflowPosition } from '../../api/types';
import { cardRouteChain, useCardStore } from '../../stores/cards';
import { useDebugStore } from '../../stores/debug';
import { formatRecentTimestamp } from '../../utils/timestamp';
import { labelForCardType, statusForCard } from '../../utils/status';
import { positionGloss } from '../../utils/legibility';
import StatusBadge from '../ui/StatusBadge.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import ViewState from '../ui/ViewState.vue';

const props = defineProps<{
  cardId: string;
  detail: CardDetail | null;
  flowUnavailable?: boolean;
  position: CardWorkflowPosition | null;
}>();

const cardStore = useCardStore();
const debugStore = useDebugStore();
const { graphs, graphsLoading, graphsError } = storeToRefs(debugStore);

onMounted(() => {
  if (graphs.value === null && !graphsLoading.value) void debugStore.fetchGraphs().catch(() => {});
});
function retryGraphs(): void { void debugStore.fetchGraphs().catch(() => {}); }

function fmtDate(ts: string): string { return ts ? formatRecentTimestamp(ts) : ''; }

const chainCards = computed(() => {
  const ids = cardRouteChain(props.cardId);
  return ids
    .map((id) => cardStore.hierarchyCardById(id))
    .filter((card): card is NonNullable<typeof card> => card !== null)
    .map((card) => ({ id: card.id, title: card.title, type: card.type }));
});

const children = computed(() => cardStore.loadedChildrenFor(props.cardId) ?? []);
const childrenLoadState = computed(() => cardStore.childrenLoadState(props.cardId).status);

const positionLabel = computed<string | null>(() => {
  const position = props.position;
  if (!position) return null;
  switch (position.kind) {
    case 'ready': return `Ready at state ${position.stateId}.`;
    case 'entry': return `Observed at entry ${position.entry} (state ${position.stateId}).`;
    case 'node': return `Executing node ${position.nodeId} (ordinal ${position.executionOrdinal}).`;
    case 'terminal': return `Observed at terminal ${position.terminal}.`;
  }
});

const graph = computed(() => graphs.value?.find((candidate) => candidate.card_type === props.detail?.type) ?? null);

const positionGlossText = computed<string | null>(() => {
  const position = props.position;
  if (!position) return null;
  return positionGloss(position, graph.value);
});

const positionOutcomes = computed<{ label: string }[]>(() => {
  const position = props.position;
  const currentGraph = graph.value;
  if (!currentGraph || !position) return [];
  if (position.kind === 'node') {
    return currentGraph.edges
      .filter((edge) => edge.source_node_id === position.nodeId)
      .map((edge) => ({
        label: `${edge.outcome} (${edge.condition}) → ${edge.target.kind === 'node' ? `node ${edge.target.node_id}` : `terminal ${edge.target.terminal}`}`,
      }));
  }
  if (position.kind === 'entry') {
    const entry = currentGraph.entries.find((candidate) => candidate.entry === position.entry);
    return entry ? [{ label: `Configured entry ${entry.entry} activates node ${entry.node_id}.` }] : [];
  }
  return [];
});
</script>

<style scoped>
.card-flow-header {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 16px; background: var(--surface-1);
  border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.flow-title-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.flow-title { margin: 0; font-size: 16px; font-weight: 700; color: var(--text); }
.flow-id { font-size: 11px; color: var(--text-muted); }
.flow-kind { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border-strong); color: var(--text-muted); }
.flow-meta { font-size: 11px; color: var(--text-muted); }
.flow-unavailable { font-size: 11px; font-weight: 700; color: var(--warn); border: 1px solid var(--entry-warn-border); padding: 2px 8px; border-radius: 6px; }
.flow-questions { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.flow-question { min-width: 0; }
.flow-question-label { margin: 0 0 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
.flow-question-sub { font-size: 11px; color: var(--text-muted); margin-right: 6px; }
.flow-chain { margin: 0; padding-left: 0; list-style: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; font-size: 12px; }
.flow-chain li { display: inline-flex; align-items: baseline; gap: 4px; }
.flow-chain li:not(:last-child)::after { content: '→'; color: var(--border-strong); margin-left: 4px; }
.flow-chain a { color: var(--accent-2); text-decoration: underline; }
.flow-chain-kind { font-size: 10px; color: var(--text-muted); }
.flow-children { margin: 6px 0 0; display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; align-items: baseline; }
.flow-child-link { color: var(--accent-2); text-decoration: underline; }
.flow-child-kind { color: var(--text-muted); font-size: 10px; text-decoration: none; }
.flow-position { margin: 0 0 4px; font-size: 12px; color: var(--text); font-weight: 600; }
.flow-unavailable-note { margin: 0; font-size: 12px; color: var(--warn); }
.flow-muted { margin: 0 0 4px; font-size: 11px; color: var(--text-muted); }
.flow-outcomes { margin: 0 0 6px; padding-left: 18px; font-size: 12px; color: var(--text); }
.flow-graph-details > summary { cursor: pointer; font-size: 11px; color: var(--text-muted); }
.flow-graph-text { font-size: 11px; color: var(--text); margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
.flow-graph-text p { margin: 0; }
.flow-graph-label { font-weight: 700; margin-right: 6px; }
.flow-graph-item { display: inline-block; margin-right: 10px; font-size: 11px; }
.flow-graph-item .mono { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); }
.flow-position-gloss { margin: -2px 0 4px; }
.flow-header :deep(.view-state) { padding: 8px; }
.mono { font-family: var(--font-mono); }
</style>
