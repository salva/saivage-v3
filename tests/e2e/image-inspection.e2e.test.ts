import { expect, it } from '@jest/globals';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { InvocationService } from '../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { createInvocationServiceProvider, executeInternalSummaryTurn } from '../../src/application/invocation-service-provider.js';
import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { buildLlmOptions } from '../../src/agents/llm-options-factory.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/contracts/index.js';
import { AnalystSession } from '../../src/runtime/actors/analyst-session.js';
import { globalWorkspaceObservationToolBinders } from '../../src/tools/workspace-provider.js';
import { processToolBinders } from '../../src/tools/process-provider.js';
import { type InvocationSurface } from '../../src/tools/invocation.js';
import { readConversation, materializeConversationImage } from '../../src/persistence/session-api.js';
import { conversationImageFile, providerExchangeFile } from '../../src/persistence/layout.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { compact, prepareCompaction } from '../../src/runtime/actors/compaction/compactor.js';
import { type SummarizerProviderPort } from '../../src/runtime/actors/compaction/summarizer.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import { initProjectTree, CardService } from '../helpers/canonical-project.js';
import { createTestProcessRunner, cleanupTestProcessRunners } from '../helpers/test-process-runner.js';
import { makeCodexJwt, testCompactionPolicy } from '../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { noCompactionProgress } from '../helpers/executing-llm-snapshot.js';

const SESSION = 'agent:analyst:global' as const;
const summary = 'Visual summary: the first screenshot has a red left half and blue right half; the new observation is green. '.repeat(120);
const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const call = (id: string, name: string, args: unknown) => ({ type: 'function_call', id: `item-${id}`, call_id: id, name, arguments: JSON.stringify(args) });

async function assertPixels(url: unknown, original = false, green = false) {
  expect(typeof url).toBe('string');
  expect(String(url)).toMatch(/^data:image\/png;base64,/);
  const { data, info } = await sharp(Buffer.from(String(url).split(',')[1]!, 'base64')).raw().toBuffer({ resolveWithObject: true });
  expect([info.width, info.height]).toEqual(original ? [2048, 1024] : [1600, 800]);
  const pixel = (x: number) => [...data.subarray((Math.floor(info.height / 2) * info.width + x) * info.channels, (Math.floor(info.height / 2) * info.width + x) * info.channels + 3)];
  expect(pixel(20)).toEqual(green ? [0, 255, 0] : [255, 0, 0]);
  expect(pixel(info.width - 20)).toEqual(green ? [0, 255, 0] : [0, 0, 255]);
}

it.each([
  ['openai-responses', 'gpt-6.1-sol'], ['openai-responses', 'gpt-6-astra'],
  ['openai-codex-backend', 'gpt-6.1-sol'], ['openai-codex-backend', 'gpt-6-astra'],
] as const)('real loopback %s / %s command → immutable pixels → reopen → original → HTTP summary', async (protocol, model) => {
  const projectRoot = mkdtempSync('/home/salva/g/ml/tmp/image-native-e2e-');
  initProjectTree(projectRoot);
  const posted: string[] = [];
  let phase = 0;
  let handlerFailure: unknown;
  const server = createServer(async (req, res) => {
    try {
      expect(req.url).toBe(protocol === 'openai-responses' ? '/v1/responses' : '/codex/responses');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const wire = Buffer.concat(chunks).toString('utf8');
      posted.push(wire);
      const body = JSON.parse(wire);
      expect(body.model).toBe(model);
      expect(body.stream).toBe(protocol === 'openai-codex-backend');
      const outputs = body.input.filter((item: Record<string, unknown>) => item.type === 'function_call_output');
      const images = outputs.flatMap((item: { output: unknown }) => Array.isArray(item.output) ? item.output.filter(part => part.type === 'input_image') : []);
      for (const item of outputs) if (Array.isArray(item.output)) {
        expect(item.output).toHaveLength(2);
        const selected = JSON.parse(item.output[0].text);
        const bytes = Buffer.from(item.output[1].image_url.split(',')[1], 'base64');
        expect(selected.data.source_path).toBe('screen.png');
        expect(selected).not.toHaveProperty('content');
        const durableResult = readConversation(projectRoot, SESSION).physicalRows.find(row => row.kind === 'tool_result' && row.tool_call_id === item.call_id)!;
        const descriptor = JSON.parse(durableResult.content).content[0].image;
        expect(descriptor.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect(readFileSync(conversationImageFile(projectRoot, SESSION, descriptor.id))).toEqual(bytes);
      }
      let output: unknown[];
      switch (phase++) {
        case 0: output = [call('capture', 'run_command', { command: `${JSON.stringify(process.execPath)} capture.mjs`, wait: true, timeout_ms: 5000 })]; break;
        case 1:
          expect(images).toHaveLength(0); // stdout is a path, never implicit vision
          expect(outputs.find((item: { call_id: string }) => item.call_id === 'capture').output).toContain('screen.png');
          output = [call('inspect', 'view_image', { path: 'screen.png' })]; break;
        case 2:
        case 3:
          expect(images).toHaveLength(1);
          expect(outputs.find((item: { call_id: string }) => item.call_id === 'inspect').output[1].type).toBe('input_image');
          expect(images[0]).not.toHaveProperty('detail');
          await assertPixels(images[0].image_url);
          output = phase === 4 ? [call('original', 'view_image', { path: 'screen.png', max_dimension: 'original' })] : [message('recorded first observation')]; break;
        case 4:
          expect(images).toHaveLength(2);
          await assertPixels(images[0].image_url);
          await assertPixels(images[1].image_url, true, true);
          expect(outputs.find((item: { call_id: string }) => item.call_id === 'original').output[1]).not.toHaveProperty('detail');
          output = [message('recorded new observation')]; break;
        case 5: {
          expect(images).toHaveLength(0); // summary uses user material, not invented calls
          const summaryImages = body.input.flatMap((item: { content?: unknown[] }) => Array.isArray(item.content) ? item.content.filter(part => (part as { type: string }).type === 'input_image') : []);
          expect(summaryImages).toHaveLength(2);
          await assertPixels(summaryImages[0].image_url);
          await assertPixels(summaryImages[1].image_url, true, true);
          output = [message(summary)]; break;
        }
        case 6:
          expect(images).toHaveLength(0);
          expect(wire).toContain('Visual summary:');
          expect(wire).not.toContain('data:image/');
          output = [message('continued from visual summary')]; break;
        default: throw new Error('Unexpected HTTP request');
      }
      if (protocol === 'openai-responses') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `response-${phase}`, status: 'completed', output }));
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const item of output) res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', item })}\n\n`);
        res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `response-${phase}` } })}\n\n`);
      }
    } catch (error) {
      handlerFailure = error;
      res.writeHead(400, { 'content-type': 'application/json' }); // Assertion failures are terminal, not retryable outages.
      res.end('{"error":{"message":"synthetic pixel assertion failed"}}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const processes = createTestProcessRunner(projectRoot);
  const sessions: AnalystSession[] = [];
  try {
    // The ordinary command, not this test, creates the observed raster.
    writeFileSync(join(projectRoot, 'capture.mjs'), `import sharp from ${JSON.stringify(import.meta.resolve('sharp'))};
