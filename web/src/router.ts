import { createRouter, createWebHistory, type Router, type RouterHistory, type RouteRecordRaw } from 'vue-router';

const Dashboard = () => import('./views/DashboardView.vue');
const Cards = () => import('./views/CardsView.vue');
const Timeline = () => import('./views/TimelineView.vue');
const Agents = () => import('./views/AgentsView.vue');
const Files = () => import('./views/FilesView.vue');
const Debug = () => import('./views/DebugView.vue');
const NotFound = () => import('./views/NotFound.vue');

export const operatorRoutes: RouteRecordRaw[] = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', name: 'dashboard', component: Dashboard },
  { path: '/cards', name: 'cards', component: Cards },
  { path: '/cards/:id', name: 'card-detail', component: Cards },
  { path: '/timeline', name: 'timeline', component: Timeline },
  { path: '/agents', name: 'agents', component: Agents },
  { path: '/agents/:id', name: 'agent-detail', component: Agents },
  { path: '/files', name: 'files', component: Files },
  { path: '/debug', name: 'debug', component: Debug },
  { path: '/debug/process/:id', name: 'process-detail', component: Debug },
  { path: '/config', name: 'config', component: Debug },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFound },
];

export function createOperatorRouter(history: RouterHistory = createWebHistory()): Router {
  return createRouter({
    history,
    routes: operatorRoutes,
  });
}
