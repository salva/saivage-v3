<template>
  <div class="app-shell" @keydown="handleKeydown">
    <NavRail
      :nav-items="navItems"
      :docs-href="docsHref"
      @open-token="showTokenDialog = true"
    />

    <div class="main-area">
      <WorkspaceHeader
        :section-title="currentSectionTitle"
        :project-name="projectName"
        :connection-state="wsConnectionState"
        :runtime-status="runtimeStatus"
        :runtime-status-label="runtimeStatusLabel"
        :is-paused="isPaused"
        @toggle-pause="handleTogglePause"
      />

      <main class="workspace-content">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>

    <ApiTokenEntry
      :visible="showTokenDialog"
      @close="showTokenDialog = false"
      @saved="showTokenDialog = false"
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
import { useWsStore } from '../../stores/ws';
import { useRuntimeStore } from '../../stores/runtime';
import type { WsConnectionState } from '../../api/types';

// ── Pinia Stores ──────────────────────────────────────────

const wsStore = useWsStore();
const runtimeStore = useRuntimeStore();
const { connectionState } = storeToRefs(wsStore);
const { statusLabel, isPaused, status } = storeToRefs(runtimeStore);

// ── Router ────────────────────────────────────────────────

const route = useRoute();
const router = useRouter();

// ── Navigation Items ──────────────────────────────────────

const navItems: NavItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    shortcut: '1',
    icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect x="2" y="2" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <rect x="11" y="2" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <rect x="2" y="11" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <rect x="11" y="11" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/>
    </svg>`,
    to: { name: 'dashboard' },
    activePatterns: ['dashboard', '/dashboard'],
  },
  {
    id: 'cards',
    label: 'Cards',
    shortcut: '2',
    icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect x="2" y="2" width="7" height="5" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <rect x="11" y="2" width="7" height="5" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <rect x="2" y="9" width="7" height="5" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <rect x="11" y="9" width="7" height="5" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <circle cx="3.5" cy="3.5" r="1" fill="currentColor"/>
      <circle cx="12.5" cy="3.5" r="1" fill="currentColor"/>
    </svg>`,
    to: { name: 'cards' },
    activePatterns: ['cards', 'card-detail', '/cards'],
  },
  {
    id: 'agents',
    label: 'Agents',
    shortcut: '3',
    icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="6" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <path d="M5 16c0-2.8 2.2-5 5-5s5 2.2 5 5" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <circle cx="7" cy="6.5" r="1" fill="currentColor"/>
    </svg>`,
    to: { name: 'agents' },
    activePatterns: ['agents', 'agent-detail', '/agents'],
  },
  {
    id: 'files',
    label: 'Files',
    shortcut: '4',
    icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path d="M3 3h5l2 2h7a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"
        stroke="currentColor" stroke-width="1.5" fill="none"/>
      <path d="M3 8h14" stroke="currentColor" stroke-width="1.5"/>
    </svg>`,
    to: { name: 'files' },
    activePatterns: ['files', '/files'],
  },
  {
    id: 'debug',
    label: 'Debug',
    shortcut: '5',
    icon: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <line x1="10" y1="6" x2="10" y2="10" stroke="currentColor" stroke-width="1.5"/>
      <line x1="10" y1="14" x2="10.01" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`,
    to: { name: 'debug' },
    activePatterns: ['debug', '/debug'],
  },
];

// ── Docs link ─────────────────────────────────────────────

const docsHref = computed<string | null>(() => null);

// ── App State ─────────────────────────────────────────────

const showTokenDialog = ref(false);
const projectName = computed(() => 'saivage-v3');

// ── Header Props ──────────────────────────────────────────

const sectionLabels: Record<string, string> = {
  dashboard: 'Dashboard',
  cards: 'Cards',
  'card-detail': 'Card Detail',
  agents: 'Agents',
  'agent-detail': 'Agent Detail',
  files: 'Files',
  debug: 'Debug',
};

const currentSectionTitle = computed(() => {
  const name = route.name as string;
  return sectionLabels[name] ?? name ?? 'Saivage';
});

const wsConnectionState = computed<WsConnectionState>(() => connectionState.value);
const runtimeStatus = computed<string | null>(() => status.value ?? null);
const runtimeStatusLabel = computed(() => statusLabel.value);

// ── Pause/Resume ──────────────────────────────────────────

async function handleTogglePause(): Promise<void> {
  try {
    if (isPaused.value) {
      await runtimeStore.resume();
    } else {
      await runtimeStore.pause();
    }
  } catch {
    // Error handling is done in the store
  }
}

// ── Keyboard Shortcuts ────────────────────────────────────

function handleKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  if (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  ) {
    return;
  }

  const key = event.key;
  const map: Record<string, string> = {
    '1': 'dashboard',
    '2': 'cards',
    '3': 'agents',
    '4': 'files',
    '5': 'debug',
  };

  if (map[key] && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    const item = navItems.find((n) => n.id === map[key]);
    if (item) {
      router.push(item.to);
    }
  }

  // Slash to focus chat
  if (key === '/' && !event.ctrlKey && !event.metaKey) {
    window.dispatchEvent(new CustomEvent('saivage:focus-chat'));
  }
}

// ── Lifecycle ─────────────────────────────────────────────

onMounted(() => {
  wsStore.connect();
  runtimeStore.fetchState().catch(() => {
    // Runtime may not be running; that's fine
  });
});

onUnmounted(() => {
  wsStore.disconnect();
});
</script>

<style scoped>
.app-shell {
  display: flex;
  height: 100%;
  width: 100%;
  outline: none;
}

.main-area {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.workspace-content {
  flex: 1;
  overflow: auto;
  background: #0d1117;
}

/* Route transition */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
