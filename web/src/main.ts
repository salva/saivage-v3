import './styles/index.css';
import 'highlight.js/styles/github.css';
import './styles/highlight-overrides.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { startAppBootstrap } from './composables/useAppBootstrap';
import { createOperatorRouter } from './router';
import { useWorkspaceRouteStore } from './stores/workspaceRoute';

const router = createOperatorRouter();

// Expose router for keyboard shortcut navigation in AppShell
(window as unknown as Record<string, unknown>).__vueRouter = router;

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);
useWorkspaceRouteStore().registerRouterListener(router);
startAppBootstrap();
app.mount('#app');
