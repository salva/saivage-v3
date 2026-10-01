<template>
  <header
    class="card-flow-header"
    :data-flow-unavailable="flowUnavailable ? 'true' : undefined"
    aria-label="Card workflow context and technical details"
    tabindex="0"
  >
    <div class="flow-title-row">
      <h2 class="flow-title" data-testid="card-flow-title">{{ detail?.title ?? cardId }}</h2>
      <span v-if="detail" class="flow-kind">{{ labelForCardType(detail.type) }}</span>
      <StatusBadge v-if="detail" :status="statusForCard(detail.lifecycle.status)" />
      <span class="flow-id mono" :title="cardId" data-testid="card-flow-id">{{ cardId }}</span>
      <span v-if="flowUnavailable" class="flow-unavailable" data-testid="card-flow-unavailable">Card flow unavailable</span>
    </div>

    <nav v-if="!flowUnavailable && chainCards.length" class="flow-chain-nav" aria-label="Represented card path">
      <ol class="flow-chain" data-testid="card-flow-chain">
        <li v-for="card in chainCards" :key="card.id">
          <router-link :to="{ name: 'card-detail', params: { id: card.id } }">{{ card.title }}</router-link>
        </li>
      </ol>
    </nav>
    <p v-else-if="flowUnavailable" class="flow-unavailable-note" data-testid="card-flow-context-unavailable">
      The represented chain for this card is unavailable. No hierarchy is inferred.
    </p>

    <p class="flow-position" data-testid="card-flow-position">
      <strong>Observed workflow step:</strong> {{ observedPosition }}
    </p>

    <details class="flow-technical" data-testid="card-flow-technical">
      <summary>Workflow &amp; technical details</summary>
      <div class="flow-technical-body">
        <section>
          <h3>Exact workflow observation</h3>
          <p v-if="position" class="mono" data-testid="card-flow-exact-position">{{ exactPosition }}</p>
          <p v-else>No current workflow position is available. This does not mean idle or finished.</p>
          <p>Workflow position is a runtime observation; it does not prove that an agent or session is currently busy.</p>
        </section>

        <section v-if="detail">
          <h3>Card publication</h3>
          <p>Card revision {{ detail.version_seq }} · updated {{ fmtDate(detail.updated_at) }}</p>
          <p>Card revision counts card publications; it is not a measure of work completed.</p>
        </section>

        <section>
          <h3>Configured outcomes</h3>
          <template v-if="graph">
            <ul v-if="positionOutcomes.length" class="flow-outcomes" data-testid="card-flow-outcomes">
              <li v-for="outcome in positionOutcomes" :key="outcome">{{ outcome }}</li>
            </ul>
            <p v-else-if="position?.kind === 'terminal'">The observed terminal has no configured outgoing outcomes.</p>
            <p v-else>The observation is not pinned to configured outgoing outcomes.</p>
            <p>Configured outcomes are possibilities, not predictions or history.</p>
          </template>
          <ViewState v-else-if="graphsLoading" state="loading" title="Loading configured workflow" />
          <ViewState v-else-if="graphsError" state="error" title="Configured workflow unavailable" :message="graphsError">
            <template #action><button type="button" @click="retryGraphs">Retry</button></template>
          </ViewState>
          <p v-else>No installed workflow is available for this card type.</p>
        </section>

        <section v-if="graph" class="flow-graph-details">
          <h3>Full configured workflow ({{ graph.card_type }})</h3>
          <p class="flow-graph-row"><strong>Nodes:</strong>
            <span v-for="node in graph.nodes" :key="node.node_id">{{ node.agent_name }} — node <span class="mono">{{ node.node_id }}</span></span>
          </p>
          <p class="flow-graph-row"><strong>Entries:</strong>
            <span v-for="entry in graph.entries" :key="entry.entry"><span class="mono">{{ entry.entry }}</span> → node <span class="mono">{{ entry.node_id }}</span></span>
          </p>
          <p class="flow-graph-row"><strong>Edges:</strong>
            <span v-for="edge in graph.edges" :key="`${edge.source_node_id}:${edge.outcome}`"><span class="mono">{{ edge.source_node_id }}</span> —{{ edge.outcome }} ({{ edge.condition }})→ {{ edge.target.kind === 'node' ? `node ${edge.target.node_id}` : `terminal ${edge.target.terminal}` }}</span>
          </p>
          <p class="flow-graph-row"><strong>Terminals:</strong>
            <span v-for="terminal in graph.terminals" :key="terminal.terminal">{{ terminal.terminal }}</span>
          </p>
          <p class="flow-graph-row"><strong>Records:</strong>
            <span v-for="record in graph.records" :key="record.name">{{ record.name }}{{ record.bootstrap ? ' (bootstrap)' : '' }}</span>
          </p>
        </section>
      </div>
    </details>
  </header>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import type { CardDetail, CardWorkflowPosition } from '../../api/types';
