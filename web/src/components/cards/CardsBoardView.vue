<template>
  <div class="board-container">
    <div v-if="filteredCards.length === 0" class="board-empty">
      No cards to display with current filters.
    </div>
    <div v-else class="board-columns">
      <div
        v-for="col in columns"
        :key="col.status"
        class="board-column"
      >
        <div class="column-header">
          <span class="column-title">
            <span class="column-dot" :class="'status-' + col.status"></span>
            {{ col.status }}
          </span>
          <span class="column-count">{{ col.cards.length }}</span>
        </div>
        <div class="column-cards">
          <div
            v-for="card in col.cards"
            :key="card.id"
            class="board-card"
            @click="emit('select', card.id)"
          >
            <div class="card-header-row">
              <span class="card-type-icon">{{ typeIcon(card.type) }}</span>
              <span class="card-title">{{ card.title }}</span>
            </div>
            <div class="card-meta">
              <span v-if="card.priority > 5" class="card-priority high">P{{ card.priority }}</span>
              <span v-else class="card-priority">P{{ card.priority }}</span>
              <span v-if="card.tags.length" class="card-tags">
                <span v-for="tag in card.tags.slice(0, 2)" :key="tag" class="card-tag">{{ tag }}</span>
                <span v-if="card.tags.length > 2" class="card-tag-more">+{{ card.tags.length - 2 }}</span>
              </span>
            </div>
            <div v-if="card.depends_on.length" class="card-deps">
              {{ card.depends_on.length }} dep{{ card.depends_on.length === 1 ? '' : 's' }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CardRecord, CardStatus, CardType } from '../../api/types';

const props = defineProps<{
  board: Map<CardStatus, CardRecord[]>;
  filteredCards: CardRecord[];
}>();

const emit = defineEmits<{
  select: [id: string];
}>();

const TYPE_ICONS: Record<CardType, string> = {
  project: '🏠', goal: '🎯', architecture: '🏗️',
  code: '💻', test: '🧪', doc: '📄', data: '📊',
  research: '🔬', ops: '⚙️',
};

function typeIcon(type: CardType): string {
  return TYPE_ICONS[type] || '❓';
}

const STATUS_ORDER: CardStatus[] = [
  'drafting', 'backlog', 'active', 'running', 'blocked', 'changed', 'done', 'failed', 'cancelled', 'needs_verification',
];

interface Column {
  status: CardStatus;
  cards: CardRecord[];
}

const columns = computed<Column[]>(() =>
  STATUS_ORDER.map((status) => ({
    status,
    cards: props.board.get(status) || [],
  })),
);

</script>

<style scoped>
.board-container {
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
}

.board-empty {
  padding: 32px;
  text-align: center;
  color: var(--border-strong);
  font-size: 13px;
}

.board-columns {
  display: flex;
  gap: 0;
  min-height: 100%;
  height: 100%;
}

.board-column {
  flex: 1;
  min-width: 200px;
  max-width: 300px;
  border-right: 1px solid var(--surface-3);
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.board-column:last-child {
  border-right: none;
}

.column-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--surface-3);
  flex-shrink: 0;
}

.column-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  text-transform: capitalize;
}

.column-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-drafting { background: var(--border-strong); }
.status-backlog { background: var(--text-muted); }
.status-active { background: var(--accent-2); }
.status-running { background: var(--accent); }
.status-blocked { background: var(--warn); }
.status-changed { background: var(--purple); }
.status-done { background: var(--accent); }
.status-failed { background: var(--danger); }
.status-cancelled { background: var(--border-strong); }
.status-needs_verification { background: var(--warn); }

.column-count {
  font-size: 11px;
  color: var(--border-strong);
  font-family: 'SF Mono', monospace;
}

.column-cards {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.board-card {
  background: var(--surface-1);
  border: 1px solid var(--surface-3);
  border-radius: 6px;
  padding: 10px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.board-card:hover {
  border-color: var(--border);
  background: var(--surface-2);
}

.card-header-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.card-type-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.card-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.card-priority {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--surface-3);
  color: var(--text-muted);
}

.card-priority.high {
  background: var(--entry-danger-bg);
  color: var(--danger);
}

.card-tags {
  display: flex;
  gap: 2px;
}

.card-tag {
  font-size: 10px;
  padding: 1px 5px;
  background: var(--entry-user-bg);
  color: var(--accent-2);
  border-radius: 3px;
  border: 1px solid var(--border);
}

.card-tag-more {
  font-size: 10px;
  color: var(--border-strong);
}

.card-deps {
  margin-top: 6px;
  font-size: 10px;
  color: var(--text-muted);
}
</style>
