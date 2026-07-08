import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import App from '../App.vue';
import { createOperatorRouter } from '../router';
import dashboardSource from '../views/DashboardView.vue?raw';
import appShellSource from '../components/layout/AppShell.vue?raw';

const originalFetch = globalThis.fetch;

const routeSmokeCases = [
  { path: '/dashboard', root: '[data-testid="route-dashboard"]', bodyText: /Runtime Console/i },
  { path: '/cards', root: '[data-testid="route-cards"]', bodyText: /Any status|Could not load cards/i },
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
    const timestamp = '2026-07-08T00:00:00.000Z';
    switch (url.pathname) {
      case '/api/state':
        return jsonResponse({
          projectRoot: '/workspace/smoke',
          projectId: 'operator-route-smoke',
          runtime: null,
          cardIndex: { total: 0, byStatus: {}, byType: {} },
        });
      case '/api/cards':
        return jsonResponse({ cards: [], total: 0 });
      case '/api/agents':
        return jsonResponse({ sessions: [] });
      case '/api/files':
        return jsonResponse({
          path: url.searchParams.get('path') ?? '.saivage',
          files: [],
        });
      case '/api/debug/state':
        return jsonResponse({ runtime: null, cards: [], totalCards: 0 });
      case '/api/debug/errors':
        return jsonResponse({ errors: [], total: 0 });
      case '/api/debug/timeline':
        return jsonResponse({ events: [], total: 0 });
      case '/api/mcp/tools':
        return jsonResponse({ tools: [], servers: [], invocationStats: {}, serverDetails: [] });
      case '/api/chats':
        return jsonResponse({ sessions: [{ id: 'analyst:global', role: 'analyst', status: 'active', started_at: timestamp }] });
      case '/api/chats/analyst%3Aglobal':
      case '/api/chats/analyst:global':
        return jsonResponse({ sessionId: 'analyst:global', entries: [] });
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

    const wrapper: VueWrapper = mount(App, {
      attachTo: document.body,
      global: {
        plugins: [createPinia(), router],
        config: {
          errorHandler(error) {
            renderErrors.push(error instanceof Error ? error.message : String(error));
          },
        },
      },
    });
    await waitForRouteRender();

    const routeRoots = wrapper.findAll(root);
    expect(routeRoots, `${path} must render exactly one route-owned root ${root}`).toHaveLength(1);
    expect(routeRoots[0].text(), `${path} must render route-owned body content inside ${root}`).toMatch(bodyText);
    expect(renderErrors, `${path} Vue render/router errors`).toEqual([]);
    expect(consoleErrors, `${path} console.error output`).toEqual([]);
    expect(unhandledErrors, `${path} window error events`).toEqual([]);
    expect(unhandledRejections, `${path} unhandled promise rejections`).toEqual([]);
    wrapper.unmount();
  });

  it('keeps passive runtime refresh and removes the dashboard-local analyst chat', () => {
    expect(dashboardSource).not.toContain('Analyst Chat');
    expect(dashboardSource).not.toContain('class="chat-input"');
    expect(dashboardSource).not.toContain('@click="sendChat"');
    expect(dashboardSource).toContain('Runtime Console');
    expect(dashboardSource).toContain('@click="refreshRuntime"');

    expect(dashboardSource).not.toMatch(/Start Project|Stop Project|startProject|stopProject/);
    expect(dashboardSource).not.toMatch(/NotificationsPanel|acknowledgeNotification/);
  });

  it('keeps the persistent analyst panel mounted by the shell with no drawer toggle', () => {
    expect(appShellSource).toContain('AnalystChatPanel');
    expect(appShellSource).toContain('workspace-content');
    expect(appShellSource).not.toMatch(/drawer|toggleAnalyst|open analyst|close analyst/i);
  });
});
