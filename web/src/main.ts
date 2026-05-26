import './styles/index.css';
import 'highlight.js/styles/github-dark.css';
import './styles/highlight-overrides.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import App from './App.vue';
import { useWorkspaceRouteStore } from './stores/workspaceRoute';

// Lazy-loaded route components (filled in by later tasks)
const Dashboard = () => import('./views/DashboardView.vue');
const Cards = () => import('./views/CardsView.vue');
const Agents = () => import('./views/AgentsView.vue');
const Files = () => import('./views/FilesView.vue');
const Debug = () => import('./views/DebugView.vue');
const NotFound = () => import('./views/NotFound.vue');

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', name: 'dashboard', component: Dashboard },
  { path: '/cards', name: 'cards', component: Cards },
  { path: '/cards/:id', name: 'card-detail', component: Cards },
  { path: '/cards/:id/plan', name: 'card-plan', component: Cards },
  { path: '/agents', name: 'agents', component: Agents },
  { path: '/agents/:id', name: 'agent-detail', component: Agents },
  { path: '/files', name: 'files', component: Files },
  { path: '/debug', name: 'debug', component: Debug },
  { path: '/debug/process/:id', name: 'process-detail', component: Debug },
  { path: '/config', name: 'config', component: Debug },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFound },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Expose router for keyboard shortcut navigation in AppShell
(window as unknown as Record<string, unknown>).__vueRouter = router;

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);
useWorkspaceRouteStore().registerRouterListener(router);
app.mount('#app');
