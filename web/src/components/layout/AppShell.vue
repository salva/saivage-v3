<template>
  <div class="app-shell" :class="[`pane-${effectiveMobileActivePane}`, { 'analyst-pane-suppressed': suppressAnalystPane }]" @keydown="handleKeydown">
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

    <div v-if="!suppressAnalystPane" class="analyst-pane">
      <AnalystChatPanel />
    </div>

    <nav class="mobile-pane-switch" aria-label="Switch pane">
      <button
        type="button"
        class="pane-tab"
        :class="{ active: effectiveMobileActivePane === 'workspace' }"
        :aria-pressed="effectiveMobileActivePane === 'workspace'"
        @click="mobileActivePane = 'workspace'"
      >Workspace</button>
      <button
        v-if="!suppressAnalystPane"
        type="button"
        class="pane-tab"
        :class="{ active: effectiveMobileActivePane === 'analyst' }"
        :aria-pressed="effectiveMobileActivePane === 'analyst'"
        @click="mobileActivePane = 'analyst'"
      >Analyst<span v-if="analystActivityDot" class="activity-dot" aria-hidden="true"></span></button>
    </nav>

    <GlobalToaster />

    <ApiTokenEntry
      :visible="showTokenDialog"
      @close="showTokenDialog = false"
      @saved="handleTokenSaved"
      @cleared="handleTokenCleared"
    />

    <Dialog :visible="showShortcutHelp" title-id="shortcut-help-title" @dismiss="showShortcutHelp = false">
      <div class="shortcut-help">
        <div class="shortcut-help-header">
          <h2 id="shortcut-help-title" class="shortcut-help-title">Keyboard shortcuts</h2>
          <button type="button" class="shortcut-help-close" aria-label="Close" @click="showShortcutHelp = false">&times;</button>
        </div>
        <dl class="shortcut-list">
          <div class="shortcut-row"><dt><kbd>1</kbd>–<kbd>6</kbd></dt><dd>Switch workspace section</dd></div>
          <div class="shortcut-row"><dt><kbd>/</kbd></dt><dd>Focus Analyst chat</dd></div>
          <div class="shortcut-row"><dt><kbd>?</kbd></dt><dd>Show this help</dd></div>
          <div class="shortcut-row"><dt><kbd>Esc</kbd></dt><dd>Close dialog</dd></div>
        </dl>
      </div>
    </Dialog>
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
import GlobalToaster from '../feedback/GlobalToaster.vue';
import Button from '../ui/Button.vue';
import Dialog from '../ui/Dialog.vue';
import { useRuntimeStore } from '../../stores/runtime';
import { useAuthStore } from '../../stores/auth';
import { useAnalystChat } from '../../stores/analystChat';
import { ANALYST_SESSION_ID } from '../../stores/analyst-chat-context';
import type { WsConnectionState } from '../../types/view-models';
import { API_AUTH_REQUIRED_EVENT, dismissAuthBannerForSession, isAuthBannerDismissedForSession } from '../../utils/auth-events';