const pixels=Buffer.alloc(2048*1024*3); for(let y=0;y<1024;y++)for(let x=0;x<2048;x++)pixels[(y*2048+x)*3+(x<1024?0:2)]=255;
await sharp(pixels,{raw:{width:2048,height:1024,channels:3}}).png().toFile('screen.png'); console.log('screen.png');`);
    const providerName = protocol === 'openai-codex-backend' ? 'openai-codex' : 'loopback';
    const candidate = { provider: providerName, account: null, model };
    const makeProvider = () => {
      const registry = new ProviderRegistry({ ...structuredClone(DEFAULT_SAIVAGE_CONFIG), providers: { [providerName]: { models: [model], baseUrl: `http://127.0.0.1:${port}`, apiKey: protocol === 'openai-responses' ? 'synthetic-key' : makeCodexJwt('synthetic-account'), capabilities: { transportProtocol: protocol, toolsMode: 'native', exclusiveToolChoiceSupport: protocol === 'openai-responses' ? 'native' : 'parallel_off', contextWindowTokens: 1_050_000, maxOutputTokens: 128_000 } } } });
      const service = new InvocationService({ projectRoot, registry, candidateAvailability: new MemoryCandidateAvailability(), freshness: NO_FRESHNESS_EFFECTS });
      const provider = createInvocationServiceProvider(service, projectRoot);
      const summaryProvider: SummarizerProviderPort = {
        candidate, contextWindowTokens: 1_050_000, maxOutputTokens: 128_000,
        materializeImage: (session, descriptor) => materializeConversationImage(projectRoot, session, descriptor),
        serializeSummaryRequest: input => {
          const plan = buildCandidateRequest({ candidate, capabilities: registry.getEffectiveCapabilities(candidate), adapter: selectLlmProtocolAdapter(protocol), systemPrompt: input.systemPrompt, providerConversation: input.providerConversation, options: buildLlmOptions(input.agentName, input.tools, input.terminalToolNames, { temperature: input.modelParams.temperature, max_tokens: input.modelParams.maxTokens! }, undefined, input.inputId, { projectRoot, sessionId: input.sessionId }) });
          return { serializedRequest: plan.request.serializedBody, requestSha256: plan.request.requestHash, estimatedInputTokens: plan.request.estimatedWireInputTokens, imageCount: plan.request.imageCount };
        },
        completeTurn: (input, admitted, signal) => executeInternalSummaryTurn(service, input, signal, admitted),
        projectProviderExchanges: (...args) => service.projectProviderExchanges(...args),
      };
      return { provider, summaryProvider };
    };
    const scope = processes.processRunner.createDirectScope(processes.analystProcessRootScope, 'image-e2e', 'operator_session');
    const command = processToolBinders.find(tool => tool.name === 'run_command')!.bind({ projectRoot, processRunner: processes.processRunner, directScope: scope, category: 'operator_session', ownerId: SESSION, ownerKind: 'operator' });
    const image = globalWorkspaceObservationToolBinders.find(tool => tool.name === 'view_image')!.bind({ projectRoot, agentName: 'analyst', store: new CardService(projectRoot) });
    const surface: InvocationSurface = { agentName: 'analyst', tools: new Map([[command.name, command], [image.name, image]]), providers: [{ providerName: 'process', tools: [command] }, { providerName: 'workspace', tools: [image] }] };
    const createSession = () => {
      const ports = makeProvider();
      const session = new AnalystSession({ cardTypeVocabulary: ['project'], fatalPort: testApplicationFatalPort, sessionId: SESSION, agentName: 'analyst', modelParams: { temperature: 0, maxTokens: 2000 }, capabilityRequest: { requiresTools: true, requiresImages: true, requiresExclusiveToolChoice: true }, candidateChain: [candidate], routeUsableInputTokens: 800_000, promptTemplates: { render: () => 'Inspect the non-secret screenshot using commands and view_image.' }, restartCapability: { available: false }, provider: ports.provider, conversations: { projectRoot }, compactionPolicy: testCompactionPolicy, compactor: { shouldCompact: () => false, compact: async () => { throw new Error('Unexpected automatic compaction'); } }, summarizerProvider: ports.summaryProvider, cardStore: new CardService(projectRoot), runtimeCurrent: () => ({ status: 'stopped', currentCardId: null }), runtimeProjectionChanged() {}, createInvocationSurface: () => surface, shutdownProcesses: async () => {} });
      sessions.push(session);
      return session;
    };
    const first = createSession();
    await first.submit({ userContent: 'Capture and inspect screen.png' });
    if (handlerFailure) throw handlerFailure;
    expect(phase).toBe(3);
    const old = readConversation(projectRoot, SESSION).physicalRows.find(row => row.tool === 'view_image' && row.kind === 'tool_result')!;
    const originalSource = readFileSync(join(projectRoot, 'screen.png'));
    expect((await sharp(originalSource).metadata()).width).toBe(2048);
    writeFileSync(join(projectRoot, 'screen.png'), await sharp({ create: { width: 2048, height: 1024, channels: 3, background: '#00ff00' } }).png().toBuffer());
    // Fresh application provider/session owns no remembered payload cache.
    const reopened = createSession();
    await reopened.submit({ userContent: 'Inspect the overwritten source at local original resolution' });
    expect(phase).toBe(5);
    const images = readConversation(projectRoot, SESSION).physicalRows.filter(row => row.tool === 'view_image' && row.kind === 'tool_result').map(row => JSON.parse(row.content).content[0].image);
    expect(images).toHaveLength(2);
    expect(images[0].id).toBe(JSON.parse(old.content).content[0].image.id);
    expect(images[1].id).not.toBe(images[0].id);
    const projection = providerConversationProjection(readConversation(projectRoot, SESSION), []);
    const preparedCompaction = prepareCompaction({ context_utilization_fraction: 0.8, trigger_fraction: 0.8, tail_fraction: 0, snap: 'compact_straddler' }, 'system', [], 800_000, 2000);
    const result = await compact({ summaryRefusal: null, strategy: 'local_exact_admission', conversations: { projectRoot }, input: { inputId: '00000000-0000-4000-8000-000000000001', agentId: SESSION, agentName: 'analyst', sessionId: SESSION, systemPrompt: 'system', providerConversation: projection, tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 }, preparedCompaction, preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }), capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: [candidate] }, episodeContext: {} }, summarizerProvider: makeProvider().summaryProvider, signal: new AbortController().signal, progress: noCompactionProgress });
    expect(result.kind).toBe('compacted');
    if (result.kind !== 'compacted') throw new Error('Expected visual compaction');
    const tupleBytes = (messages: typeof projection.messages) => Buffer.byteLength(JSON.stringify(messages.map(item => item.kind === 'synthetic_context' ? [item.kind, item.origin, item.block_identity, item.role, item.content] : [item.id, item.role, item.kind, item.content])));
    expect(tupleBytes(result.providerConversation.messages)).toBeGreaterThan(tupleBytes(projection.messages));
    expect(result.providerConversation.messages.some(item => item.kind === 'synthetic_context' && item.content.includes(summary.trim()))).toBe(true);
    await createSession().submit({ userContent: 'Continue from the summary' });
    expect(phase).toBe(7);
    expect(Buffer.byteLength(posted[6]!)).toBeLessThan(Buffer.byteLength(posted[4]!));
    // Public durable rows/evidence contain metadata, never invocation-local binary values.
    expect(JSON.stringify(readConversation(projectRoot, SESSION))).not.toMatch(/data:image|base64|\/images\//);
    const evidence = readFileSync(providerExchangeFile(projectRoot, SESSION), 'utf8');
    expect(evidence).not.toMatch(/data:image|base64|\/images\//);
    expect(evidence).toContain('internal:compaction-summary:');
    if (handlerFailure) throw handlerFailure;
  } finally {
    for (const session of sessions) { session.disposeSession(new Error('test closed')); await session.joinSession(); }
    await cleanupTestProcessRunners(projectRoot);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(projectRoot, { recursive: true, force: true });
  }
}, 60_000);
