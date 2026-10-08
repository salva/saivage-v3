import { afterEach, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import sharp from 'sharp';
import { agentOperatorApiContracts } from '../../src/contracts/operator-api-agents.js';
import { filesDebugOperatorApiContracts } from '../../src/contracts/operator-api-files-debug.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { buildAgentOperatorContractHandlers } from '../../src/server/routes/operator-agent-handlers.js';
import { buildFilesDebugOperatorContractHandlers } from '../../src/server/routes/operator-files-debug-handlers.js';
import { createEventLog } from '../../src/observability/index.js';
import {
  appendConversationBatch,
  readCurrentConversationSegment,
} from '../../src/persistence/conversation-file.js';
import {
  conversationImageFile,
  cardConversationVersionFile,
} from '../../src/persistence/layout.js';
import {
  publishConversationImage,
  materializeConversationImage,
} from '../../src/persistence/session-api.js';
import {
  CardService,
  initProjectTree,
  TEST_RUNTIME_WORKFLOWS,
} from '../helpers/canonical-project.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import {
  testLlmToolInvocationContext,
  unusedMcpToolInvocation,
} from '../helpers/llm-test-helpers.js';
import { mcpToolBinders } from '../../src/tools/mcp-provider.js';
import { globalWorkspaceObservationToolBinders } from '../../src/tools/workspace-provider.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { toolRowPolicies, ACTIVITY_ROW_POLICY } from '../helpers/row-policy-fixtures.js';
import { type ImageDescriptor } from '../../src/contracts/index.js';
import type { AgentMessage, ConversationSessionId } from '../../src/schemas/index.js';
import { responsesBundle, RESPONSES_A } from '../helpers/responses-producer-fixture.js';
import { compact, prepareCompaction } from '../../src/runtime/actors/compaction/compactor.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import { deterministicSummarySerialization } from '../helpers/summary-serialization.js';
import { noCompactionProgress } from '../helpers/executing-llm-snapshot.js';

