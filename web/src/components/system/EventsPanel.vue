<template>
  <section class="events-panel" :data-testid="testId">
    <div class="events-toolbar">
      <button type="button" class="events-command" data-testid="events-refresh" :disabled="state.loading" @click="refresh">Refresh</button>
      <button v-if="readFailed" type="button" class="events-command" data-testid="events-retry" @click="retry">Retry</button>
      <span class="events-coverage">{{ coverageLabel }}</span>
    </div>
    <ViewState v-if="state.loading && !state.loaded" state="loading" title="Reading retained events" />
    <ViewState v-else-if="state.error" state="error" title="Events unavailable" :message="state.error" />
    <template v-else>
      <StatusBanner v-if="state.refreshError" tone="warning" :message="`Last successful observation is retained; the latest read failed: ${state.refreshError}`" />
      <ViewState v-if="state.loaded && state.events.length === 0" state="empty" title="No retained events in this bounded read" message="This is the accepted coverage of this read, not a claim that no events exist." />
      <ol v-else class="events-list" data-testid="events-list">
        <li v-for="event in state.events" :key="event.id" class="events-row" :data-kind="event.kind">
          <span class="events-time" :title="event.timestamp">{{ fmtTime(event.timestamp) }}</span>
          <span class="events-kind">{{ event.kind }}</span>
          <span class="events-summary">{{ eventSummary(event) }}</span>
          <router-link v-if="cardReference(event)" class="events-card-link" :to="{ name: 'card-detail', params: { id: cardReference(event)! } }">{{ cardReference(event) }}</router-link>
        </li>
      </ol>
      <div v-if="state.mode === 'oldest_page' && state.total !== null" class="events-paging">
        <button type="button" class="events-command" :disabled="state.offset === 0 || state.loading" @click="browse(Math.max(0, state.offset - tailLimit))">Newer page</button>
        <button type="button" class="events-command" :disabled="state.offset + state.events.length >= state.total || state.loading" @click="browse(state.offset + tailLimit)">Older page</button>
        <span class="events-coverage">Explicit oldest-page browsing: each response is a fresh bounded observation, not a snapshot cursor or gap-free history.</span>
      </div>
      <button v-else-if="state.mode === 'newest_tail' && state.total !== null && state.events.length < state.total" type="button" class="events-command events-older" @click="browse(0)">Browse from the oldest page</button>
    </template>
    <p class="events-note">Events are a bounded retained observation with no invalidation, polling, or replay. Use Refresh to request a new bounded read.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useEventsStore, type EventsScope } from '../../stores/events';
import { formatRecentTimestamp } from '../../utils/timestamp';
import ViewState from '../ui/ViewState.vue';
import StatusBanner from '../ui/StatusBanner.vue';

const props = withDefaults(defineProps<{ scope: EventsScope; testId?: string }>(), { testId: 'events-panel' });

const eventsStore = useEventsStore();
const state = computed(() => eventsStore.scope(props.scope));
type EventRow = typeof state.value['events'][number];
const tailLimit = eventsStore.tailLimit;
const readFailed = computed(() => state.value.error !== null || state.value.refreshError !== null);

onMounted(() => {
  if (!state.value.loaded && !state.value.loading) void eventsStore.read(props.scope, { mode: 'newest_tail' });
});

function refresh(): void { void eventsStore.refresh(props.scope); }
function retry(): void { void eventsStore.retry(props.scope); }
function browse(offset: number): void { void eventsStore.browseOldest(props.scope, offset); }

const coverageLabel = computed(() => {
  if (!state.value.loaded) return '';
  const mode = state.value.mode === 'newest_tail' ? 'the newest events' : `the oldest retained events (page at offset ${state.value.offset})`;
  const filter = props.scope.cardId ? ` · card ${props.scope.cardId}` : ' · no card filter';
  return `Showing ${mode}: ${state.value.events.length} of ${state.value.total ?? 'unknown'} retained events${filter}`;
});

function fmtTime(ts: string): string { return formatRecentTimestamp(ts); }

function eventSummary(event: EventRow): string {
  if (event.kind === 'runtime_diagnostic') return `${event.phase ? `${event.phase}: ` : ''}${event.error_message}`;
  if (event.kind === 'runtime_actionable_error') return `${event.actionable_error.code}: ${event.actionable_error.message}`;
  return `${event.server}:${event.tool} ${event.success ? 'succeeded' : 'failed'} in ${event.duration_ms}ms${event.error ? ` — ${event.error}` : ''}`;
}

function cardReference(event: EventRow): string | null {
  if (event.kind === 'runtime_diagnostic') return event.card_id ?? event.goal_id ?? null;
  if (event.kind === 'runtime_actionable_error') return event.actionable_error.cardId ?? null;
  return null;
}
</script>

<style scoped>
.events-panel { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; }
.events-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.events-command { padding: 3px 10px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface-2); color: var(--text); font: inherit; font-size: 11px; cursor: pointer; }
.events-command:disabled { opacity: 0.5; cursor: not-allowed; }
.events-coverage { font-size: 11px; color: var(--text-muted); }
.events-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.events-row { display: flex; align-items: baseline; gap: 10px; font-size: 12px; padding: 4px 8px; background: var(--surface-1); border: 1px solid var(--surface-3); border-radius: 6px; }
.events-time { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
.events-kind { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
.events-row[data-kind='runtime_actionable_error'] .events-kind { color: var(--danger); }
.events-summary { color: var(--text); min-width: 0; overflow-wrap: anywhere; }
.events-card-link { color: var(--accent-2); text-decoration: underline; font-family: var(--font-mono); font-size: 10px; flex-shrink: 0; }
.events-paging { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.events-note { margin: 0; font-size: 10px; color: var(--text-muted); }
</style>
