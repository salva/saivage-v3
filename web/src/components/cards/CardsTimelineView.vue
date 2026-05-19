<template>
  <div class="timeline-container">
    <div v-if="sortedEvents.length === 0" class="tl-empty">
      No card events to display. Activity will appear here as cards are created, transition status, and complete.
    </div>
    <div v-else class="timeline-track">
      <div
        v-for="event in sortedEvents"
        :key="event.card.id + '-' + event.card.status"
        class="timeline-event"
        @click="emit('select', event.card.id)"
      >
        <div class="tl-marker" :class="'status-' + event.card.status">
          <span class="tl-icon">{{ statusIcon(event.card.status) }}</span>
        </div>
        <div class="tl-content">
          <div class="tl-title">
            <span class="tl-type-icon">{{ typeIcon(event.card.type) }}</span>
            {{ event.card.title }}
          </div>
          <div class="tl-meta">
            <span class="tl-status" :class="'status-' + event.card.status">{{ event.card.status }}</span>
            <span class="tl-time" :title="timestampTitle(event.mostRecent)">{{ formatTime(event.mostRecent) }}</span>
            <span v-if="event.card.duration_ms" class="tl-duration">
              {{ formatDuration(event.card.duration_ms) }}
            </span>
          </div>
          <div v-if="event.card.error" class="tl-error">{{ event.card.error }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CardRecord, CardStatus, CardType } from '../../api/types';
import { formatTimestamp, timestampTitle } from '../../utils/timestamp';

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
    drafting: '📝', backlog: '📋', active: '▶', running: '⚡',
    blocked: '⛔', done: '✅', failed: '❌', cancelled: '🚫',
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
      mostRecent: card.completed_at || card.started_at || card.updated_at || card.created_at,
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

.tl-empty {
  padding: 32px;
  text-align: center;
  color: #484f58;
  font-size: 13px;
}

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
  background: #21262d;
}

.timeline-event {
  display: flex;
  gap: 14px;
  padding: 10px 0;
  cursor: pointer;
  position: relative;
}

.timeline-event:hover .tl-title {
  color: #58a6ff;
}

.tl-marker {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #21262d;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  z-index: 1;
  font-size: 14px;
  border: 2px solid;
  border-color: #21262d;
}

.tl-marker.status-done { border-color: #3fb950; background: #1a2418; }
.tl-marker.status-failed { border-color: #f85149; background: #241818; }
.tl-marker.status-running { border-color: #58a6ff; background: #1c2738; }
.tl-marker.status-active { border-color: #58a6ff; background: #1c2738; }
.tl-marker.status-blocked { border-color: #d29922; background: #241f18; }
.tl-marker.status-cancelled { border-color: #484f58; background: #21262d; opacity: 0.6; }

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
  color: #c9d1d9;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: color 0.1s;
}

.tl-type-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.tl-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 3px;
}

.tl-status {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 8px;
}

.tl-status.status-done { background: #1a2418; color: #7ee787; }
.tl-status.status-failed { background: #241818; color: #f85149; }
.tl-status.status-running { background: #1c2738; color: #58a6ff; }
.tl-status.status-active { background: #1c2738; color: #58a6ff; }
.tl-status.status-blocked { background: #241f18; color: #d29922; }
.tl-status.status-drafting { background: #21262d; color: #8b949e; }
.tl-status.status-backlog { background: #21262d; color: #c9d1d9; }
.tl-status.status-cancelled { background: #21262d; color: #484f58; }

.tl-time {
  font-size: 11px;
  color: #484f58;
}

.tl-duration {
  font-size: 11px;
  color: #8b949e;
  font-family: 'SF Mono', monospace;
}

.tl-error {
  margin-top: 4px;
  font-size: 11px;
  color: #f85149;
  padding: 4px 8px;
  background: #241818;
  border-radius: 4px;
  border: 1px solid #da3633;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
