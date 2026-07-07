<template>
  <div class="tree-container">
    <div v-if="tree.length === 0" class="tree-empty">
      No cards match the current read-only filters.
    </div>
    <ul v-else class="tree-list">
      <li v-for="node in renderedTree" :key="node.card.id">
        <SelectableRow
          as="div"
          class="tree-node"
          :style="{ paddingLeft: `${node.depth * 20 + 8}px` }"
          @select="emit('select', node.card.id)"
        >
          <button
            v-if="node.hasChildren"
            type="button"
            class="node-toggle"
            :aria-label="expandedIds.has(node.card.id) ? `Collapse ${node.card.title}` : `Expand ${node.card.title}`"
            @click.stop="emit('toggle', node.card.id)"
          >
            {{ expandedIds.has(node.card.id) ? '▾' : '▸' }}
          </button>
          <span v-else class="node-toggle placeholder"></span>

          <span class="state-ball" :class="`tone-${toneForCardStatus(node.card.status)}`" aria-hidden="true"></span>
          <span v-if="node.card.display_path" class="node-path">{{ node.card.display_path }}</span>
          <span class="node-title">{{ node.card.title }}</span>
          <span class="node-kind">{{ labelForCardType(node.card.type) }}</span>
        </SelectableRow>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CardRecord } from '../../types/view-models';
import { labelForCardType, toneForCardStatus } from '../../utils/status';
import SelectableRow from '../ui/SelectableRow.vue';

const props = defineProps<{
  cards: CardRecord[];
  tree: CardRecord[];
  expandedIds: Set<string>;
}>();

const emit = defineEmits<{
  toggle: [id: string];
  select: [id: string];
}>();

// ── Tree Rendering ────────────────────────────────────────

interface TreeNode {
  card: CardRecord;
  depth: number;
  hasChildren: boolean;
  children: CardRecord[];
}

const renderedTree = computed<TreeNode[]>(() => {
  const flat: TreeNode[] = [];
  const childrenMap = new Map<string, CardRecord[]>();

  for (const card of props.cards) {
    if (card.parent) {
      const existing = childrenMap.get(card.parent) || [];
      existing.push(card);
      childrenMap.set(card.parent, existing);
    }
  }


  function walk(nodes: CardRecord[], depth: number): void {
    for (const card of nodes) {
      const children = childrenMap.get(card.id) || [];
      const hasChildren = children.length > 0;
      flat.push({ card, depth, hasChildren, children });

      if (hasChildren && props.expandedIds.has(card.id)) {
        walk(children, depth + 1);
      }
    }
  }

  walk(props.tree, 0);

  return flat;
});

</script>

<style scoped>
.tree-container {
  padding: 4px 0;
}

.tree-empty {
  padding: 32px;
  text-align: center;
  color: var(--border-strong);
  font-size: 13px;
}

.tree-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.tree-node {
  padding: 5px 12px 5px 8px;
  transition: background 0.1s;
  font-size: 13px;
  line-height: 1.4;
  border-left: 3px solid transparent;
  min-height: 32px;
}

.node-toggle {
  border: 0;
  background: transparent;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
  border-radius: 3px;
}

.node-toggle:hover {
  color: var(--text);
  background: var(--surface-3);
}

.node-toggle.placeholder {
  visibility: hidden;
}

.state-ball {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
}

.state-ball.tone-neutral { background: var(--text-muted); }
.state-ball.tone-active { background: var(--accent-2); }
.state-ball.tone-info { background: var(--accent-2); }
.state-ball.tone-success { background: var(--accent); }
.state-ball.tone-warning { background: var(--warn); }
.state-ball.tone-danger { background: var(--danger); }
.state-ball.tone-pending { background: var(--warn); }
.state-ball.tone-stale { background: var(--warn); }
.state-ball.tone-unauthorized { background: var(--danger); }
.state-ball.tone-offline { background: var(--border-strong); }

.node-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.tree-node:hover .node-title {
  color: var(--text);
}

.node-path {
  color: var(--accent-2);
  font-family: 'SF Mono', monospace;
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
}

.node-kind {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}
</style>
