<template>
  <header class="global-strip" data-testid="global-strip">
    <div class="strip-row">
      <div class="strip-identity">
        <span class="strip-project" data-testid="strip-project">{{ projectId ?? 'saivage' }}</span>
        <span class="strip-chip" :class="`lifecycle-${statusLabel}`" data-testid="strip-lifecycle">{{ runtimeModeLabel }}</span>
        <span v-if="currentWorkLabel" class="strip-current" data-testid="strip-current-work">
          <router-link v-if="currentCardId" :to="{ name: 'card-detail', params: { id: currentCardId } }">{{ currentWorkLabel }}</router-link>
          <template v-else>{{ currentWorkLabel }}</template>
        </span>
      </div>

      <nav class="strip-nav" aria-label="Primary navigation">
        <router-link v-for="item in navItems" :key="item.id" :to="item.to" class="strip-nav-link" :aria-current="isNavActive(item) ? 'page' : undefined">
          <span>{{ item.label }}</span><kbd v-if="item.shortcut">{{ item.shortcut }}</kbd>
        </router-link>
      </nav>

      <div class="strip-observations">
        <span class="strip-chip" :class="`rest-${restState}`" :title="restTitle" data-testid="strip-rest">REST {{ restLabel }}</span>
        <span class="strip-chip" :class="`ws-${connectionState}`" :title="socketDetail" data-testid="strip-socket">{{ socketLabel }}</span>
        <span class="strip-chip" :title="oversightTitle" data-testid="strip-oversight">Oversight {{ oversightView.state }}</span>
      </div>

      <div class="strip-controls">
        <button
          v-if="restartServerAvailable"
          type="button"
          class="strip-command danger"
          data-testid="strip-restart"
          @click="restartDialogOpen = true"
        >Restart server…</button>
        <details class="strip-updates" data-testid="strip-updates">
          <summary>Updates</summary>
          <div class="strip-updates-body">
            <p>Cards, conversations, and records refresh through permitted WebSocket invalidation hints and reconnect snapshots of eligible mounted/accepted resources. Hints are not data or guaranteed delivery; reconnect does not certify a successful REST observation.</p>
            <p>Files, Processes, and Events have no invalidation resource: use their explicit Refresh to observe changes.</p>
          </div>
        </details>
      </div>
    </div>

    <div v-if="problemNotices.length > 0" class="strip-problems" role="alert" data-testid="strip-problems">
      <span v-for="notice in problemNotices" :key="notice" class="strip-problem">{{ notice }}</span>
    </div>

    <RestartServerDialog
      :visible="restartDialogOpen"
      :sending="restartSending"
      :error="restartError"
      @close="restartDialogOpen = false"
      @confirmed="restartServer"
    />
  </header>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useRuntimeStore } from '../../stores/runtime';
import { useSyncStore } from '../../stores/sync';
import { selectSocketDetail, selectSocketLabel } from '../../stores/runtime-read-model';
import { useCurrentCardOrientation } from '../../composables/useCurrentCardOrientation';
import RestartServerDialog from '../cockpit/RestartServerDialog.vue';

const runtimeStore = useRuntimeStore();
const syncStore = useSyncStore();
const route = useRoute();
const {
  projectId,
  loaded,
  loading,
  refreshing,
  refreshError,
  error: runtimeError,
  unauthorized,
  status,
  statusLabel,
  runtimeModeLabel,
  currentCardId,
  oversight,
  restartServerAvailable,
} = storeToRefs(runtimeStore);
const { connectionState } = storeToRefs(syncStore);

const navItems = [
  { id: 'cockpit', label: 'Cockpit', shortcut: '1', to: { name: 'home' }, routeNames: ['home', 'cards', 'card-detail', 'agent-detail'] },
  { id: 'files', label: 'Files', shortcut: '2', to: { name: 'files' }, routeNames: ['files'] },
  { id: 'system', label: 'System', shortcut: '3', to: { name: 'system' }, routeNames: ['system'] },
] as const;

function isNavActive(item: (typeof navItems)[number]): boolean {
  return item.routeNames.includes(route.name as never);
}

const restartDialogOpen = ref(false);
const restartSending = ref(false);
const restartError = ref<string | null>(null);

const connectionStateLabel = computed(() => connectionState.value ?? 'offline');
const socketLabel = computed(() => selectSocketLabel(connectionStateLabel.value));
const socketDetail = computed(() => selectSocketDetail(connectionStateLabel.value));

const currentWorkLabel = computed(() => {
  if (!loaded.value) return 'Current work unknown';
  if (unauthorized.value) return 'Current work unavailable';
  return currentCardId.value ?? 'No current work';
});

const restState = computed(() => {
  if (!loaded.value && loading.value) return 'loading';
  if (!loaded.value) return unauthorized.value ? 'unauthorized' : runtimeError.value ? 'error' : 'not-loaded';
  if (refreshing.value) return 'refreshing';
  if (refreshError.value) return 'refresh-failed';
  return 'loaded';
});
const restLabel = computed(() => ({
  loading: 'Loading',
  'not-loaded': 'Not loaded',
  error: 'Failed',
  unauthorized: 'Unauthorized',
  refreshing: 'Refreshing',
  'refresh-failed': 'Refresh failed',
  loaded: 'Observed',
}[restState.value]));
const restTitle = computed(() => {
  if (restState.value === 'refresh-failed') return `Last successful observation is retained; the latest refresh failed: ${refreshError.value}`;
  if (restState.value === 'error') return `The initial runtime observation failed: ${runtimeError.value}`;
  return 'Runtime REST observation condition (independent of the socket connection).';
});

