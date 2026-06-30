<template>
  <div class="app-shell" @keydown="handleKeydown">
    <div class="workspace-shell">
      <NavRail
        :nav-items="navItems"
        :docs-href="docsHref"
        @open-token="showTokenDialog = true"
      />

      <div class="workspace-stack">
        <WorkspaceHeader
          :section-title="currentSectionTitle"
          :project-name="projectName"
          :connection-state="wsConnectionState"
          :runtime-status="runtimeStatus"
          :runtime-status-label="runtimeStatusLabel"
          :live-update-label="liveUpdateLabel"
          :live-update-detail="liveUpdateDetail"
          :runtime-mode-label="runtimeModeLabel"
          :runtime-mode-detail="runtimeDetail"
          :is-stale="isRuntimeStale"
          :is-unauthorized="runtimeUnauthorized"
          :has-token="hasToken"
        />

        <main class="workspace-content">
          <div v-if="showAuthBanner" class="entry-danger auth-banner" role="alert" data-testid="api-auth-banner">
            <strong>API token required</strong>
            <span>Set a valid API token to load secured runtime data.</span>
            <Button class="auth-banner-action" size="sm" variant="ghost" @click="openTokenFromAuthBanner">Open Token modal</Button>
            <Button class="auth-banner-dismiss" size="sm" variant="ghost" aria-label="Dismiss API token banner" @click="dismissAuthBanner">Dismiss</Button>
          </div>
          <router-view v-slot="{ Component }">
            <transition name="fade" mode="out-in">
              <component :is="Component" />
            </transition>
          </router-view>
        </main>
      </div>
    </div>

    <AnalystChatPanel />
    <AnalystToaster />

    <ApiTokenEntry
      :visible="showTokenDialog"
      @close="showTokenDialog = false"
      @saved="handleTokenSaved"
      @cleared="handleTokenCleared"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import NavRail from '../nav/NavRail.vue';
import type { NavItem } from '../nav/types';
import WorkspaceHeader from './WorkspaceHeader.vue';
import ApiTokenEntry from '../auth/ApiTokenEntry.vue';
import AnalystChatPanel from '../chat/AnalystChatPanel.vue';
import AnalystToaster from '../chat/AnalystToaster.vue';
import Button from '../ui/Button.vue';
import { useSyncStore } from '../../stores/sync';
import { useRuntimeStore } from '../../stores/runtime';
import { useCardStore } from '../../stores/cards';
import { useAgentStore } from '../../stores/agents';
import { getAuthToken } from '../../api/auth';
import type { WsConnectionState } from '../../api/types';
import { API_AUTH_REQUIRED_EVENT, dismissAuthBannerForSession, isAuthBannerDismissedForSession } from '../../utils/auth-events';

const syncStore = useSyncStore();
const runtimeStore = useRuntimeStore();
const cardStore = useCardStore();
const agentStore = useAgentStore();
const { connectionState } = storeToRefs(syncStore);
const {
  statusLabel,
  status,
  liveUpdateLabel,
  liveUpdateDetail,
  runtimeModeLabel,
  runtimeDetail,
  isStale,
  unauthorized,
} = storeToRefs(runtimeStore);

const route = useRoute();
const router = useRouter();

