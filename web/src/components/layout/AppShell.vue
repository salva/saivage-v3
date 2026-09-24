<template>
  <div
    class="app-shell"
    :class="[
      `pane-${effectiveMobileActivePane}`,
      { 'analyst-pane-suppressed': suppressAnalystPane },
    ]"
  >
    <a href="#main-content" class="skip-link">Skip to content</a>
    <a href="#analyst-pane" class="skip-link">Skip to Analyst</a>

    <div class="workspace-shell">
      <GlobalStrip />

      <main id="main-content" class="workspace-content" tabindex="-1">
        <div class="workspace-route-host">
          <router-view v-slot="{ Component }">
            <transition name="fade" mode="out-in">
              <component v-if="workspacePresentation === 'component'" :is="Component" />
              <div
                v-else-if="workspacePresentation === 'identity-pending'"
                class="workspace-identity-state"
                role="status"
                data-testid="analyst-identity-pending"
              >
                Loading Analyst identity…
              </div>
              <div
                v-else-if="workspacePresentation === 'identity-failed'"
                class="workspace-identity-state"
                role="alert"
                data-testid="analyst-identity-failed"
              >
                Analyst identity is unavailable.
              </div>
            </transition>
          </router-view>
        </div>
      </main>
    </div>

    <div v-if="showAnalystPane" id="analyst-pane" class="analyst-pane">
      <header class="analyst-pane-header" aria-label="Project">
        <span class="analyst-pane-project-name">{{ projectName }}</span>
      </header>
      <AnalystChatPanel />
    </div>

    <nav class="mobile-pane-switch" aria-label="Switch pane">
      <button
        type="button"
        class="pane-tab"
        :class="{ active: effectiveMobileActivePane === 'workspace' }"
        :aria-pressed="effectiveMobileActivePane === 'workspace'"
        @click="mobileActivePane = 'workspace'"
      >
        Workspace
      </button>
      <button
        v-if="showAnalystPane"
        type="button"
        class="pane-tab"
        :class="{ active: effectiveMobileActivePane === 'analyst' }"
        :aria-pressed="effectiveMobileActivePane === 'analyst'"
        @click="mobileActivePane = 'analyst'"
      >
        Analyst<span v-if="analystActivityDot" class="activity-dot" aria-hidden="true"></span>
      </button>
    </nav>

    <GlobalToaster />

    <Dialog
      :visible="showShortcutHelp"
      title-id="shortcut-help-title"
      @dismiss="showShortcutHelp = false"
    >
      <div class="shortcut-help">
        <div class="shortcut-help-header">
          <h2 id="shortcut-help-title" class="shortcut-help-title">Keyboard shortcuts</h2>
          <button
            type="button"
            class="shortcut-help-close"
            aria-label="Close"
            @click="showShortcutHelp = false"
          >
            &times;
          </button>
        </div>
        <dl class="shortcut-list">
          <div class="shortcut-row">
            <dt><kbd>1</kbd>–<kbd>3</kbd></dt>
            <dd>Switch workspace destination (Cockpit, Files, System)</dd>
          </div>
          <div class="shortcut-row">
            <dt><kbd>/</kbd></dt>
            <dd>Focus Analyst chat</dd>
          </div>
          <div class="shortcut-row">
            <dt><kbd>?</kbd></dt>
            <dd>Show this help</dd>
          </div>
          <div class="shortcut-row">
            <dt><kbd>Esc</kbd></dt>
            <dd>Close dialog</dd>
          </div>
        </dl>
      </div>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import GlobalStrip from './GlobalStrip.vue';
import AnalystChatPanel from '../chat/AnalystChatPanel.vue';
import GlobalToaster from '../feedback/GlobalToaster.vue';
import Dialog from '../ui/Dialog.vue';
import { useRuntimeStore } from '../../stores/runtime';
import { useAnalystChat } from '../../stores/analystChat';
import { parseAgentDetailRouteParam } from '../../router/agent-session-route';

const runtimeStore = useRuntimeStore();
const analystChat = useAnalystChat();

const route = useRoute();
const router = useRouter();

const projectName = computed(() => runtimeStore.projectId ?? 'saivage');
const mobileActivePane = ref<'workspace' | 'analyst'>('workspace');
const showShortcutHelp = ref(false);
const analystActivityDot = computed(() => analystChat.sending);
const showAnalystPane = ref(true);
const workspacePresentation = ref<
  'component' | 'identity-pending' | 'identity-failed' | 'teardown'