const runtimeStore = useRuntimeStore();
const authStore = useAuthStore();
const analystChat = useAnalystChat();
const {
  statusLabel,
  status,
  syncConnectionState,
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
  { id: 'cards', label: 'Cards', shortcut: '2', icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="7" y="2" width="6" height="4" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="2" y="14" width="6" height="4" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="12" y="14" width="6" height="4" rx="1" stroke="currentColor" stroke-width="1.5"/><path d="M10 6v4M5 14v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`, to: { name: 'cards' }, activePatterns: ['cards', 'card-detail', '/cards'] },
  { id: 'timeline', label: 'Timeline', shortcut: '3', icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M5 3v14" stroke="currentColor" stroke-width="1.5"/><circle cx="5" cy="5" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="5" cy="10" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="5" cy="15" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M8 5h8M8 10h6M8 15h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`, to: { name: 'timeline' }, activePatterns: ['timeline', '/timeline'] },
  { id: 'agents', label: 'Agents', shortcut: '4', icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="6" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M5 16c0-2.8 2.2-5 5-5s5 2.2 5 5" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="7" cy="6.5" r="1" fill="currentColor"/></svg>`, to: { name: 'agents' }, activePatterns: ['agents', 'agent-detail', '/agents'] },
  { id: 'files', label: 'Files', shortcut: '5', icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 3h5l2 2h7a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M3 8h14" stroke="currentColor" stroke-width="1.5"/></svg>`, to: { name: 'files' }, activePatterns: ['files', '/files'] },
  { id: 'debug', label: 'Debug', shortcut: '6', icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="10" y1="6" x2="10" y2="10" stroke="currentColor" stroke-width="1.5"/><line x1="10" y1="14" x2="10.01" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`, to: { name: 'debug' }, activePatterns: ['debug', '/debug'] },
];

const docsHref = computed<string>(() => '/docs/');
const showTokenDialog = ref(false);
const projectName = computed(() => runtimeStore.projectId ?? 'saivage-v3');
const showAuthBanner = ref(false);
const mobileActivePane = ref<'workspace' | 'analyst'>('workspace');
const showShortcutHelp = ref(false);
const analystActivityDot = computed(() => analystChat.pendingToolInvocations.length > 0 || analystChat.sending);
const routeAgentId = computed(() => {
  const id = route.params.id;
  return Array.isArray(id) ? id[0] : id;
});
const suppressAnalystPane = computed(() => route.name === 'agent-detail' && routeAgentId.value === ANALYST_SESSION_ID);
const effectiveMobileActivePane = computed(() => suppressAnalystPane.value ? 'workspace' : mobileActivePane.value);

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

const wsConnectionState = computed<WsConnectionState>(() => syncConnectionState.value ?? 'offline');
const runtimeStatus = computed<string | null>(() => status.value ?? null);
const runtimeStatusLabel = computed(() => statusLabel.value);
const isRuntimeStale = computed(() => isStale.value);
const runtimeUnauthorized = computed(() => unauthorized.value);
function handleKeydown(event: KeyboardEvent): void {
  if (document.body.hasAttribute('data-modal-open')) return;
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
    event.preventDefault();
    if (suppressAnalystPane.value) return;
    mobileActivePane.value = 'analyst';
    window.dispatchEvent(new CustomEvent('saivage:focus-chat'));
  }
  if (key === '?' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    showShortcutHelp.value = true;
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

function handleTokenSaved(): void {
  showTokenDialog.value = false;
  showAuthBanner.value = false;
}

function handleTokenCleared(): void {
  authStore.refresh();
}

onMounted(() => {
  window.addEventListener('keydown', globalKeyHandler);
  window.addEventListener(API_AUTH_REQUIRED_EVENT, handleApiAuthRequired);
});

onUnmounted(() => {
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

.app-shell.analyst-pane-suppressed {
  grid-template-columns: minmax(0, 1fr);
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
  min-height: 0;
  overflow: auto;
  background: var(--bg);
}

.mobile-pane-switch { display: none; }

@media (max-width: 880px) {
  .app-shell {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr auto;
  }

  .app-shell.pane-workspace .workspace-shell { display: grid; }
  .app-shell.pane-workspace .analyst-pane { display: none; }
  .app-shell.pane-analyst .workspace-shell { display: none; }
  .app-shell.pane-analyst .analyst-pane { display: flex; min-height: 0; overflow: hidden; }

  .analyst-pane {
    width: 100%;
    height: 100%;
  }

  .mobile-pane-switch {
    display: flex;
    gap: 0;
    background: var(--surface-1);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    z-index: 10;
  }

  .pane-tab {
    flex: 1;
    padding: 8px 12px;
    border: none;
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .pane-tab.active {
    color: var(--accent-2);
    box-shadow: inset 0 -2px 0 var(--accent-2);
  }

  .activity-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--accent-2);
    animation: activity-pulse 1.4s ease-in-out infinite;
  }

  @keyframes activity-pulse {
    0%, 100% { opacity: .4; }
    50% { opacity: 1; }
  }
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

.shortcut-help { min-width:280px; max-width:400px; }
.shortcut-help-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
.shortcut-help-title { margin:0; font-size:15px; font-weight:700; color:var(--text); }
.shortcut-help-close { background:none; border:none; font-size:20px; color:var(--text-muted); cursor:pointer; padding:0; line-height:1; }
.shortcut-list { margin:0; display:flex; flex-direction:column; gap:10px; }
.shortcut-row { display:flex; align-items:baseline; gap:12px; }
.shortcut-row dt { flex-shrink:0; min-width:80px; }
.shortcut-row dd { margin:0; color:var(--text); font-size:13px; }
kbd { display:inline-block; padding:1px 6px; border:1px solid var(--border-strong); border-radius:4px; background:var(--surface-2); color:var(--text); font-family:var(--font-mono); font-size:11px; }

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
