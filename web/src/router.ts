import { createRouter, createWebHistory, type Router, type RouterHistory, type RouteRecordRaw } from 'vue-router';

const Cockpit = () => import('./views/CockpitView.vue').then((module) => module.default);
const Files = () => import('./views/FilesView.vue').then((module) => module.default);
const System = () => import('./views/SystemView.vue').then((module) => module.default);
const NotFound = () => import('./views/NotFound.vue').then((module) => module.default);

const operatorRoutes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: Cockpit },
  { path: '/cards', name: 'cards', component: Cockpit },
  { path: '/cards/:id', name: 'card-detail', component: Cockpit },
  { path: '/agents/:id', name: 'agent-detail', component: Cockpit },
  { path: '/files', name: 'files', component: Files },
  { path: '/system', name: 'system', component: System },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFound },
];

export function createOperatorRouter(history: RouterHistory = createWebHistory()): Router {
  return createRouter({
    history,
    routes: operatorRoutes,
  });
}