const roots: string[] = [];
it('binary contracts validate byte success and retain singular bounded JSON error responses', async () => {
  const root = mkdtempSync('/home/salva/g/ml/tmp/operator-binary-contract-');
  roots.push(root);
  initProjectTree(root);
  const server = Fastify({ logger: false });
  const contract = filesDebugOperatorApiContracts['files.image'];
  new ContractRuntime({
    authPolicy: new AuthPolicy(),
    eventLogger: createEventLog(root),
    fatalPort: testApplicationFatalPort,
  }).mount(
    server,
    { 'files.image': contract },
    {
      'files.image': ({ query, reply }) => {
        reply.header('Content-Type', 'image/png');
        return { body: query.path === 'valid' ? new Uint8Array([1, 2, 3]) : Buffer.alloc(0) };
      },
    },
  );
  try {
    const valid = await server.inject({ url: '/api/files/image?path=valid' });
    expect(valid.rawPayload).toEqual(Buffer.from([1, 2, 3]));
    const invalid = await server.inject({ url: '/api/files/image?path=invalid' });
    expect(invalid.statusCode).toBe(500);
    expect(invalid.headers['content-type']).toContain('application/json');
    expect(invalid.json()).toEqual({
      error: 'InternalServerError',
      message: 'Internal server error',
    });
  } finally {
    await server.close();
  }
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const headers = { authorization: 'Bearer synthetic-image-token' };
const png = (width = 5, height = 3, background = '#ff0000') =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();

function setup() {
  const root = mkdtempSync('/home/salva/g/ml/tmp/operator-image-read-');
  roots.push(root);
  initProjectTree(root);
  const cards = new CardService(root);
  const configAuthority = createTestConfigAuthority(root);
  const server = Fastify({ logger: false });
  new ContractRuntime({
    authPolicy: new AuthPolicy({ apiToken: 'synthetic-image-token' }),
    eventLogger: createEventLog(root),
    fatalPort: testApplicationFatalPort,
  }).mount(
    server,
    { ...agentOperatorApiContracts, ...filesDebugOperatorApiContracts },
    {
      ...buildAgentOperatorContractHandlers({
        projectRoot: root,
        workflows: TEST_RUNTIME_WORKFLOWS,
        captureExecutingLlmSnapshots: () => new Map(),
      }),
      ...buildFilesDebugOperatorContractHandlers({
        projectRoot: root,
        workflows: TEST_RUNTIME_WORKFLOWS,
        cardServiceProvider: () => cards,
        configAuthority,
      }),
    },
  );
  return { root, cards, server };
}

function record(
  root: string,
  session: ConversationSessionId,
  result: unknown,
  tool = 'mcp_tool_call',
  source = randomUUID(),
) {
  const timestamp = '2026-10-08T00:00:00.000Z';
  const content = JSON.stringify(result),
    policies = toolRowPolicies({ content });
  const base = {
    session_id: session,
    round_id: `r-assistant-${'0'.repeat(32)}`,
    message_index: 1,
    block_index: 0,
    timestamp,
  };
  const rows: AgentMessage[] = [
    {
      ...base,
      id: `${source}:activation`,
      role: 'system',
      kind: 'activity',
      context_policy: ACTIVITY_ROW_POLICY,
      content: JSON.stringify({
        event: 'activation_open',
        agent_name: session.split(':')[1],
        ...(session.endsWith(':global') ? {} : { card_id: 'project' }),
        input_id: source,
        timestamp,
      }),
    },
    {
      ...base,
      id: `${source}:tool-call:call`,
      role: 'assistant',
      kind: 'tool_call',
      context_policy: policies.call,
      tool,
      tool_call_id: 'call',
      content: JSON.stringify({
        role: 'assistant',
        tool_calls: [{ id: 'call', type: 'function', function: { name: tool, arguments: '{}' } }],
      }),
    },
    {
      ...base,
      id: `${source}:tool-result:call`,
      role: 'tool',
      kind: 'tool_result',
      context_policy: policies.result,
      tool,
      tool_call_id: 'call',
      content,
    },
  ];
  appendConversationBatch({ projectRoot: root }, rows);
  const segment = readCurrentConversationSegment(root, session)!;
  return {
    segment_version: segment.entry.version,
    segment_id: segment.entry.entry_id,
    message_id: rows[2]!.id,
  };
}

function imageUrl(
  session: ConversationSessionId,
  locator: ReturnType<typeof record>,
  image: ImageDescriptor,
  index = 0,
) {
  return `/api/agents/${encodeURIComponent(session)}/conversation/images?${new URLSearchParams({
    segment_version: String(locator.segment_version),
    segment_id: locator.segment_id,
    message_id: locator.message_id,
    content_index: String(index),
    image_id: image.id,
  })}`;
}

it.each(['agent:analyst:global', 'agent:planner:project'] as const)(
  'serves actual native MCP ordered multiple/repeated selections for %s, with exact auth and occurrence authority',
  async (session) => {
    const { root, server } = setup();
    const first = await png(),
      second = await png(4, 2, '#0000ff');
    const tool = mcpToolBinders
      .find((binder) => binder.name === 'mcp_tool_call')!
      .bind({
        projectRoot: root,
        mcpToolInvocation: {
          ...unusedMcpToolInvocation,
          invokeTool: async () => ({
            content: [
              { type: 'text', text: 'before' },
              { type: 'image', data: first.toString('base64'), mimeType: 'image/png' },
              { type: 'text', text: 'between' },
              { type: 'image', data: second.toString('base64'), mimeType: 'image/png' },
              { type: 'image', data: first.toString('base64'), mimeType: 'image/png' },
            ],
          }),
          getServerTools: () => undefined,
          findToolCapability: () => null,
        },
      });
    const execution = await tool.executor(
      { serverName: 'browser', toolName: 'browser_take_screenshot' },
      new AbortController().signal,
      testLlmToolInvocationContext({ sessionId: session, toolName: 'mcp_tool_call' }),
    );
    const result = settleToolActionOutcome(execution.providerOutcome).providerResult;
    if (
      !result.success ||
      !result.content ||
      result.content[1]?.type !== 'image' ||
      result.content[3]?.type !== 'image' ||
      result.content[4]?.type !== 'image'
    )
      throw new Error('Expected actual MCP images.');
    const a = result.content[1].image,
      b = result.content[3].image,
      repeatedNative = result.content[4].image;
    expect(repeatedNative.id).not.toBe(a.id);
    expect(repeatedNative.sha256).toBe(a.sha256);
    // Repeat the actual selected descriptor: authority is each occurrence, not a UUID catalog.
    result.content.push({ type: 'image', image: a });
    const locator = record(root, session, result);
    try {
      const url = imageUrl(session, locator, a, 1);
      expect((await server.inject({ url })).statusCode).toBe(401);
      expect((await server.inject({ url: `${url}&token=synthetic-image-token` })).statusCode).toBe(
        401,
      );
      expect(
        (await server.inject({ url: `${url}&token=synthetic-image-token`, headers })).statusCode,
      ).toBe(401);
      for (const suffix of ['&extra=1', '&content_index=1', '&source_session=agent:analyst:global'])
        expect((await server.inject({ url: `${url}${suffix}`, headers })).statusCode).toBe(400);
      for (const invalidUrl of [
        url.replace('segment_version=1', 'segment_version=0'),
        url.replace('content_index=1', 'content_index=-1'),
        url.replace(`image_id=${a.id}`, 'image_id=not-a-uuid'),
      ])
        expect((await server.inject({ url: invalidUrl, headers })).statusCode).toBe(400);
      for (const [index, image] of [
        [1, a],
        [3, b],
        [4, repeatedNative],
        [5, a],
      ] as const) {
        const response = await server.inject({
          url: imageUrl(session, locator, image, index),
          headers,
        });
        expect(response.statusCode).toBe(200);
        expect(response.rawPayload).toEqual(
          readFileSync(conversationImageFile(root, session, image.id)),
        );
        expect(response.headers).toMatchObject({
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
      }
      for (const [index, image] of [
        [0, a],
        [2, a],
        [1, b],
        [99, a],
      ] as const)
        expect(
          (await server.inject({ url: imageUrl(session, locator, image, index), headers }))
            .statusCode,
        ).toBe(404);
      expect(
        (
          await server.inject({
            url: imageUrl(session, { ...locator, segment_id: randomUUID() }, a, 1),
            headers,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await server.inject({
            url: imageUrl(session, { ...locator, message_id: 'forged' }, a, 1),
            headers,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await server.inject({
            url: imageUrl(session, { ...locator, segment_version: 88 }, a, 1),
            headers,
          })
        ).statusCode,
      ).toBe(404);
      const other =
        session === 'agent:analyst:global' ? 'agent:planner:project' : 'agent:analyst:global';
      const otherImage = publishConversationImage(root, other, first, { width: 5, height: 3 });
      expect(
        (await server.inject({ url: imageUrl(session, locator, otherImage, 1), headers }))
          .statusCode,
      ).toBe(404);
      // Only the requested descriptor is consumed, not its damaged neighbor.
      unlinkSync(conversationImageFile(root, session, b.id));
      expect((await server.inject({ url, headers })).statusCode).toBe(200);
      expect(
        (await server.inject({ url: imageUrl(session, locator, b, 3), headers })).statusCode,
      ).toBe(404);
      const absent = await server.inject({ url: imageUrl(session, locator, b, 3), headers });
      expect(absent.json().error).toBe('historical_version_content_unavailable');
      expect(absent.body).not.toContain(root);
    } finally {
      await server.close();
    }
  },
);

it('pins a historical selection across real compaction and current advancement, including retained tombstone scope', async () => {
  const { root, server, cards } = setup();
  const session = 'agent:planner:project';
  const bytes = await png();
  const image = publishConversationImage(root, session, bytes, { width: 5, height: 3 });
  const locator = record(root, session, { success: true, content: [{ type: 'image', image }] });
  // A later round makes the earlier image bundle eligible for coverage.
  record(root, session, { success: true, data: 'large ordinary result '.repeat(5000) });
  const preparedCompaction = prepareCompaction(
    {
      context_utilization_fraction: 0.8,
      trigger_fraction: 0.8,
      tail_fraction: 0,
      snap: 'compact_straddler',
    },
    'system',
    [],
    8000,
    2000,
  );
  const projection = providerConversationProjection(
    readCurrentConversationSegment(root, session)!.conversation,
    [],
  );
  const candidate = { provider: 'test', account: null, model: 'test' } as const;
  const compaction = await compact({
    strategy: 'local_exact_admission',
    conversations: { projectRoot: root },
    input: {
      inputId: randomUUID(),
      agentId: session,
      agentName: 'planner',
      sessionId: session,
      systemPrompt: 'system',
      providerConversation: projection,
      tools: [],
      compiledToolContracts: [],
      terminalToolNames: [],
      modelParams: { temperature: 0 },
      preparedCompaction,
      preparedContext: buildPreparedInvocationContext({
        instructionText: 'system',
        terminalToolNames: [],
        compiledTools: [],
        dynamicBlocks: [],
        preparedCompaction,
      }),
      capabilityRequest: {},
      routePass: { kind: 'ordinary', candidateChain: [candidate] },
      episodeContext: {},
    },
    summarizerProvider: {
      candidate,
      contextWindowTokens: 100000,
      maxOutputTokens: 10000,
      materializeImage: (source, descriptor) =>
        materializeConversationImage(root, source, descriptor),
      serializeSummaryRequest: deterministicSummarySerialization,
      completeTurn: async () => ({
        result: { kind: 'message', content: 'Covered image and prior text; no delivery proof.' },
        provider_exchanges: [],
      }),
      projectProviderExchanges: () => [],
    },
    signal: new AbortController().signal,
    progress: noCompactionProgress,
  });
  expect(compaction.kind).toBe('compacted');
  expect(readCurrentConversationSegment(root, session)!.entry.version).toBeGreaterThan(
    locator.segment_version,
  );
  try {
    expect(
      (await server.inject({ url: imageUrl(session, locator, image), headers })).rawPayload,
    ).toEqual(bytes);
    const current = readCurrentConversationSegment(root, session)!;
    expect(
      (
        await server.inject({
          url: imageUrl(session, { ...locator, segment_id: current.entry.entry_id }, image),
          headers,
        })
      ).statusCode,
    ).toBe(409);
    // Root card cannot be removed; a separately linked configured child can be tombstoned.
    const child = cards.create({
      type: 'code',
      parent: 'project',
      title: 'Retained image reader',
      bootstrap_content: 'Brief',
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
    });
    const childSession = `agent:executor:${child.id}` as ConversationSessionId;
    const childImage = publishConversationImage(root, childSession, bytes, { width: 5, height: 3 });
    const timestamp = '2026-10-08T00:00:00.000Z',
      source = randomUUID(),
      content = JSON.stringify({ success: true, content: [{ type: 'image', image: childImage }] });
    const policies = toolRowPolicies({ content });
    const base = {
      session_id: childSession,
      round_id: `r-assistant-${'0'.repeat(32)}`,
      message_index: 1,
      block_index: 0,
      timestamp,
    };
    appendConversationBatch({ projectRoot: root }, [
      {
        ...base,
        id: 'activation',
        role: 'system',
        kind: 'activity',
        context_policy: ACTIVITY_ROW_POLICY,
        content: JSON.stringify({
          event: 'activation_open',
          agent_name: 'executor',
          card_id: child.id,
          input_id: source,
          timestamp,
        }),
      },
      {
        ...base,
        id: `${source}:tool-call:c`,
        role: 'assistant',
        kind: 'tool_call',
        context_policy: policies.call,
        tool: 'mcp_tool_call',
        tool_call_id: 'c',
        content: JSON.stringify({
          role: 'assistant',
          tool_calls: [
            { id: 'c', type: 'function', function: { name: 'mcp_tool_call', arguments: '{}' } },
          ],
        }),
      },
      {
        ...base,
        id: `${source}:tool-result:c`,
        role: 'tool',
        kind: 'tool_result',
        context_policy: policies.result,
        tool: 'mcp_tool_call',
        tool_call_id: 'c',
        content,
      },
    ]);
    const childSegment = readCurrentConversationSegment(root, childSession)!;
    const childLocator = {
      segment_version: childSegment.entry.version,
      segment_id: childSegment.entry.entry_id,
      message_id: `${source}:tool-result:c`,
    };
    cards.deleteSubtrees([child.id], () => true);
    expect(
      (await server.inject({ url: imageUrl(childSession, childLocator, childImage), headers }))
        .rawPayload,
    ).toEqual(bytes);
  } finally {
    await server.close();
  }
});

it('uses actual view_image snapshot after mutable source replacement/deletion and refuses nested data, private replay and unselected images', async () => {
  const { root, server, cards } = setup();
  const session = 'agent:analyst:global';
  writeFileSync(join(root, 'source.png'), await png());
  const tool = globalWorkspaceObservationToolBinders
    .find((binder) => binder.name === 'view_image')!
    .bind({ projectRoot: root, agentName: 'analyst', store: cards });
  const execution = await tool.executor(
    { path: 'source.png' },
    new AbortController().signal,
    testLlmToolInvocationContext({ sessionId: session, toolName: 'view_image' }),
  );
  const result = settleToolActionOutcome(execution.providerOutcome).providerResult;
  if (!result.success || result.content?.[0]?.type !== 'image')
    throw new Error('Expected view_image selection.');
  const image = result.content[0].image,
    locator = record(root, session, result, 'view_image');
  const bytes = readFileSync(conversationImageFile(root, session, image.id));
  const url = imageUrl(session, locator, image);
  try {
    writeFileSync(join(root, 'source.png'), await png(10, 10, '#00ff00'));
    expect((await server.inject({ url, headers })).rawPayload).toEqual(bytes);
    unlinkSync(join(root, 'source.png'));
    expect((await server.inject({ url, headers })).rawPayload).toEqual(bytes);
    const unselected = publishConversationImage(root, session, bytes, {
      width: image.width,
      height: image.height,
    });
    expect(
      (await server.inject({ url: imageUrl(session, locator, unselected), headers })).statusCode,
    ).toBe(404);
    const dataOnly = record(root, session, {
      success: true,
      data: { image, nested: { image }, image_url: 'https://example.invalid/pixels' },
    });
    expect(
      (await server.inject({ url: imageUrl(session, dataOnly, image), headers })).statusCode,
    ).toBe(404);
    const source = randomUUID();
    appendConversationBatch(
      { projectRoot: root },
      responsesBundle(
        session,
        source,
        RESPONSES_A,
        JSON.stringify({ success: true, data: { image } }),
      ),
    );
    const privateLocator = { ...locator, message_id: `${source}:private` };
    expect(
      (await server.inject({ url: imageUrl(session, privateLocator, image), headers })).statusCode,
    ).toBe(404);
    expect(
      (await server.inject({ url: imageUrl('agent:unconfigured:global', locator, image), headers }))
        .statusCode,
    ).toBe(404);
  } finally {
    await server.close();
  }
});

it.each(['missing', 'length', 'hash', 'png', 'dimensions', 'segment'] as const)(
  'bounds corrupt selected %s errors without physical paths or alternate pixels',
  async (damage) => {
    const { root, server } = setup();
    const session = 'agent:planner:project';
    const bytes = damage === 'png' ? Buffer.from('invalid-png-confidential-canary') : await png();
    const image = publishConversationImage(root, session, bytes, {
      width: damage === 'dimensions' ? 6 : 5,
      height: 3,
    });
    const locator = record(root, session, { success: true, content: [{ type: 'image', image }] });
    const file = conversationImageFile(root, session, image.id);
    if (damage === 'missing') unlinkSync(file);
    if (damage === 'length') truncateSync(file, 5);
    if (damage === 'hash') {
      const changed = Buffer.from(bytes);
      changed[changed.length - 1] ^= 1;
      writeFileSync(file, changed);
    }
    if (damage === 'segment')
      writeFileSync(
        cardConversationVersionFile(
          root,
          'project',
          'planner',
          readCurrentConversationSegment(root, session)!.entry.filename,
        ),
        '{malformed complete}\n',
      );
    try {
      const response = await server.inject({ url: imageUrl(session, locator, image), headers });
      expect([404, 409, 503]).toContain(response.statusCode);
      expect(response.json().error).toBe('historical_version_content_unavailable');
      expect(response.body).not.toContain(root);
      expect(response.body).not.toContain('confidential-canary');
    } finally {
      await server.close();
    }
  },
);

it('Files detects extensionless/misnamed static PNG/JPEG/WebP and freshly reads bytes and dimensions, never trusts prior metadata', async () => {
  const { root, server } = setup();
  try {
    for (const [path, format] of [
      ['extensionless', 'png'],
      ['wrong.txt', 'jpeg'],
      ['wrong.jpg', 'webp'],
    ] as const) {
      const bytes = await sharp({
        create: { width: 8, height: 4, channels: 3, background: '#123456' },
      })
        [format]()
        .toBuffer();
      writeFileSync(join(root, path), bytes);
      const query = new URLSearchParams({ path });
      const metadata = await server.inject({ url: `/api/files/content?${query}`, headers });
      expect(metadata.statusCode).toBe(200);
      expect(metadata.json()).toMatchObject({
        contentType: `image/${format}`,
        image: { width: 8, height: 4 },
      });
      expect(metadata.json()).not.toHaveProperty('content');
      const response = await server.inject({ url: `/api/files/image?${query}`, headers });
      expect(response.rawPayload).toEqual(bytes);
      expect(response.headers).toMatchObject({
        'content-type': `image/${format}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
    }
    writeFileSync(join(root, 'extensionless'), await png(2, 7));
    expect(
      (
        await sharp(
          (await server.inject({ url: '/api/files/image?path=extensionless', headers })).rawPayload,
        ).metadata()
      ).height,
    ).toBe(7);
    writeFileSync(join(root, 'extensionless'), 'replaced with ordinary text');
    expect(
      (await server.inject({ url: '/api/files/image?path=extensionless', headers })).statusCode,
    ).toBe(415);
    expect(
      (await server.inject({ url: '/api/files/content?path=extensionless', headers })).json()
        .content,
    ).toBe('replaced with ordinary text');
    unlinkSync(join(root, 'extensionless'));
    expect(
      (await server.inject({ url: '/api/files/image?path=extensionless', headers })).statusCode,
    ).toBe(404);
    for (const path of ['plain.md', 'fake.png', 'data.json']) {
      const text = path === 'data.json' ? ' { "answer": 1.00 }\n' : '# Exact ordinary café text\n';
      writeFileSync(join(root, path), text);
      expect(
        (await server.inject({ url: `/api/files/content?path=${path}`, headers })).json().content,
      ).toBe(text);
      expect(
        (await server.inject({ url: `/api/files/image?path=${path}`, headers })).statusCode,
      ).toBe(415);
    }
    expect((await server.inject({ url: '/api/files/image?path=wrong.txt' })).statusCode).toBe(401);
  } finally {
    await server.close();
  }
});

it('Files refuses unsupported/corrupt/animated/oversized raster and confidential direct/alias paths with no raw canary output', async () => {
  const { root, server } = setup();
  const source = await png();
  try {
    const fixtures = new Map<string, Buffer>([
      ['truncated', source.subarray(0, 40)],
      ['vector.svg', Buffer.from('<svg width="10" height="10"></svg>')],
      [
        'animated',
        Buffer.concat([
          source.subarray(0, 8),
          Buffer.from([0, 0, 0, 8]),
          Buffer.from('acTL'),
          Buffer.alloc(12),
          source.subarray(8),
        ]),
      ],
      ['oversized', Buffer.alloc(32 * 1024 * 1024 + 1)],
      [
        'pixels',
        await sharp({ create: { width: 4000, height: 10001, channels: 3, background: '#123456' } })
          .png()
          .toBuffer(),
      ],
    ]);
    for (const [path, bytes] of fixtures) {
      writeFileSync(join(root, path), bytes);
      const result = await server.inject({ url: `/api/files/image?path=${path}`, headers });
      expect([413, 415]).toContain(result.statusCode);
      expect(result.body).not.toContain(root);
    }
    const paths = [
      '.env',
      '.saivage/auth-profiles.json',
      '.saivage/saivage.yaml',
      '.saivage/repair-attic/private',
      '.saivage/agents/conversations/analyst/images/private.png',
      '.saivage/cards/project/conversations/executor/images/private.png',
    ];
    for (const [index, path] of paths.entries()) {
      const physical = join(root, path);
      mkdirSync(dirname(physical), { recursive: true });
      writeFileSync(physical, source);
      const alias = `alias-${index}`;
      symlinkSync(path, join(root, alias));
      for (const request of [path, alias]) {
        const result = await server.inject({
          url: `/api/files/image?${new URLSearchParams({ path: request })}`,
          headers,
        });
        expect(result.statusCode).toBe(403);
        expect(result.rawPayload).not.toEqual(source);
        expect(result.body).not.toContain(root);
      }
    }
    writeFileSync(join(root, '.saivage/repair-attic-notes'), source);
    expect(
      (await server.inject({ url: '/api/files/image?path=.saivage%2Frepair-attic-notes', headers }))
        .rawPayload,
    ).toEqual(source);
    expect(
      (
        await server.inject({
          url: '/api/files/image?path=record%3A%2F%2F%2Fstatus.md%3Fcard%3Dproject',
          headers,
        })
      ).statusCode,
    ).toBe(415);
  } finally {
    await server.close();
  }
}, 30_000);
