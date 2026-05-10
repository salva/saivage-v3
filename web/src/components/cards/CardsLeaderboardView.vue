<template>
  <div class="leaderboard-container">
    <div v-if="sortedCards.length === 0" class="lb-empty">
      No completed cards with metrics to display.
    </div>
    <div v-else class="lb-table-wrapper">
      <table class="lb-table">
        <thead>
          <tr>
            <th class="col-rank">#</th>
            <th class="col-title">Card</th>
            <th class="col-type">Type</th>
            <th class="col-score">Priority</th>
            <th class="col-metric">Duration</th>
            <th class="col-metric">Retries</th>
            <th class="col-metric" v-for="key in metricKeys" :key="key">{{ key }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(card, idx) in sortedCards"
            :key="card.id"
            class="lb-row"
            :class="{ 'row-done': card.status === 'done', 'row-failed': card.status === 'failed' }"
            @click="emit('select', card.id)"
          >
            <td class="col-rank">{{ idx + 1 }}</td>
            <td class="col-title">
              <span class="card-type-icon">{{ typeIcon(card.type) }}</span>
              {{ card.title }}
            </td>
            <td class="col-type">{{ card.type }}</td>
            <td class="col-score">
              <span :class="{ 'high-priority': card.priority > 5 }">{{ card.priority }}</span>
            </td>
            <td class="col-metric">{{ formatDuration(card.duration_ms) }}</td>
            <td class="col-metric">{{ card.retries }}</td>
            <td
              v-for="key in metricKeys"
              :key="key"
              class="col-metric"
            >
              {{ formatMetric(card.metrics?.[key]) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CardRecord, CardType } from '../../api/types';

const props = defineProps<{
  cards: CardRecord[];
}>();

const emit = defineEmits<{
  select: [id: string];
}>();

const TYPE_ICONS: Record<CardType, string> = {
  project: '🏠', goal: '🎯', plan: '📋', architecture: '🏗️',
  code: '💻', test: '🧪', doc: '📄', data: '📊',
  research: '🔬', ops: '⚙️',
};

function typeIcon(type: CardType): string {
  return TYPE_ICONS[type] || '❓';
}

// ── Filter & sort: only done/failed cards with metrics ─────

const sortedCards = computed<CardRecord[]>(() => {
  return props.cards
    .filter((c) => (c.status === 'done' || c.status === 'failed') && c.metrics)
    .sort((a, b) => {
      // Sort by priority desc, then duration asc
      if (a.priority !== b.priority) return b.priority - a.priority;
      return (a.duration_ms || 0) - (b.duration_ms || 0);
    });
});

// ── Discover metric keys ──────────────────────────────────

const metricKeys = computed<string[]>(() => {
  const keys = new Set<string>();
  for (const card of sortedCards.value) {
    if (card.metrics) {
      for (const key of Object.keys(card.metrics)) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
});

// ── Formatting ────────────────────────────────────────────

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatMetric(val: unknown): string {
  if (val === null || val === undefined) return '-';
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return val.toString();
    return val.toFixed(2);
  }
  return String(val);
}
</script>

<style scoped>
.leaderboard-container {
  height: 100%;
  overflow: auto;
}

.lb-empty {
  padding: 32px;
  text-align: center;
  color: #484f58;
  font-size: 13px;
}

.lb-table-wrapper {
  overflow-x: auto;
}

.lb-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.lb-table th {
  text-align: left;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  border-bottom: 1px solid #30363d;
  background: #161b22;
  position: sticky;
  top: 0;
  z-index: 1;
}

.lb-table td {
  padding: 8px 12px;
  border-bottom: 1px solid #21262d;
  color: #c9d1d9;
}

.col-rank {
  width: 40px;
  color: #484f58;
  font-family: 'SF Mono', monospace;
  text-align: right;
}

.col-title {
  min-width: 200px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.card-type-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.col-type {
  text-transform: capitalize;
  color: #8b949e;
  font-size: 12px;
}

.col-score {
  font-family: 'SF Mono', monospace;
  text-align: right;
}

.col-metric {
  font-family: 'SF Mono', monospace;
  font-size: 12px;
  text-align: right;
}

.high-priority {
  color: #f85149;
  font-weight: 600;
}

.lb-row {
  cursor: pointer;
  transition: background 0.1s;
}

.lb-row:hover {
  background: #161b22;
}

.row-done {
  border-left: 3px solid #3fb950;
}

.row-failed {
  border-left: 3px solid #f85149;
  opacity: 0.7;
}
</style>
