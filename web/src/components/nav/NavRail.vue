<template>
  <nav class="nav-rail" aria-label="Primary navigation">
    <ul class="nav-items">
      <li v-for="item in navItems" :key="item.id">
        <router-link
          :to="item.to"
          class="nav-link"
          :class="{ active: isActive(item.id) }"
          :aria-current="isActive(item.id) ? 'page' : undefined"
          :title="`${item.label} (${item.shortcut})`"
        >
          <span class="nav-icon" v-html="item.icon"></span>
          <span class="nav-label">{{ item.label }}</span>
          <span class="nav-shortcut">{{ item.shortcut }}</span>
        </router-link>
      </li>
    </ul>

    <div class="nav-footer">
      <button
        class="nav-link api-token-btn"
        title="API token for API/WebSocket access — public docs do not require a token"
        aria-label="Manage API token for API and WebSocket access"
        @click="$emit('open-token')"
      >
        <span class="nav-icon">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M10 2a4 4 0 0 0-4 4v2H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-1V6a4 4 0 0 0-4-4z"
              stroke="currentColor" stroke-width="1.5" fill="none"/>
            <circle cx="10" cy="12" r="1.2" fill="currentColor"/>
          </svg>
        </span>
        <span class="nav-label">Token</span>
      </button>
      <a
        v-if="docsHref"
        :href="docsHref"
        target="_blank"
        rel="noopener"
        class="nav-link"
        title="Open public docs in a new tab"
        aria-label="Docs (opens in a new tab; public docs do not require API token)"
      >
        <span class="nav-icon">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M5 2h6l4 4v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"
              stroke="currentColor" stroke-width="1.5" fill="none"/>
            <path d="M11 2v4h4" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <line x1="7" y1="11" x2="13" y2="11" stroke="currentColor" stroke-width="1.5"/>
          </svg>
        </span>
        <span class="nav-label">Docs</span>
        <span class="nav-external" aria-hidden="true">↗</span>
      </a>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { useRoute } from 'vue-router';
import type { NavItem } from './types';

const props = defineProps<{
  navItems: NavItem[];
  docsHref?: string | null;
}>();

defineEmits<{
  'open-token': [];
}>();

const route = useRoute();

function isActive(id: string): boolean {
  const item = props.navItems.find((n) => n.id === id);
  if (!item) return false;
  const routeName = typeof route.name === 'string' ? route.name : '';
  const routePath = typeof route.path === 'string' ? route.path : '';
  return item.activePatterns.some(
    (pattern) =>
      routeName.startsWith(pattern) || routePath.startsWith(pattern),
  );
}
</script>

<style scoped>
.nav-rail {
  display: flex;
  flex-direction: column;
  width: 64px;
  background: #161b22;
  border-right: 1px solid #30363d;
  overflow: hidden;
  flex-shrink: 0;
  justify-content: space-between;
}

.nav-items {
  list-style: none;
  display: flex;
  flex-direction: column;
  padding: 8px 0;
  gap: 2px;
}

.nav-link {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 4px 6px;
  text-decoration: none;
  color: #8b949e;
  border-radius: 0;
  transition: color 0.15s, background-color 0.15s;
  position: relative;
  cursor: pointer;
  border: none;
  background: none;
  width: 100%;
  font-family: inherit;
  font-size: inherit;
}

.nav-link:hover {
  color: #c9d1d9;
  background: #21262d;
}

.nav-link.active {
  color: #58a6ff;
  background: #1c2738;
}

.nav-link.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  background: #58a6ff;
  border-radius: 0 2px 2px 0;
}

.nav-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
}

.nav-icon :deep(svg) {
  width: 20px;
  height: 20px;
}

.nav-label {
  font-size: 10px;
  line-height: 1.2;
  white-space: nowrap;
  text-align: center;
}

.nav-shortcut {
  display: none;
  font-size: 9px;
  color: #484f58;
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
}

.nav-footer {
  display: flex;
  flex-direction: column;
  padding: 8px 0;
  border-top: 1px solid #30363d;
  gap: 2px;
}

.api-token-btn {
  background: none;
  border: none;
}

.nav-external {
  font-size: 9px;
  color: #484f58;
}
</style>