const navItems: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', shortcut: '1', icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="2" y="2" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="11" y="2" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="2" y="11" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="11" y="11" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>`, to: { name: 'dashboard' }, activePatterns: ['dashboard', '/dashboard'] },
  { id: 'cards', label: 'Cards', shortcut: '2', icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="2" y="2" width="7" height="5" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="11" y="2" width="7" height="5" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="2" y="9" width="7" height="5" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="11" y="9" width="7" height="5" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="3.5" cy="3.5" r="1" fill="currentColor"/><circle cx="12.5" cy="3.5" r="1" fill="currentColor"/></svg>`, to: { name: 'cards' }, activePatterns: ['cards', 'card-detail', '/cards'] },
  { id: 'timeline', label: 'Timeline', shortcut: '3', icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M5 3v14" stroke="currentColor" stroke-width="1.5"/><circle cx="5" cy="5" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="5" cy="10" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="5" cy="15" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M8 5h8M8 10h6M8 15h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`, to: { name: 'timeline' }, activePatterns: ['timeline', '/timeline'] },
  { id: 'agents', label: 'Agents', shortcut: '4', icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="6" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M5 16c0-2.8 2.2-5 5-5s5 2.2 5 5" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="7" cy="6.5" r="1" fill="currentColor"/></svg>`, to: { name: 'agents' }, activePatterns: ['agents', 'agent-detail', '/agents'] },
  { id: 'files', label: 'Files', shortcut: '5', icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 3h5l2 2h7a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M3 8h14" stroke="currentColor" stroke-width="1.5"/></svg>`, to: { name: 'files' }, activePatterns: ['files', '/files'] },
  { id: 'debug', label: 'Debug', shortcut: '6', icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="10" y1="6" x2="10" y2="10" stroke="currentColor" stroke-width="1.5"/><line x1="10" y1="14" x2="10.01" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`, to: { name: 'debug' }, activePatterns: ['debug', '/debug'] },
];

const docsHref = computed<string>(() => '/docs/');
const showTokenDialog = ref(false);
const projectName = computed(() => 'saivage-v3');
const hasToken = computed(() => Boolean(getAuthToken()));
const showAuthBanner = ref(false);
const coreUnregisters = ref<Array<() => void>>([]);

const sectionLabels: Record<string, string> = {
  dashboard: 'Dashboard',
  cards: 'Cards',
  'card-detail': 'Card Detail',
  timeline: 'Timeline',
  agents: 'Agents',
  'agent-detail': 'Agent Detail',
  files: 'Files',
  debug: 'Debug',
};

const currentSectionTitle = computed(() => {
  const name = route.name as string;
  return sectionLabels[name] ?? name ?? 'Saivage';
});

const wsConnectionState = computed<WsConnectionState>(() => connectionState.value ?? 'offline');
const runtimeStatus = computed<string | null>(() => status.value ?? null);
const runtimeStatusLabel = computed(() => statusLabel.value);
const isRuntimeStale = computed(() => isStale.value);
const runtimeUnauthorized = computed(() => unauthorized.value);
function handleKeydown(event: KeyboardEvent): void {
  if (document.body.dataset.modalOpen === 'true') return;
  const target = event.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
  const key = event.key;
  const map: Record<string, string> = { '1': 'dashboard', '2': 'cards', '3': 'timeline', '4': 'agents', '5': 'files', '6': 'debug' };
  if (map[key] && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    const item = navItems.find((n) => n.id === map[key]);
    if (item) router.push(item.to);
  }
  if (key === '/' && !event.ctrlKey && !event.metaKey) {
    window.dispatchEvent(new CustomEvent('saivage:focus-chat'));
  }
}

function globalKeyHandler(event: KeyboardEvent): void {
  handleKeydown(event);
}

function handleApiAuthRequired(): void {
  if (!isAuthBannerDismissedForSession()) {
    showAuthBanner.value = true;
  }
}

function openTokenFromAuthBanner(): void {
  showTokenDialog.value = true;
}

function dismissAuthBanner(): void {
  showAuthBanner.value = false;
  dismissAuthBannerForSession();
}

function refreshAuthDependentConnections(): void {
  syncStore.disconnect();
  syncStore.connect();
  runtimeStore.refetch().catch(() => {});
}

function handleTokenSaved(): void {
  showTokenDialog.value = false;
  showAuthBanner.value = false;
  refreshAuthDependentConnections();
}

function handleTokenCleared(): void {
  refreshAuthDependentConnections();
}

onMounted(() => {
  const unregisterRuntime = syncStore.registerResource({ resource: 'runtime', scope: 'core', refetch: runtimeStore.refetch });
  const unregisterCards = syncStore.registerResource({ resource: 'cards', scope: 'core', refetch: cardStore.refetch });
  const unregisterAgents = syncStore.registerResource({ resource: 'agents', scope: 'core', refetch: agentStore.refetch });
  coreUnregisters.value = [unregisterRuntime, unregisterCards, unregisterAgents];
  syncStore.connect();
  runtimeStore.refetch().catch(() => {});
  window.addEventListener('keydown', globalKeyHandler);
  window.addEventListener(API_AUTH_REQUIRED_EVENT, handleApiAuthRequired);
});

onUnmounted(() => {
  for (const unregister of coreUnregisters.value) unregister();
  coreUnregisters.value = [];
  syncStore.disconnect();
  window.removeEventListener('keydown', globalKeyHandler);
  window.removeEventListener(API_AUTH_REQUIRED_EVENT, handleApiAuthRequired);
});
</script>

<style scoped>
.app-shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(20rem, 25vw, 30vw);
  grid-template-rows: 1fr;
  height: 100%;
  width: 100%;
  outline: none;
}

.workspace-shell {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: 1fr;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workspace-stack {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workspace-content {
  flex: 1;
  overflow: auto;
  background: var(--bg);
}

.auth-banner {
  position: sticky;
  top: 0;
  z-index: 20;
  display:flex;
  align-items:center;
  gap:10px;
  padding:10px 14px;
  border-left:0;
  border-right:0;
  border-top:0;
  border-radius:0;
  color:var(--text);
  font-size:13px;
}
.auth-banner strong { color:var(--danger); }
.auth-banner-dismiss { margin-left:auto; }

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
