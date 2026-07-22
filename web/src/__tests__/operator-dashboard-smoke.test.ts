import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import App from '../App.vue';
import { createOperatorRouter } from '../router';
import dashboardSource from '../views/DashboardView.vue?raw';
import appShellSource from '../components/layout/AppShell.vue?raw';
import { cardView } from './card-view-fixtures';
import { useCardStore } from '../stores/cards';

const originalFetch = globalThis.fetch;
let requestedPaths: string[] = [];

const routeSmokeCases = [
  { path: '/dashboard', root: '[data-testid="route-dashboard"]', bodyText: /Runtime Console/i },
  { path: '/cards', root: '[data-testid="route-cards"]', bodyText: /Project/i },
  { path: '/agents', root: '[data-testid="route-agents"]', bodyText: /Could not load agents|No agent sessions recorded yet/i },
  { path: '/files', root: '[data-testid="route-files"]', bodyText: /Metadata/i },
  { path: '/debug', root: '[data-testid="route-debug"]', bodyText: /State|Errors|Timeline/i },
] as const;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installOperatorApiFetch(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    requestedPaths.push(url.pathname);
    switch (url.pathname) {
      case '/api/state':
        return jsonResponse({
          projectRoot: '/workspace/smoke',
          projectId: 'operator-route-smoke',
          runtime: null,
        });
      case '/api/runtime/status':
        return jsonResponse({ runtime: 'stopped', currentCardId: null, started_at: '2026-07-18T00:00:00.000Z', restart_server_available: false, pid: 1, actorRuntime: { pauseMode: 'running', cards: [] } });
      case '/api/cards/project/children':
        return jsonResponse({ card: cardView('project'), children: [] });
      case '/api/agents':
        return jsonResponse({ sessions: [] });
      case '/api/files':
        return jsonResponse({
          path: url.searchParams.get('path') ?? '.saivage',
          files: [],
        });
      case '/api/debug/errors':
        return jsonResponse({ errors: [], total: 0 });
      case '/api/events':
        return jsonResponse({ events: [], total: 0 });
      case '/api/mcp/tools':
        return jsonResponse({ tools: [], servers: [], invocationStats: {}, serverDetails: [] });
      case '/api/chat':
        return jsonResponse({ session_id: 'agent:analyst:global', session: null, entries: [], activity_status: { status: 'inactive', pending_calls: [] } });
      default:
        return new Response(JSON.stringify({ message: `Unhandled operator route smoke URL: ${url.pathname}` }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
    }
  });
}

async function waitForRouteRender(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

describe('operator dashboard S06 smoke contract', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrors: string[];
  let renderErrors: string[];
  let unhandledErrors: string[];
  let unhandledRejections: string[];

  function captureWindowError(event: ErrorEvent): void {
    unhandledErrors.push(event.error instanceof Error ? event.error.message : event.message);
  }

  function captureUnhandledRejection(event: PromiseRejectionEvent): void {
    const reason = event.reason;
    unhandledRejections.push(reason instanceof Error ? reason.message : String(reason));
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    installOperatorApiFetch();
    requestedPaths = [];
    consoleErrors = [];
    renderErrors = [];
    unhandledErrors = [];
    unhandledRejections = [];
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });
    window.addEventListener('error', captureWindowError);
    window.addEventListener('unhandledrejection', captureUnhandledRejection);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    globalThis.fetch = originalFetch;
    window.removeEventListener('error', captureWindowError);
    window.removeEventListener('unhandledrejection', captureUnhandledRejection);
  });

  it.each(routeSmokeCases)('renders the actual routed app view for $path', async ({ path, root, bodyText }) => {
    const router = createOperatorRouter(createMemoryHistory());
    await router.push(path);
    await router.isReady();

    const pinia = createPinia();
    const wrapper: VueWrapper = mount(App, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router],
        config: {
          errorHandler(error) {
            renderErrors.push(error instanceof Error ? error.message : String(error));
          },
        },
      },
    });
    if (path === '/cards') await useCardStore(pinia).ensureRoot();
    await waitForRouteRender();

    const routeRoots = wrapper.findAll(root);
    expect(routeRoots, `${path} must render exactly one route-owned root ${root}`).toHaveLength(1);
    expect(routeRoots[0].text(), `${path} must render route-owned body content inside ${root}`).toMatch(bodyText);
    expect(renderErrors, `${path} Vue render/router errors`).toEqual([]);
    expect(consoleErrors, `${path} console.error output`).toEqual([]);
    expect(unhandledErrors, `${path} window error events`).toEqual([]);
    expect(unhandledRejections, `${path} unhandled promise rejections`).toEqual([]);
    expect(requestedPaths.filter((requestedPath) => requestedPath === '/api/chat')).toHaveLength(1);
    wrapper.unmount();
  });

  it('keeps passive runtime refresh and removes the dashboard-local analyst chat', () => {
    expect(dashboardSource).not.toContain('Analyst Chat');
    expect(dashboardSource).not.toContain('class="chat-input"');
    expect(dashboardSource).not.toContain('@click="sendChat"');
    expect(dashboardSource).toContain('Runtime Console');
    expect(dashboardSource).toContain('@click="refreshRuntime"');

    expect(dashboardSource).not.toMatch(/Start Project|startProject/);
    expect(dashboardSource).not.toMatch(/NotificationsPanel|acknowledgeNotification/);
  });

  it('keeps the persistent analyst panel mounted by the shell with no drawer toggle', () => {
    expect(appShellSource).toContain('AnalystChatPanel');
    expect(appShellSource).toContain('workspace-content');
    expect(appShellSource).toContain('workspace-route-host');
    expect(appShellSource).toMatch(/\.workspace-content\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(appShellSource).toMatch(/\.workspace-route-host\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s);
    expect(appShellSource).toMatch(/\.auth-banner\s*\{[^}]*flex-shrink:\s*0;/s);
    expect(appShellSource).not.toMatch(/drawer|toggleAnalyst|open analyst|close analyst/i);
  });
});
