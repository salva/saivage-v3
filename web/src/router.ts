import { createRouter, createWebHistory, type Router, type RouterHistory, type RouteRecordRaw } from 'vue-router';

const Dashboard = () => import('./views/DashboardView.vue').then((module) => module.default);
const Cards = () => import('./views/CardsView.vue').then((module) => module.default);
const Agents = () => import('./views/AgentsView.vue').then((module) => module.default);
const Files = () => import('./views/FilesView.vue').then((module) => module.default);
const Debug = () => import('./views/DebugView.vue').then((module) => module.default);
const NotFound = () => import('./views/NotFound.vue').then((module) => module.default);

export const operatorRoutes: RouteRecordRaw[] = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', name: 'dashboard', component: Dashboard },
  { path: '/cards', name: 'cards', component: Cards },
  { path: '/cards/:id', name: 'card-detail', component: Cards },
  { path: '/agents', name: 'agents', component: Agents },
  { path: '/agents/:id', name: 'agent-detail', component: Agents },
  { path: '/files', name: 'files', component: Files },
  { path: '/debug', name: 'debug', component: Debug },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFound },
];

export function createOperatorRouter(history: RouterHistory = createWebHistory()): Router {
  return createRouter({
    history,
    routes: operatorRoutes,
  });
}