>('component');
let presentationToken = 0;
const routeAgentId = computed(() => {
  const parsed = parseAgentDetailRouteParam(route.params.id);
  return parsed.kind === 'valid' ? parsed.sessionId : null;
});
const suppressAnalystPane = computed(() => !showAnalystPane.value);
const effectiveMobileActivePane = computed(() =>
  suppressAnalystPane.value ? 'workspace' : mobileActivePane.value,
);

async function reconcileConversationMounts(): Promise<void> {
  const token = ++presentationToken;
  const validAgentRoute = route.name === 'agent-detail' && routeAgentId.value !== null;
  const identity = analystChat.identityState;

  let target: 'component' | 'identity-pending' | 'identity-failed' = 'component';
  if (validAgentRoute && identity.kind === 'pending') target = 'identity-pending';
  if (validAgentRoute && identity.kind === 'failed') target = 'identity-failed';
  const matching =
    validAgentRoute &&
    identity.kind === 'resolved' &&
    routeAgentId.value === identity.sessionId;

  if (matching) {
    showAnalystPane.value = false;
    workspacePresentation.value = 'teardown';
    await nextTick();
    if (token !== presentationToken) return;
    workspacePresentation.value = 'component';
    return;
  }

  if (!showAnalystPane.value) {
    workspacePresentation.value = 'teardown';
    await nextTick();
    if (token !== presentationToken) return;
  }
  showAnalystPane.value = true;
  workspacePresentation.value = target;
}

watch(
  [() => route.name, routeAgentId, () => analystChat.identityState],
  () => void reconcileConversationMounts(),
  { immediate: true },
);

function handleKeydown(event: KeyboardEvent): void {
  if (document.body.hasAttribute('data-modal-open')) return;
  const target = event.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    return;
  const key = event.key;
  const map: Record<string, string> = {
    '1': 'home',
    '2': 'files',
    '3': 'system',
  };
  if (map[key] && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    void router.push({ name: map[key] });
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

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
  void analystChat.resolveIdentity().catch(() => {});
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<style scoped>
.app-shell {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(280px, 1fr);
  grid-template-rows: 1fr;
  height: 100%;
  width: 100%;
  outline: none;
}

.app-shell.analyst-pane-suppressed {
  grid-template-columns: minmax(0, 1fr);
}

.skip-link {
  position: absolute;
  left: -9999px;
  top: 0;
  z-index: 200;
  background: var(--surface-2);
  color: var(--accent-2);
  padding: 8px 14px;
  border-radius: 0 0 8px 0;
  border: 1px solid var(--border);
  font-size: 12px;
}
.skip-link:focus {
  left: 0;
}

.workspace-shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workspace-content {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--bg);
}

.workspace-route-host {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.workspace-identity-state {
  display: grid;
  min-height: 100%;
  place-items: center;
  padding: 24px;
  color: var(--text-muted);
}

.analyst-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.analyst-pane-header {
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 0 12px;
  background: var(--surface-1);
  border-left: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  flex-shrink: 0;
}

.analyst-pane-project-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-pane-switch {
  display: none;
}

@media (max-width: 880px) {
  .app-shell {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr auto;
  }

  .app-shell.pane-workspace .workspace-shell {
    display: grid;
  }
  .app-shell.pane-workspace .analyst-pane {
    display: none;
  }
  .app-shell.pane-analyst .workspace-shell {
    display: none;
  }
  .app-shell.pane-analyst .analyst-pane {
    display: flex;
    min-height: 0;
    overflow: hidden;
  }

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
    0%,
    100% {
      opacity: 0.4;
    }
    50% {
      opacity: 1;
    }
  }
}

.shortcut-help {
  min-width: 280px;
  max-width: 400px;
}
.shortcut-help-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.shortcut-help-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}
.shortcut-help-close {
  background: none;
  border: none;
  font-size: 20px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
  line-height: 1;
}
.shortcut-list {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.shortcut-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.shortcut-row dt {
  flex-shrink: 0;
  min-width: 80px;
}
.shortcut-row dd {
  margin: 0;
  color: var(--text);
  font-size: 13px;
}
kbd {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 11px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