import { cardRouteChain, useCardStore } from '../../stores/cards';
import { useWorkflowPresentationStore } from '../../stores/workflowPresentation';
import { formatRecentTimestamp } from '../../utils/timestamp';
import { labelForCardType, statusForCard } from '../../utils/status';
import { positionGloss } from '../../utils/legibility';
import StatusBadge from '../ui/StatusBadge.vue';
import ViewState from '../ui/ViewState.vue';

const props = defineProps<{
  cardId: string;
  detail: CardDetail | null;
  flowUnavailable?: boolean;
  position: CardWorkflowPosition | null;
}>();

const cardStore = useCardStore();
const presentations = useWorkflowPresentationStore();
const presentation = computed(() => props.detail ? presentations.scope(props.detail.type) : null);
const graphsLoading = computed(() => presentation.value?.loading ?? false);
const graphsError = computed(() => presentation.value?.error ?? null);
watch(() => props.detail?.type, (type) => { if (type) void presentations.fetch(type); }, { immediate: true });
function retryGraphs(): void { if (props.detail) void presentations.fetch(props.detail.type); }
function fmtDate(ts: string): string { return formatRecentTimestamp(ts); }

const chainCards = computed(() => cardRouteChain(props.cardId)
  .map((id) => cardStore.hierarchyCardById(id))
  .filter((card): card is NonNullable<typeof card> => card !== null));

const graph = computed(() => presentation.value?.value ?? null);

const observedPosition = computed(() => {
  const position = props.position;
  if (!position) return 'No current workflow position is available.';
  if (position.kind === 'node') return positionGloss(position, graph.value) ?? 'Workflow details are unavailable for the observed node.';
  if (position.kind === 'entry') return 'At a configured workflow entry.';
  if (position.kind === 'ready') return 'Ready for a configured workflow entry.';
  return 'At a configured terminal; this is not lifecycle acceptance.';
});

const exactPosition = computed(() => {
  const position = props.position;
  if (!position) return '';
  if (position.kind === 'node') return `state ${position.stateId}; node ${position.nodeId}; execution ordinal ${position.executionOrdinal}`;
  if (position.kind === 'entry') return `state ${position.stateId}; entry ${position.entry}`;
  if (position.kind === 'ready') return `state ${position.stateId}; ready`;
  return `state ${position.stateId}; terminal ${position.terminal}`;
});

const positionOutcomes = computed<string[]>(() => {
  const position = props.position;
  if (!graph.value || !position) return [];
  if (position.kind === 'node') return graph.value.edges
    .filter((edge) => edge.source_node_id === position.nodeId)
    .map((edge) => `${edge.outcome} (${edge.condition}) → ${edge.target.kind === 'node' ? `node ${edge.target.node_id}` : `terminal ${edge.target.terminal}`}`);
  if (position.kind === 'entry') {
    const entry = graph.value.entries.find((candidate) => candidate.entry === position.entry);
    return entry ? [`Configured entry ${entry.entry} activates node ${entry.node_id}.`] : [];
  }
  return [];
});
</script>

<style scoped>
.card-flow-header {
  box-sizing: border-box; display: flex; flex: 0 1 auto; flex-direction: column; gap: 7px;
  min-height: 0; max-block-size: 45%; overflow-y: auto; padding: 10px 16px;
  background: var(--surface-1); border-bottom: 1px solid var(--border); overflow-wrap: anywhere;
}
.card-flow-header:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.flow-title-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.flow-title { margin: 0; font-size: 16px; font-weight: 700; color: var(--text); }
.flow-id { font-size: 11px; color: var(--text-muted); }
.flow-kind { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border-strong); color: var(--text-muted); }
.flow-unavailable { font-size: 11px; font-weight: 700; color: var(--warn); border: 1px solid var(--entry-warn-border); padding: 2px 8px; border-radius: 6px; }
.flow-chain { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 4px; font-size: 11px; }
.flow-chain li:not(:last-child)::after { content: '›'; color: var(--border-strong); margin-left: 4px; }
.flow-chain a { color: var(--accent-2); text-decoration: underline; }
.flow-position, .flow-unavailable-note { margin: 0; font-size: 12px; color: var(--text); }
.flow-unavailable-note { color: var(--warn); }
.flow-technical > summary { cursor: pointer; font-size: 12px; color: var(--text-muted); font-weight: 600; }
.flow-technical-body { display: flex; flex-direction: column; gap: 10px; padding-top: 8px; font-size: 11px; color: var(--text-muted); }
.flow-technical-body section { min-width: 0; }
.flow-technical-body h3 { margin: 0 0 4px; font-size: 11px; color: var(--text); }
.flow-technical-body p { margin: 2px 0; }
.flow-outcomes { margin: 3px 0; padding-left: 18px; color: var(--text); }
.flow-graph-details { padding-bottom: 4px; }
.flow-graph-row { display: flex; flex-wrap: wrap; gap: 4px 10px; }
.flow-graph-row > span { display: inline-block; }
.flow-technical-body :deep(.view-state) { padding: 8px 0; }
.mono { font-family: var(--font-mono); }
</style>
