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

          <span class="node-type" :class="`type-${node.card.type}`">{{ shortLabelForCardType(node.card.type) }}</span>
          <StatusBadge :status="cardUiStatus(node.card.status)" show-dot />
          <span v-if="node.card.display_path" class="node-path">{{ node.card.display_path }}</span>
          <span class="node-title">{{ node.card.title }}</span>

          <span v-if="node.card.priority > 5" class="node-priority high">P{{ node.card.priority }}</span>

          <span v-if="node.card.tags.length" class="node-tags">
            <span v-for="tag in node.card.tags" :key="tag" class="node-tag">{{ tag }}</span>
          </span>

          <span v-if="node.card.depends_on.length" class="node-deps" :title="node.card.depends_on.join(', ')">
            ↳ {{ node.card.depends_on.length }}
          </span>
        </SelectableRow>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CardStatus, CardRecord } from '../../types/view-models';
import { shortLabelForCardType, toneForCardStatus, type UiStatus } from '../../utils/status';
import SelectableRow from '../ui/SelectableRow.vue';
import StatusBadge from '../ui/StatusBadge.vue';

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

function cardUiStatus(status: CardStatus): UiStatus {
  return { label: status, tone: toneForCardStatus(status) };
}
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

.node-type {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--surface-3);
  color: var(--text-muted);
  border: 1px solid var(--border);
  flex-shrink: 0;
  text-transform: uppercase;
  letter-spacing: .03em;
}

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

.node-priority {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--surface-3);
  flex-shrink: 0;
}

.node-priority.high {
  background: var(--entry-danger-bg);
  color: var(--danger);
}

.node-tags {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.node-tag {
  font-size: 10px;
  padding: 1px 5px;
  background: var(--entry-user-bg);
  color: var(--accent-2);
  border-radius: 3px;
  border: 1px solid var(--border);
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-deps {
  font-size: 10px;
  color: var(--text-muted);
  font-family: 'SF Mono', monospace;
  flex-shrink: 0;
}
</style>
