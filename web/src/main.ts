import './styles/index.css';
import 'highlight.js/styles/github.css';
import './styles/highlight-overrides.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import type { Router } from 'vue-router';
import App from './App.vue';
import { startAppBootstrap } from './composables/useAppBootstrap';
import { createOperatorRouter } from './router';
import { useWorkspaceRouteStore } from './stores/workspaceRoute';

function browserRouteLocation(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

async function initializeRouterFromBrowserLocation(router: Router): Promise<void> {
  const initialLocation = browserRouteLocation();
  if (router.currentRoute.value.matched.length === 0 && router.currentRoute.value.fullPath !== initialLocation) {
    await router.push(initialLocation);
  }
  await router.isReady();
}

export async function startOperatorApp(): Promise<void> {
  const router = createOperatorRouter();

  // Expose router for keyboard shortcut navigation in AppShell and browser smoke inspection.
  (window as unknown as Record<string, unknown>).__vueRouter = router;

  const app = createApp(App);
  const pinia = createPinia();

  app.use(pinia);
  app.use(router);
  await initializeRouterFromBrowserLocation(router);
  useWorkspaceRouteStore().registerRouterListener(router);
  startAppBootstrap();
  app.mount('#app');
}

void startOperatorApp();
