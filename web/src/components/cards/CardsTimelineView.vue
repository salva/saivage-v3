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
          <div v-if="event.card.lifecycle.error" class="tl-error">{{ event.card.lifecycle.error }}</div>
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
    blocked: '⛔', changed: '✎', done: '✅', failed: '❌', cancelled: '🚫', needs_verification: '🔍',
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

.tl-empty {
  padding: 32px;
  text-align: center;
  color: var(--border-strong);
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
  background: var(--surface-3);
}

.timeline-event {
  display: flex;
  gap: 14px;
  padding: 10px 0;
  cursor: pointer;
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
  border: 2px solid;
  border-color: var(--surface-3);
}

.tl-marker.status-done { border-color: var(--accent); background: var(--entry-accent-bg); }
.tl-marker.status-failed { border-color: var(--danger); background: var(--entry-danger-bg); }
.tl-marker.status-running { border-color: var(--accent-2); background: var(--entry-user-bg); }
.tl-marker.status-active { border-color: var(--accent-2); background: var(--entry-user-bg); }
.tl-marker.status-blocked { border-color: var(--warn); background: var(--entry-warn-bg); }
.tl-marker.status-cancelled { border-color: var(--border-strong); background: var(--surface-3); opacity: 0.6; }
.tl-marker.status-needs_verification { border-color: var(--warn); background: var(--entry-warn-bg); }

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

.tl-status.status-done { background: var(--entry-accent-bg); color: var(--accent); }
.tl-status.status-failed { background: var(--entry-danger-bg); color: var(--danger); }
.tl-status.status-running { background: var(--entry-user-bg); color: var(--accent-2); }
.tl-status.status-active { background: var(--entry-user-bg); color: var(--accent-2); }
.tl-status.status-blocked { background: var(--entry-warn-bg); color: var(--warn); }
.tl-status.status-drafting { background: var(--surface-3); color: var(--text-muted); }
.tl-status.status-backlog { background: var(--surface-3); color: var(--text); }
.tl-status.status-cancelled { background: var(--surface-3); color: var(--border-strong); }

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
