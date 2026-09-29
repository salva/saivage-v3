import { expect, test } from '@playwright/test';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { seedTokenBeforeNavigation } from './fixtures/operator-preview-sync.js';
import { AnalystRuntime, AnalystSession } from '../../../src/agents/analyst-handler.js';
import { CardService, initProjectTree } from '../../helpers/canonical-project.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import { scriptedAdmissionProvider, testCompactionPolicy, unusedSummarizerProvider } from '../../helpers/llm-test-helpers.js';
import { readConversation, readCurrentConversationSegment } from '../../../src/persistence/conversation-file.js';
import { globalAgentConversationVersionFile } from '../../../src/persistence/layout.js';
import { buildChatOperatorContractHandlers } from '../../../src/server/routes/operator-chat-handlers.js';
import { ContractRuntime } from '../../../src/server/contract-runtime.js';
import { AuthPolicy } from '../../../src/server/auth-policy.js';
import { chatOperatorApiContracts } from '../../../src/contracts/operator-api-chats.js';
import { createEventLog } from '../../../src/observability/index.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';
import type { RuntimeApplication } from '../../../src/application/runtime-composition.js';

test('browser sends frozen card focus to real shared Analyst while inspected content stays available', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'analyst-browser-focus-'));
  const api = Fastify({ logger: false });
  try {
    initProjectTree(root);
    const observed: Array<{ content: string; focus: any }> = [];
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const provider = scriptedAdmissionProvider(async (input) => {
      const block = input.preparedContext!.dynamicBlocks.find((item) => item.id === 'analyst.workspace_focus')!;
      observed.push({ content: block.content, focus: JSON.parse(block.content) });
      if (observed.length === 1) await paused;
      return { result: { kind: 'message' as const, content: 'acknowledged' }, provider_exchanges: [] };
    });
    const cardStore = new CardService(root);
    const session = new AnalystSession({
      cardTypeVocabulary: ['project'], fatalPort: testApplicationFatalPort, sessionId: 'agent:analyst:global', agentName: 'analyst', modelParams: { temperature: 0, maxTokens: 1000 }, capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true }, candidateChain: [{ provider: 'test', account: null, model: 'test-model' }], routeUsableInputTokens: 80_000, promptTemplates: { render: () => 'Saivage Analyst' }, restartCapability: { available: false }, provider, conversations: { projectRoot: root }, compactionPolicy: testCompactionPolicy, compactor: { shouldCompact: () => false, compact: async () => { throw new Error('unexpected compaction'); } }, summarizerProvider: unusedSummarizerProvider, cardStore, runtimeCurrent: () => ({ status: 'stopped', currentCardId: null }), runtimeProjectionChanged() {}, createInvocationSurface: () => ({ agentName: 'analyst', tools: new Map(), providers: [] }), shutdownProcesses: async () => {},
    });
    const runtime = new AnalystRuntime({ createSession: () => session, getAvailableToolNames: () => [], terminateRoot: async () => ({ selected: [], stopped: [], failed: [] }) });
    new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'focus-token' }), eventLogger: createEventLog(root), fatalPort: testApplicationFatalPort }).mount(api, chatOperatorApiContracts, buildChatOperatorContractHandlers({ projectRoot: root, runtimeApplication: { analystRuntime: runtime, analystSessionId: 'agent:analyst:global', cardStore } as unknown as RuntimeApplication, saivageConfig: TEST_SAIVAGE_CONFIG, restartCapability: { available: false } }));
    await api.ready();

    await seedTokenBeforeNavigation(page, 'focus-token');
    await installOperatorWebSocketShim(page);
    await installOperatorRestRoutes(page);
    await page.route('**/api/chat', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const result = await api.inject({ method: 'POST', url: '/api/chat', headers: { authorization: 'Bearer focus-token' }, payload: route.request().postDataJSON() });
      await route.fulfill({ status: result.statusCode, contentType: 'application/json', body: result.body });
    });
    const project = cardStore.list().find((card) => card.id === 'project')!;
    await page.goto('/cards/project');
    await expect(page.getByTestId('route-cockpit')).toBeVisible();
    const composer = page.getByLabel('Analyst chat composer');
    await composer.fill('what about this card?');
    await composer.press('Enter');
    await expect.poll(() => observed.length).toBe(1);
    expect(observed[0]!.focus.route).toMatchObject({ view: 'cockpit', entityId: 'project' });
    expect(observed[0]!.focus.focus).toMatchObject({ relation: 'card', card_id: project.id, type: project.type, version_seq: project.version_seq, lifecycle_status: project.lifecycle.status });
    expect(readConversation(root, 'agent:analyst:global').sourceRows.slice(0, 2).map((row) => [row.role, row.kind, row.content])).toEqual([
      ['system', 'activity', expect.stringContaining('activation_open')],
      ['user', 'text', 'what about this card?'],
    ]);
    const segment = readCurrentConversationSegment(root, 'agent:analyst:global')!;
    const stream = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename);
    const firstEnvelope = JSON.parse(readFileSync(stream, 'utf8').split('\n')[0]!) as { rows: Array<{ role?: string; kind: string }> };
    expect(firstEnvelope.rows.slice(1).map((row) => [row.role, row.kind])).toEqual([['system', 'activity'], ['user', 'text']]);
    await expect(page.getByTestId('route-cockpit')).toContainText('Synthetic Project');
    await page.goto('/system');
    await expect(page.getByTestId('route-system')).toBeVisible();
    release();
    await expect.poll(() => readConversation(root, 'agent:analyst:global').sourceRows.filter((row) => row.role === 'user').length).toBe(1);
    await composer.fill('what is here now?');
    await composer.press('Enter');
    await expect.poll(() => observed.length).toBe(2);
    expect(observed[0]!.focus.route.entityId).toBe('project');
    expect(observed[1]!.focus.route.view).toBe('system');
    expect(observed[1]!.focus.focus).toBe('not_provided');
    const rows = readConversation(root, 'agent:analyst:global').sourceRows;
    expect(rows.filter((row) => row.role === 'user').map((row) => row.content)).toEqual(['what about this card?', 'what is here now?']);
    expect(rows.some((row) => row.content.includes('workspace_focus'))).toBe(false);
  } finally {
    await api.close();
    rmSync(root, { recursive: true, force: true });
  }
});
