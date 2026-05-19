<template>
  <div class="tree-container">
    <div v-if="tree.length === 0" class="tree-empty">
      No cards to display. Click "+ New Card" to create one.
    </div>
    <ul v-else class="tree-list">
      <li v-for="node in renderedTree" :key="node.card.id">
        <div
          class="tree-node"
          :style="{ paddingLeft: `${node.depth * 20 + 8}px` }"
          @click="emit('select', node.card.id)"
          @contextmenu.prevent="emit('action', node.card, $event)"
        >
          <!-- Expand/collapse toggle -->
          <span
            v-if="node.hasChildren"
            class="node-toggle"
            @click.stop="emit('toggle', node.card.id)"
          >
            {{ expandedIds.has(node.card.id) ? '▾' : '▸' }}
          </span>
          <span v-else class="node-toggle placeholder"></span>

          <!-- Type icon -->
          <span class="node-type-icon">{{ typeIcon(node.card.type) }}</span>

          <!-- Status dot -->
          <span class="node-status-dot" :class="`status-${node.card.status}`"></span>

          <!-- Title -->
          <span class="node-title">{{ node.card.title }}</span>

          <!-- Priority -->
          <span v-if="node.card.priority > 5" class="node-priority high">P{{ node.card.priority }}</span>

          <!-- Tags -->
          <span v-if="node.card.tags.length" class="node-tags">
            <span v-for="tag in node.card.tags" :key="tag" class="node-tag">{{ tag }}</span>
          </span>

          <!-- Depends on -->
          <span v-if="node.card.depends_on.length" class="node-deps" :title="node.card.depends_on.join(', ')">
            ↳ {{ node.card.depends_on.length }}
          </span>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CardRecord, CardType } from '../../api/types';

const props = defineProps<{
  cards: CardRecord[];
  tree: CardRecord[];
  expandedIds: Set<string>;
}>();

const emit = defineEmits<{
  toggle: [id: string];
  select: [id: string];
  action: [card: CardRecord, event: MouseEvent];
}>();

// ── Type Icons ────────────────────────────────────────────

const TYPE_ICONS: Record<CardType, string> = {
  project: '🏠',
  goal: '🎯',
  architecture: '🏗️',
  code: '💻',
  test: '🧪',
  doc: '📄',
  data: '📊',
  research: '🔬',
  ops: '⚙️',
};

function typeIcon(type: CardType): string {
  return TYPE_ICONS[type] || '❓';
}

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

  // Sort children
  for (const [, children] of childrenMap) {
    children.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.title.localeCompare(b.title);
    });
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

  const sortedRoots = [...props.tree].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.title.localeCompare(b.title);
  });
  walk(sortedRoots, 0);

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
  color: #484f58;
  font-size: 13px;
}

.tree-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.tree-node {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px 5px 8px;
  cursor: pointer;
  transition: background 0.1s;
  font-size: 13px;
  line-height: 1.4;
  border-left: 3px solid transparent;
  min-height: 32px;
}

.tree-node:hover {
  background: #161b22;
}

.tree-node:has(.status-running) {
  border-left-color: #58a6ff;
}

.node-toggle {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: #8b949e;
  cursor: pointer;
  flex-shrink: 0;
  border-radius: 3px;
}

.node-toggle:hover {
  color: #c9d1d9;
  background: #21262d;
}

.node-toggle.placeholder {
  visibility: hidden;
}

.node-type-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.node-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-drafting { background: #484f58; }
.status-backlog { background: #8b949e; }
.status-active { background: #58a6ff; }
.status-running { background: #3fb950; animation: pulse-dot 2s infinite; }
.status-blocked { background: #d29922; }
.status-done { background: #7ee787; }
.status-failed { background: #f85149; }
.status-cancelled { background: #484f58; opacity: 0.5; }

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.node-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #c9d1d9;
}

.tree-node:hover .node-title {
  color: #f0f6fc;
}

.node-priority {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 4px;
  border-radius: 3px;
  background: #21262d;
  flex-shrink: 0;
}

.node-priority.high {
  background: #241818;
  color: #f85149;
}

.node-tags {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.node-tag {
  font-size: 10px;
  padding: 1px 5px;
  background: #1c2738;
  color: #58a6ff;
  border-radius: 3px;
  border: 1px solid #30363d;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-deps {
  font-size: 10px;
  color: #8b949e;
  font-family: 'SF Mono', monospace;
  flex-shrink: 0;
}
</style>
