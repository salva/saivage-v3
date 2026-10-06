import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { ModelRouter } from '../../src/agents/model-router.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { createRuntimeApplication } from '../../src/application/runtime-composition.js';
import { CardService } from '../../src/cards/card-service.js';
import { AgentLlmExchangeResponseSchema, agentOperatorApiContracts } from '../../src/contracts/operator-api-agents.js';
import { createEventLog } from '../../src/observability/index.js';
import { readProviderExchangeEntries } from '../../src/persistence/provider-exchange-log.js';
import { bindRuntimeWorkflows, compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { buildAgentOperatorContractHandlers } from '../../src/server/routes/operator-agent-handlers.js';
import { SyncHub } from '../../src/server/sync-hub.js';
import { LiveSyncSocket } from '../../src/server/live-sync-socket.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

afterEach(() => { jest.restoreAllMocks(); });
const expected = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_input_tokens: 40, reasoning_output_tokens: 5 };

describe('scripted provider token usage through real invocation/publication and mounted HTTP', () => {
  it.each(['chat', 'codex'] as const)('retains %s nested usage without raw metadata', async protocol => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-provider-usage-'));
    const server = Fastify({ logger: false });
    const hub = new SyncHub(new LiveSyncSocket(), 10);
    try {
      initProjectTree(root);
      // Synthetic JWT-shaped credential only; fetch is entirely scripted below.
      const token = `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.synthetic`;
      const provider = protocol === 'codex' ? 'openai-codex' : 'test';
      const config = effectiveSaivageConfigSchema.parse({
        ...structuredClone(TEST_SAIVAGE_CONFIG),
        providers: { [provider]: { models: ['test-model'], baseUrl: 'https://scripted.invalid/v1', apiKey: protocol === 'codex' ? token : 'synthetic', capabilities: {
          transportProtocol: protocol === 'codex' ? 'openai-codex-backend' : 'openai-chat-completions', toolsMode: 'native', exclusiveToolChoiceSupport: 'native', contextWindowTokens: 100000, maxOutputTokens: 10000,
        } } },
        compaction: { ...structuredClone(TEST_SAIVAGE_CONFIG.compaction), summarizer_candidate: { provider, account: null, model: 'test-model' } },
      });
      const registry = new ProviderRegistry(config);
      const workflows = bindRuntimeWorkflows(compileProjectWorkflows(config), new ModelRouter(registry), registry, config.compaction.context_utilization_fraction);
      const groups = new ManagedProcessGroupRegistry();
      const app = createRuntimeApplication({
        projectRoot: root, processIdentity: { pid: 42, startedAt: '2026-10-06T00:00:00.000Z' }, config, workflows, providerRegistry: registry,
        configAuthority: createTestConfigAuthority(root), cardStore: new CardService(root, workflows, hub), freshness: hub,
        processRunner: new ProcessRunner(root, groups, testApplicationFatalPort),
        runtimeProcessRootScope: groups.createContainerScope(groups.rootScope, 'runtime'), analystProcessRootScope: groups.createContainerScope(groups.rootScope, 'analyst'),
        mcpToolInvocation: unusedMcpToolInvocation, restartCapability: { available: false }, fatalPort: testApplicationFatalPort,
        onOversightOwnerFailure(error) { throw error; }, analystSessionId: 'agent:analyst:global',
      });
      const usage = protocol === 'chat'
        ? { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40, audio_tokens: 999 }, completion_tokens_details: { reasoning_tokens: 5 }, private_marker: 'unconsumed-private' }
        : { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 999 }, output_tokens_details: { reasoning_tokens: 5 }, private_marker: 'unconsumed-private' };
      const wire = protocol === 'chat'
        ? JSON.stringify({ choices: [{ message: { content: 'Scripted answer.' }, finish_reason: 'stop' }], usage })
        : [{ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Scripted answer.' }] } }, { type: 'response.completed', response: { id: 'synthetic-response', usage } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
      const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(wire, { status: 200 }));
      await app.analystRuntime.submit({ userContent: 'Give a short answer without tools.' });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]![1]!.body)).not.toContain('cached_input_tokens');
      const rows = readProviderExchangeEntries(root, app.analystSessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data.payload).toMatchObject({ status: 'ok', token_usage: expected });
      const handlers = buildAgentOperatorContractHandlers({ projectRoot: root, workflows, captureExecutingLlmSnapshots: () => new Map() });
      new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger: createEventLog(root), fatalPort: testApplicationFatalPort }).mount(server,
        { 'agents.llmExchange': agentOperatorApiContracts['agents.llmExchange'] }, { 'agents.llmExchange': handlers['agents.llmExchange']! });
      const response = await server.inject({ method: 'GET', url: `/api/agents/${encodeURIComponent(app.analystSessionId)}/llm-exchange` });
      expect(response.statusCode).toBe(200);
      const dto = AgentLlmExchangeResponseSchema.parse(response.json());
      expect(dto.exchange).toMatchObject({ status: 'ok', token_usage: expected });
      expect(response.body).not.toContain('unconsumed-private');
      expect(response.body).not.toContain('cache_write_tokens');
      expect(response.body).not.toContain('audio_tokens');
    } finally {
      await server.close(); hub.dispose(); rmSync(root, { recursive: true, force: true });
    }
  });
});
