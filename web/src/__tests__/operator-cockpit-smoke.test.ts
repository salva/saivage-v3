import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import App from '../App.vue';
import { createOperatorRouter } from '../router';
import appShellSource from '../components/layout/AppShell.vue?raw';
import { hierarchyView } from './card-view-fixtures';
import { useCardStore } from '../stores/cards';
import { useRuntimeStore } from '../stores/runtime';

const originalFetch = globalThis.fetch;
let requestedPaths: string[] = [];

const routeSmokeCases = [
  { path: '/', root: '[data-testid="route-cockpit"]', bodyText: /No current work|Inspecting|Observing runtime/i },
  { path: '/cards', root: '[data-testid="route-cockpit"]', bodyText: /Select a card to inspect/i },
  { path: '/cards/card-a', root: '[data-testid="route-cockpit"]', bodyText: /Inspecting/i },
  { path: '/agents/agent:planner:card-a', root: '[data-testid="route-cockpit"]', bodyText: /Smoke card|Resolving exact session scope/i },
  { path: '/files', root: '[data-testid="route-files"]', bodyText: /Metadata/i },
  { path: '/system', root: '[data-testid="route-system"]', bodyText: /State|Errors|Processes/i },
  { path: '/missing', root: '.not-found-view', bodyText: /404 — Not found/i },
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
    switch (decodeURIComponent(url.pathname)) {
      case '/api/state':
        return jsonResponse({
          projectId: 'operator-route-smoke',
          runtime: null,
          serverAvailability: {
            generatedAt: '2026-07-18T00:00:00.000Z',
            components: {
              api: { state: 'available', source: 'health-check', checkedAt: '2026-07-18T00:00:00.000Z' },
              runtime: { state: 'available', source: 'runtime-application', checkedAt: '2026-07-18T00:00:00.000Z' },
              mcp: { state: 'idle', source: 'mcp-manager', checkedAt: '2026-07-18T00:00:00.000Z' },
            },
          },
        });
      case '/api/runtime/status':
        return jsonResponse({
          runtime: 'stopped',
          currentCardId: null,
          started_at: '2026-07-18T00:00:00.000Z',
          restart_server_available: false,
          pid: 1,
          actorRuntime: { pauseMode: 'running', cards: [] },
          oversight: oversightFixture,
          serverAvailability: {
            generatedAt: '2026-07-18T00:00:00.000Z',
            components: {
              api: { state: 'available', source: 'health-check', checkedAt: '2026-07-18T00:00:00.000Z' },
              runtime: { state: 'available', source: 'runtime-application', checkedAt: '2026-07-18T00:00:00.000Z' },
              mcp: { state: 'idle', source: 'mcp-manager', checkedAt: '2026-07-18T00:00:00.000Z' },
            },
          },
        });
      case '/api/cards/project/children':
        return jsonResponse({ parent: hierarchyView('project'), children: [hierarchyView('card-a', { title: 'Smoke card' })] });
      case '/api/cards/project':
        return jsonResponse({ card: { id: 'project', type: 'project', title: 'Project', lifecycle: { status: 'backlog', result: null, error: null, completed_at: null }, version_seq: 1, urgency: 'normal', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', allowedActions: [] } });
      case '/api/cards/card-a':
        return jsonResponse({ card: { id: 'card-a', type: 'goal', title: 'Smoke card', lifecycle: { status: 'backlog', result: null, error: null, completed_at: null }, version_seq: 1, urgency: 'normal', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', allowedActions: [] } });
      case '/api/cards/card-a/agent-sessions':
        return jsonResponse({ sessions: [] });
      case '/api/agents/agent:planner:card-a':
        return jsonResponse({ session: { id: 'agent:planner:card-a', agent_name: 'planner', session_scope: 'card', card_id: 'card-a', started_at: '2026-01-01T00:00:00.000Z', status: 'inactive', activity: 'idle', compaction: null } });
      case '/api/debug/graphs':
        return jsonResponse({ graphs: [], global_agents: [] });
      case '/api/files':
        return jsonResponse({
          path: url.searchParams.get('path') ?? '.saivage',
          files: [],
        });
      case '/api/chat':
        return jsonResponse({ session_id: 'agent:analyst:global' });
      default:
        return new Response(JSON.stringify({ message: `Unhandled operator route smoke URL: ${url.pathname}` }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
    }
  });
}

const oversightFixture = {
  agent_name: 'oversight',
  session_id: 'agent:oversight:global',
  enabled: true,
  eligible: false,
  eligibility_reason: 'stopped',
  state: 'unavailable',
  next_nominal_due: null,
  last_attempt: null,
  last_successful_at: null,
  service_epoch: '2026-07-18T00:00:00.000Z',
};

async function waitForRouteRender(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

describe('operator cockpit route smoke contract', () => {
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
    if (path === '/cards' || path === '/cards/card-a') await useCardStore(pinia).ensureRoot();
    if (path === '/') await useRuntimeStore(pinia).fetchState().catch(() => {});
    await waitForRouteRender();

    const routeRoots = wrapper.findAll(root);
    expect(routeRoots, `${path} must render exactly one route-owned root ${root}`).toHaveLength(1);
    expect(routeRoots[0].text(), `${path} must render route-owned body content inside ${root}`).toMatch(bodyText);
    expect(renderErrors, `${path} Vue render/router errors`).toEqual([]);
    expect(unhandledErrors, `${path} window error events`).toEqual([]);
    expect(unhandledRejections, `${path} unhandled promise rejections`).toEqual([]);
    expect(requestedPaths.filter((requestedPath) => requestedPath === '/api/chat')).toHaveLength(1);
    wrapper.unmount();
  });

  it.each(['/cards', '/system'])('%s makes no hidden Agent, event, or MCP request', async (path) => {
    const router = createOperatorRouter(createMemoryHistory());
    await router.push(path);
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [createPinia(), router] } });
    await waitForRouteRender();
    expect(requestedPaths).not.toEqual(expect.arrayContaining(['/api/agents', '/api/events', '/api/mcp/tools']));
    wrapper.unmount();
  });

  it('removes the retired destinations while keeping the singular cockpit/session/files/system table', () => {
    const names = createOperatorRouter(createMemoryHistory()).getRoutes().map((route) => route.name);
    expect(names).toContain('home');
    expect(names).toContain('cards');
    expect(names).toContain('card-detail');
    expect(names).toContain('agent-detail');
    expect(names).toContain('files');
    expect(names).toContain('system');
    expect(names).not.toContain('dashboard');
    expect(names).not.toContain('agents');
    expect(names).not.toContain('debug');
    expect(names).not.toContain('process-detail');
  });

  it('keeps the persistent analyst panel mounted by the shell with no drawer toggle and no token UI', () => {
    expect(appShellSource).toContain('AnalystChatPanel');
    expect(appShellSource).toContain('workspace-content');
    expect(appShellSource).toContain('workspace-route-host');
    expect(appShellSource).toContain('GlobalStrip');
    expect(appShellSource).not.toContain('ApiTokenEntry');
    expect(appShellSource).not.toContain('open-token');
    expect(appShellSource).toMatch(/\.workspace-content\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(appShellSource).toMatch(/\.workspace-route-host\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s);
    expect(appShellSource).not.toMatch(/drawer|toggleAnalyst|open analyst|close analyst/i);
  });
});
