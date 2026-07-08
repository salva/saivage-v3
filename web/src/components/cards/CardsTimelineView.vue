<template>
  <div class="timeline-container">
    <ViewState v-if="sortedEvents.length === 0" state="empty" title="No card events" message="Activity will appear here as cards are created, transition status, and complete." />
    <div v-else class="timeline-track">
      <SelectableRow
        v-for="event in sortedEvents"
        :key="event.card.id + '-' + event.card.status"
        as="div"
        class="timeline-event"
        @select="emit('select', event.card.id)"
      >
        <div class="tl-marker" :class="'status-' + event.card.status">
          <span class="tl-icon">{{ statusIcon(event.card.status) }}</span>
        </div>
        <div class="tl-content">
          <div class="tl-title">
            <span class="tl-type-icon">{{ typeIcon(event.card.type) }}</span>
            <span v-if="event.card.display_path" class="tl-display-path">{{ event.card.display_path }}</span>
            {{ event.card.title }}
          </div>
          <div class="tl-meta">
            <StatusBadge :status="statusForCard(event.card.status)" />
            <span class="tl-time" :title="timestampTitle(event.mostRecent)">{{ formatTime(event.mostRecent) }}</span>
            <span v-if="event.card.duration_ms" class="tl-duration">
              {{ formatDuration(event.card.duration_ms) }}
            </span>
          </div>
          <div v-if="event.card.lifecycle.error" class="tl-error">{{ event.card.lifecycle.error }}</div>
        </div>
      </SelectableRow>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CardRecord, CardStatus, CardType } from '../../types/view-models';
import { formatTimestamp, timestampTitle } from '../../utils/timestamp';
import { statusForCard } from '../../utils/status';
import SelectableRow from '../ui/SelectableRow.vue';
import StatusBadge from '../ui/StatusBadge.vue';
import ViewState from '../ui/ViewState.vue';

const props = defineProps<{
  cards: CardRecord[];
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

function statusIcon(status: CardStatus): string {
  const icons: Record<CardStatus, string> = {
    backlog: '📋', running: '⚡',
    blocked: '⛔', changed: '✎', done: '✅', failed: '❌', cancelled: '🚫',
  };
  return icons[status] || '●';
}

// ── Sort cards by most recent timestamp ───────────────────

interface TimelineEvent {
  card: CardRecord;
  mostRecent: string; // ISO timestamp
}

const sortedEvents = computed<TimelineEvent[]>(() => {
  return props.cards
    .map((card) => ({
      card,
      mostRecent: card.lifecycle.completed_at || card.started_at || card.updated_at || card.created_at,
    }))
    .sort((a, b) => new Date(b.mostRecent).getTime() - new Date(a.mostRecent).getTime());
});

// ── Formatting ────────────────────────────────────────────

function formatTime(ts: string): string {
  return formatTimestamp(ts, 'relative');
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}
</script>

<style scoped>
.timeline-container {
  height: 100%;
  overflow-y: auto;
}

.timeline-container > :deep(.view-state) { padding: 32px; justify-content: center; text-align: center; }

.timeline-track {
  position: relative;
  padding: 12px 16px;
}

.timeline-track::before {
  content: '';
  position: absolute;
  left: 27px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--surface-3);
}

.timeline-event {
  gap: 14px;
  padding: 10px 0;
  position: relative;
}

.timeline-event:hover .tl-title {
  color: var(--accent-2);
}

.tl-marker {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--surface-3);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  z-index: 1;
  font-size: 14px;
}

.tl-marker.status-backlog { background: var(--c-white); border: 2px solid var(--border-strong); }
.tl-marker.status-done { background: var(--card-status-done); }
.tl-marker.status-failed { background: var(--card-status-failed); }
.tl-marker.status-running { background: var(--card-status-running); }
.tl-marker.status-blocked { background: var(--card-status-blocked); }
.tl-marker.status-changed { background: var(--card-status-changed); }
.tl-marker.status-cancelled { background: var(--card-status-cancelled); }

.tl-icon {
  font-size: 12px;
}

.tl-content {
  flex: 1;
  min-width: 0;
}

.tl-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 6px;
  transition: color 0.1s;
}

.tl-type-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.tl-display-path {
  color: var(--accent-2);
  font-family: 'SF Mono', monospace;
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
}

.tl-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 3px;
}

.tl-time {
  font-size: 11px;
  color: var(--border-strong);
}

.tl-duration {
  font-size: 11px;
  color: var(--text-muted);
  font-family: 'SF Mono', monospace;
}

.tl-error {
  margin-top: 4px;
  font-size: 11px;
  color: var(--danger);
  padding: 4px 8px;
  background: var(--entry-danger-bg);
  border-radius: 4px;
  border: 1px solid var(--danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
