<template>
  <div class="tree-container">
    <div v-if="tree.length === 0" class="tree-empty">No cards available.</div>
    <ul v-else class="tree-list">
      <li v-for="node in renderedTree" :key="node.card.id">
        <SelectableRow
          as="div"
          class="tree-node"
          :selected="selectedCardId === node.card.id"
          :style="{ paddingLeft: `${node.depth * 20 + 8}px` }"
          @select="emit('select', node.card.id)"
        >
          <button
            v-if="node.mayHaveChildren"
            type="button"
            class="node-toggle"
            :disabled="isRouteForced(node.card.id) || loadStateFor(node.card.id).status === 'loading'"
            :aria-label="toggleLabel(node)"
            @click.stop="emit('toggle', node.card.id)"
          >{{ loadStateFor(node.card.id).status === 'loading' ? '…' : isEffectivelyExpanded(node.card.id) ? '▾' : '▸' }}</button>
          <span v-else class="node-toggle placeholder"></span>
          <span class="state-ball" :class="`card-status-${node.card.lifecycle.status}`" aria-hidden="true"></span>
          <span v-if="node.logicalPath" class="node-path">{{ node.logicalPath }}</span>
          <span class="node-title">{{ node.card.title }}</span>
          <span class="node-kind">{{ labelForCardType(node.card.type) }}</span>
          <span v-if="loadStateFor(node.card.id).stale" class="node-stale">stale</span>
          <button v-if="loadStateFor(node.card.id).status === 'error' || loadStateFor(node.card.id).staleReason === 'refresh-failed'" type="button" class="node-retry" @click.stop="emit('retry', node.card.id)">Retry</button>
        </SelectableRow>
        <div v-if="loadStateFor(node.card.id).status === 'error'" class="node-error" :style="{ paddingLeft: `${node.depth * 20 + 44}px` }">{{ loadStateFor(node.card.id).error }}</div>
        <div v-else-if="loadStateFor(node.card.id).stale" class="node-error" :style="{ paddingLeft: `${node.depth * 20 + 44}px` }">{{ loadStateFor(node.card.id).refreshError ?? 'Refreshing card branch.' }}</div>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CardTreeNode, ChildrenLoadState } from '../../stores/cards';
import { labelForCardType } from '../../utils/status';
import SelectableRow from '../ui/SelectableRow.vue';

const props = defineProps<{
  tree: readonly CardTreeNode[];
  expandedIds: Set<string>;
  forcedExpandedIds: Set<string>;
  selectedCardId: string | null;
  loadStateFor: (id: string) => ChildrenLoadState;
}>();
const emit = defineEmits<{ toggle: [id: string]; retry: [id: string]; select: [id: string] }>();

interface RenderedNode extends CardTreeNode { depth: number; mayHaveChildren: boolean }
function isEffectivelyExpanded(id: string): boolean { return props.expandedIds.has(id); }
function isRouteForced(id: string): boolean { return props.forcedExpandedIds.has(id); }
function toggleLabel(node: RenderedNode): string {
  if (isRouteForced(node.card.id)) return `${node.card.title}: Expanded to show selected card`;
  return isEffectivelyExpanded(node.card.id) ? `Collapse ${node.card.title}` : `Expand ${node.card.title}`;
}
const renderedTree = computed<RenderedNode[]>(() => {
  const flat: RenderedNode[] = [];
  const walk = (nodes: readonly CardTreeNode[], depth: number): void => {
    for (const node of nodes) {
      const state = props.loadStateFor(node.card.id);
      const mayHaveChildren = state.status === 'loaded' ? node.childNodes.length > 0 : node.card.children.length > 0;
      flat.push({ ...node, depth, mayHaveChildren });
      if (isEffectivelyExpanded(node.card.id) && state.status === 'loaded') walk(node.childNodes, depth + 1);
    }
  };
  walk(props.tree, 0);
  return flat;
});
</script>

<style scoped>
.tree-container { padding:4px 0; }
.tree-empty { padding:32px; text-align:center; color:var(--border-strong); font-size:13px; }
.tree-list { list-style:none; padding:0; margin:0; }
.tree-node { padding:5px 12px 5px 8px; transition:background .1s; font-size:13px; line-height:1.4; border-left:3px solid transparent; min-height:32px; }
.tree-node.selected { background:var(--entry-user-bg); border-left-color:var(--accent-2); }
.node-toggle { border:0; background:transparent; width:16px; height:16px; display:flex; align-items:center; justify-content:center; font-size:10px; color:var(--text-muted); cursor:pointer; flex-shrink:0; border-radius:3px; }
.node-toggle:hover { color:var(--text); background:var(--surface-3); }
.node-toggle.placeholder { visibility:hidden; }
.state-ball { width:8px; height:8px; border-radius:999px; flex-shrink:0; }
.state-ball.card-status-backlog { background:var(--card-status-backlog); border:1px solid var(--border-strong); }
.state-ball.card-status-running { background:var(--card-status-running); }
.state-ball.card-status-blocked { background:var(--card-status-blocked); }
.state-ball.card-status-changed { background:var(--card-status-changed); }
.state-ball.card-status-stopped { background:var(--card-status-stopped); box-shadow:0 0 0 1px var(--card-status-stopped-ring); }
.state-ball.card-status-done { background:var(--card-status-done); }
.state-ball.card-status-failed { background:var(--card-status-failed); }
.state-ball.card-status-cancelled { background:var(--card-status-cancelled); }
.node-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text); }
.node-path { color:var(--accent-2); font-family:'SF Mono',monospace; font-size:11px; font-weight:600; flex-shrink:0; }
.node-kind { font-size:11px; color:var(--text-muted); flex-shrink:0; }
.node-retry { border:1px solid var(--border); background:var(--surface-2); color:var(--text); border-radius:4px; cursor:pointer; font-size:11px; }
.node-stale { color:var(--warn); font-size:11px; }
.node-error { color:var(--danger); font-size:11px; padding-top:2px; padding-bottom:4px; }
</style>