const oversightView = computed(() => oversight.value ?? {
  agent_name: 'oversight',
  session_id: '',
  enabled: false,
  eligible: false,
  eligibility_reason: null,
  state: 'unavailable',
  next_nominal_due: null,
  last_attempt: null,
  last_successful_at: null,
  service_epoch: '',
});
const oversightTitle = computed(() => {
  if (!loaded.value) return 'Oversight diagnostics have not been observed yet.';
  const base = `Oversight is ${oversightView.value.state} (epoch diagnostics, not session liveness).`;
  return oversightView.value.next_nominal_due ? `${base} Next nominal due ${oversightView.value.next_nominal_due}.` : base;
});

const problemNotices = computed<string[]>(() => {
  const notices: string[] = [];
  if (loaded.value && status.value === 'error') notices.push('Runtime reported an error state.');
  const availabilityDetail = runtimeStore.runtimeDetail;
  if (loaded.value && status.value !== 'error' && availabilityDetail && availabilityDetail !== 'Runtime snapshot comes from the latest accepted REST response.' && !unauthorized.value) {
    notices.push(availabilityDetail);
  }
  if (currentCardProblem.value) notices.push(currentCardProblem.value);
  return notices;
});

const currentCardOrientation = useCurrentCardOrientation(() => currentCardId.value, () => loaded.value);
const currentCardProblem = computed<string | null>(() => {
  const detail = currentCardOrientation.detail.value;
  if (!detail) return null;
  if (detail.lifecycle.error) return `Current card ${detail.id}: ${detail.lifecycle.error}`;
  if (['failed', 'blocked', 'cancelled'].includes(detail.lifecycle.status)) {
    return `Current card ${detail.id} is ${detail.lifecycle.status}.`;
  }
  return null;
});

async function restartServer(): Promise<void> {
  restartError.value = null;
  restartSending.value = true;
  try {
    await runtimeStore.restartServer();
    restartDialogOpen.value = false;
  } catch (error) {
    restartError.value = error instanceof Error ? error.message : String(error);
  } finally {
    restartSending.value = false;
  }
}
</script>

<style scoped>
.global-strip {
  display: flex;
  flex-direction: column;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.strip-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 6px 16px;
  min-height: 44px;
  flex-wrap: wrap;
}
.strip-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
.strip-project { font-size: 13px; font-weight: 700; color: var(--text); white-space: nowrap; }
.strip-current { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.strip-current a { color: var(--accent-2); text-decoration: underline; }
.strip-nav { display: flex; gap: 2px; margin-left: 8px; }
.strip-nav-link {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 6px;
  font-size: 12px; font-weight: 600; color: var(--text-muted);
  text-decoration: none;
}
.strip-nav-link:hover { color: var(--text); background: var(--surface-3); }
.strip-nav-link.router-link-active { color: var(--accent-2); background: var(--entry-user-bg); }
.strip-nav-link kbd {
  padding: 0 4px; border: 1px solid var(--border-strong); border-radius: 3px;
  font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); background: var(--surface-2);
}
.strip-observations { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.strip-chip {
  display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 10px;
  font-size: 11px; font-weight: 600; line-height: 1.4; white-space: nowrap;
  border: 1px solid var(--border-strong); background: var(--surface-3); color: var(--text-muted);
}
.lifecycle-running, .rest-loaded, .ws-connected { color: var(--accent); border-color: var(--accent); }
.lifecycle-paused, .rest-refreshing, .rest-refresh-failed, .ws-connecting { color: var(--warn); border-color: var(--entry-warn-border); }
.lifecycle-error, .rest-error, .rest-unauthorized, .ws-unauthorized { color: var(--danger); border-color: var(--danger); }
.lifecycle-stopped, .lifecycle-unknown, .rest-loading, .rest-not-loaded, .ws-offline { color: var(--text-muted); }
.strip-controls { display: flex; align-items: center; gap: 8px; }
.strip-command {
  padding: 4px 12px; border: 1px solid var(--border-strong); border-radius: 6px;
  background: var(--surface-2); color: var(--text); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
}
.strip-command.danger { color: var(--danger); border-color: var(--danger); }
.strip-updates { position: relative; }
.strip-updates > summary {
  list-style: none; cursor: pointer; font-size: 11px; color: var(--text-muted);
  padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border);
}
.strip-updates > summary::-webkit-details-marker { display: none; }
.strip-updates[open] > summary { color: var(--text); background: var(--surface-3); }
.strip-updates-body {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 40;
  width: 380px; padding: 12px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--surface-2); color: var(--text-muted); font-size: 12px; line-height: 1.5;
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
}
.strip-updates-body p { margin: 0 0 8px; }
.strip-updates-body p:last-child { margin: 0; }
.strip-problems {
  display: flex; flex-direction: column; gap: 2px; padding: 6px 16px;
  border-top: 1px solid var(--entry-warn-border);
  background: var(--entry-warn-bg);
}
.strip-problem { font-size: 12px; color: var(--text); }
</style>
