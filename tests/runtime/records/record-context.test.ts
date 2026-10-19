import { agentExecution } from '../../helpers/workflow-execution.js';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CardService } from '../../../src/cards/card-service.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';
import {
  compileProjectWorkflows,
  type CompiledNodeContract,
} from '../../../src/runtime/card-process/card-process-config.js';
import { effectiveSaivageConfigSchema } from '../../../src/schemas/saivage-config.js';
import { bootstrapContextSupplier } from '../../../src/runtime/records/bootstrap-context.js';
import {
  appendConversationBatch,
  readConversation,
  readConversationCatalog,
  readHistoricalConversationSegment,
} from '../../../src/persistence/conversation-file.js';
import { cardConversationVersionFile, cardRecordHeadFile, cardRecordPreviousHeadFile, cardAcceptedRecordFile } from '../../../src/persistence/layout.js';
import { compilePromptTemplate, renderCompiledPrompt } from '../../../src/utils/prompt-api.js';
import {
  agentMessageSchema,
  canonicalJson,
  sha256Hex,
  type AgentMessage,
} from '../../../src/schemas/index.js';
import { workspaceToolBinders } from '../../../src/tools/workspace-provider.js';
import { buildSettledToolResult } from '../../../src/runtime/actors/llm-delivery-log.js';
import { OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE } from '../../../src/tools/invocation.js';
import { providerConversationProjection } from '../../../src/runtime/actors/conversation-session.js';
import { selectConversationProtection } from '../../../src/contracts/conversation-validation.js';
import { projectCompiledGraphs } from '../../../src/runtime/card-process/compiled-graphs-projection.js';
import { TEST_RUNTIME_WORKFLOWS } from '../../helpers/canonical-project.js';
import {
  foldConversation,
  foldHistoricalConversationRows,
} from '../../../src/application/read-models/agent-conversation-read-model.js';
import { projectCanonicalConversationRow } from '../../../src/application/read-models/canonical-conversation-outbound.js';
import { projectToolInvocation } from '../../../src/tools/tool-invocation-outbound.js';
import { redactTextForOutbound } from '../../../src/redaction/index.js';
import { publishThreeGenerationCompactedConversation } from '../../helpers/compacted-conversation-fixture.js';
import {
  globalObservationToolBinders,
  type GlobalObservationToolContext,
} from '../../../src/tools/global-observation-tools.js';
import { executingLlmSnapshots } from '../../helpers/executing-llm-snapshot.js';
import { prepareRecordPromptContent } from '../../../src/runtime/records/record-prompt-content.js';
import { NodeExecution as AgentNodeExecution } from '../../../src/runtime/actors/node-execution.js';
import { createPromptTemplateRegistry } from '../../../src/utils/prompt-api.js';
import { describeNodeResultContract } from '../../../src/runtime/card-process/card-process-config.js';

const roots: string[] = [];
const SESSION = 'agent:planner:project' as const;
type Input = NonNullable<
  typeof TEST_SAIVAGE_CONFIG.card_types.project.workflow.nodes.plan.record_prompts
>[number];
const input = (
  record: string,
  selection: Input['selection'],
  presence: Input['presence'] = 'optional',
  body = true,
): Input => ({
  record,
  selection,
  presence,
  prompt: { reference: body ? 'changed-record-with-body' : 'changed-record', compactable: true },
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(inputs: Input[]) {
  const root = mkdtempSync(join(tmpdir(), 'record-context-'));
  roots.push(root);
  initProjectTree(root);
  const config = structuredClone(TEST_SAIVAGE_CONFIG);
  for (const type of Object.values(config.card_types))
    for (const node of Object.values(type.workflow.nodes)) node.record_prompts = [];
  config.card_types.project!.workflow.nodes.plan!.record_prompts = inputs;
  config.card_types.project!.workflow.nodes.recover!.record_prompts = inputs;
  const workflows = compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config), {
    projectRoot: root,
  });
  const store = new CardService(root, workflows);
  store.acceptRecord(
    'project',
    'brief.md',
    'A {{recordSelection}} {{> missing}} "quoted"',
    { kind: 'agent', agent: 'analyst' },
  );
  const card = store.read('project')!;
  const node = (id = 'plan') =>
    workflows.cardTypes.get('project')!.states.get(`node:${id}`) as CompiledNodeContract;
  const prepare = (id = 'plan', session = SESSION as string) =>
    bootstrapContextSupplier(
      store,
      card,
      node(id),
    )({
      inputId: randomUUID(),
      conversation: readConversation(root, session as typeof SESSION),
    });
  const publish = (rows: readonly AgentMessage[]) =>
    appendConversationBatch({ projectRoot: root }, [...rows]);
  return { root, store, card, config, workflows, node, prepare, publish };
}
function prompts(rows: readonly AgentMessage[]) {
  return rows.filter((row) => row.kind === 'record_prompt');
}

it('composes shipped role, node and scaffold as observed data through edit and re-entry', () => {
  const f = fixture([input('status.md', 'effective')]);
  const owner = new AgentNodeExecution({ cardId: 'project', store: f.store } as never, {} as never) as unknown as { prepareRecordRequirements(node: CompiledNodeContract): void };
  owner.prepareRecordRequirements(f.node());
  const initial = f.prepare(); f.publish(initial.rows);
  expect(prompts(initial.rows)[0]!.record_observations![0]!.observed.selection).toMatchObject({ kind: 'baseline', version: 0 });
  const currentBaseline = f.store.readRecordCurrent('project', 'status.md');
  if (currentBaseline.kind !== 'found') throw new Error('Missing baseline');
  expect(prompts(initial.rows)[0]!.content).toContain(JSON.stringify(currentBaseline.value.projection!.baseline!.content));
  f.store.openRecord('project', 'status.md');
  f.store.editRecord('project', 'status.md', 'Current brief-relative assessment with unresolved evidence.');
  const changed = f.prepare(); f.publish(changed.rows);
  expect(prompts(changed.rows)[0]!.record_observations![0]!.observed.selection).toMatchObject({ kind: 'draft', version: 1, target_version: 1 });
  owner.prepareRecordRequirements(f.node('recover'));
  const reentry = f.prepare('recover');
  expect(prompts(reentry.rows)).toEqual([]); // Same observed work is not a new seeded cycle or repeated prompt.
  if (process.env.SAIVAGE_TEST_SHIPPED_RECORD_COMPOSITION) {
    const workflow = f.workflows.cardTypes.get('project')!;
    writeFileSync(process.env.SAIVAGE_TEST_SHIPPED_RECORD_COMPOSITION, JSON.stringify({
      kind: 'offline-shipped-render-and-real-supplier-not-provider-wire',
      role: createPromptTemplateRegistry(f.workflows).render({ kind: 'workflow-agent', cardType: 'project' }, agentExecution(f.node()).agent.name, { contractDescription: describeNodeResultContract(workflow, 'node:plan') }),
      node: workflow.processPrompts.get(agentExecution(f.node()).prompt.promptId)!.text,
      recoveryNode: workflow.processPrompts.get(agentExecution(f.node('recover')).prompt.promptId)!.text,
      initial, changed, reentry,
      latest: readConversation(f.root, SESSION).effectiveRequiredModelFacts.latestRecordObservations,
    }, null, 2));
  }
});

async function readIntoConversation(
  f: ReturnType<typeof fixture>,
  path: string,
  options: { metadata_only?: boolean; response_bytes?: number; position?: { kind: 'text'; byte_offset: number } } = {},
) {
  const id = randomUUID(),
    callId = randomUUID();
  const template = OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
    bytes = canonicalJson(template),
    hash = sha256Hex(bytes);
  const execution = await workspaceToolBinders
    .find((t) => t.name === 'read')!
    .bind({ projectRoot: f.root, store: f.store, agentName: 'planner', cardId: 'project' })
    .executor({ path, ...options }, new AbortController().signal);
  const call = agentMessageSchema.parse({
    id: `${id}:tool-call:${callId}`,
    session_id: SESSION,
    role: 'assistant',
    kind: 'tool_call',
    tool: 'read',
    tool_call_id: callId,
    content: JSON.stringify({
      role: 'assistant',
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ path, ...options }) },
        },
      ],
    }),
    context_policy: { kind: 'tool_call', template, template_bytes: bytes, template_sha256: hash },
    round_id: `r-assistant-${'1'.repeat(32)}`,
    message_index: 1,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
  const result = buildSettledToolResult({
    session_id: SESSION,
    source_input_id: id,
    tool_call_id: callId,
    tool_name: 'read',
    resultPolicy: {
      resultPolicyTemplate: template,
      resultPolicyTemplateBytes: bytes,
      resultPolicyTemplateSha256: hash,
    },
    settlement: { kind: 'executed', execution },
  }).message;
  f.publish([call, result]);
  return result;
}

describe('closed record-context compiler and same-read supplier', () => {
  it('keeps safe canonical spelling, placeholders, optional null and reference-only prompts useful', () => {
    const f = fixture([
      input('brief.md', 'accepted', 'required', false),
      input('status.md', 'effective'),
    ]);
    const absent = f.prepare();
    for (const row of prompts(absent.rows)) {
      expect(projectCanonicalConversationRow(row, projectToolInvocation).content).toBe(row.content);
    }
    const selection = prompts(absent.rows)[0]!.record_observations![0]!.observed.selection;
    if (selection.kind !== 'accepted') throw new Error('Expected accepted fixture.');
    expect(prompts(absent.rows)[0]!.content).toContain(selection.locator);
    expect(prompts(absent.rows)[0]!.content).not.toContain('A {{recordSelection}}');
    expect(prompts(absent.rows)[1]!.content).toContain(
      'Selected record data (JSON string, possibly a marked encoded display preview, or null): null',
    );
    f.publish(absent.rows);
    f.store.openRecord('project', 'status.md');
    for (const body of [
      String.raw`Notes\napi_key: ordinary-example`,
      'api_key: "${NAME} ${OTHER}"\nFINAL-SAFE-Z',
      '{"api_key":"${NAME} ${OTHER}"}',
      'Safe "quotes" \\ path {{recordSelection}} {{> never-expand}}\n\u0000\ud800\udfff\t\b\f\r\n😀',
    ]) {
      expect(redactTextForOutbound(body)).toBe(body);
      f.store.editRecord('project', 'status.md', body);
      const prepared = f.prepare();
      const row = prompts(prepared.rows)[0]!;
      expect(row.content).toContain(canonicalJson(body));
      expect(projectCanonicalConversationRow(row, projectToolInvocation).content).toBe(row.content);
      f.publish(prepared.rows);
    }
  });

  it.each([
    'Notes\n  api_key: "SYNTHETIC_CANARY"\r\nFINAL-SAFE-Z',
    '{"api_key"\t:\n"SYNTHETIC_CANARY\\\\path\\"quote"}\nFINAL-SAFE-Z',
    '\tghp_SYNTHETIC_CANARY\nFINAL-SAFE-Z',
    '\nsk-SYNTHETIC_CANARY.\nFINAL-SAFE-Z',
    '\nsk-SYNTHETIC_CANARY\b\nFINAL-SAFE-Z',
    '\nBearer\tSYNTHETIC_CANARY\nFINAL-SAFE-Z',
    String.raw`\"api_key\": \"SYNTHETIC_CANARY\"` + '\nFINAL-SAFE-Z',
    '\tapi_key="SYNTHETIC_CANARY"\nFINAL-SAFE-Z',
    'https://example.test/?api_key=SYNTHETIC_CANARY\nFINAL-SAFE-Z',
  ])('filters shipped supplier output without changing accepted/private bytes: %s', (body) => {
    expect(redactTextForOutbound(body)).not.toContain('SYNTHETIC_CANARY');
    const f = fixture([input('brief.md', 'accepted', 'required')]);
    f.store.acceptRecord('project', 'brief.md', body, { kind: 'agent', agent: 'analyst' });
    const prepared = f.prepare();
    const row = prompts(prepared.rows)[0]!;
    expect(row.content).toContain(canonicalJson(body));
    expect(prepared.recordBlocks[0]!.content).toContain(canonicalJson(body));
    const publicRow = projectCanonicalConversationRow(row, projectToolInvocation);
    expect(publicRow.content).not.toContain('SYNTHETIC_CANARY');
    expect(publicRow.content).toContain('FINAL-SAFE-Z');
    const encodedBody = publicRow.content
      .split('\n')[1]!
      .slice('Selected record data (JSON string, possibly a marked encoded display preview, or null): '.length);
    expect(JSON.parse(encodedBody)).toContain('FINAL-SAFE-Z');
    expect(publicRow.content).toContain('record:///brief.md?card=project&v=');
    f.publish(prepared.rows);
    expect(readConversation(f.root, SESSION).sourceRows.find((r) => r.id === row.id)).toEqual(row);
    expect(foldConversation(f.root, SESSION).entries.find((r) => r.id === row.id)).toEqual(
      publicRow,
    );
  });

  it.each([
    ['R3', '{{recordContent}}', `${'a'.repeat(40000)}\napi_key: Q9vX2mR7p\n${'b'.repeat(8181)}`],
    ['R5', '{{recordContent}}', `${'a'.repeat(40000)}"api_key: Q9vX2mR7p\n${'b'.repeat(8181)}`],
    ['R6', '{"api_key": {{recordContent}}}', `${'a'.repeat(40000)}"Q9vX2mR7p${'b'.repeat(8181)}`],
    ['R7', 'api_key={{recordContent}}', `${'a'.repeat(40000)}Q9vX2mR7p${'b'.repeat(8181)}`],
  ])('keeps %s confidential through real supplier, model text and public projection', async (regression, host, body) => {
    const declaration = input('status.md', 'effective');
    declaration.prompt.compactable = false;
    const f = fixture([declaration]);
    f.store.openRecord('project', 'status.md');
    f.store.editRecord('project', 'status.md', body);
    const node = f.node();
    const original = node.recordPrompts[0]!;
    const compiled = compilePromptTemplate({
      host: { kind: 'record-context', cardType: 'project' },
      name: original.prompt.promptId,
      path: 'offline-C06.md',
      text: `Record selection: {{recordSelection}}\nPayload: ${host}`,
      resolveFragment: () => { throw new Error('No fragments.'); },
    });
    const custom = { ...node, recordPrompts: [{ ...original, artifact: { ...original.artifact, compiled } }] };
    const read = jest.spyOn(f.store, 'readRecordCurrent');
    const prepared = bootstrapContextSupplier(f.store, f.card, custom)({
      inputId: randomUUID(), conversation: readConversation(f.root, SESSION),
    });
    expect(read).toHaveBeenCalledTimes(2); // one union read each for brief and status
    const row = prompts(prepared.rows)[0]!;
    expect(row.record_observations![0]!.observed).toMatchObject({
      selection: { kind: 'draft' }, exposure: { kind: 'excerpt' },
    });
    const substitution = prepareRecordPromptContent(body, 'record:///status.md?card=project');
    expect(row.content.endsWith(host.replace('{{recordContent}}', substitution))).toBe(true);
    expect(JSON.parse(substitution)).toContain('Oversized record preview:');
    if (regression === 'R6') expect(JSON.parse(row.content.split('Payload: ')[1]!).api_key)
      .toBe(JSON.parse(substitution));
    const intact = { ...row, content: renderCompiledPrompt(
      { kind: 'record-context', cardType: 'project' }, original.prompt.promptId, compiled,
      { cardType: 'project', recordSelection: '{}', recordContent: canonicalJson(body) },
    ) };
    const projected = projectCanonicalConversationRow(row, projectToolInvocation);
    expect(projectCanonicalConversationRow(intact, projectToolInvocation).content).not.toContain('Q9vX2mR7p');
    expect(projected.content).not.toContain('Q9vX2mR7p');
    if (regression === 'R7') expect(projected.content.split('Payload: ')[1]).toBe('api_key=[REDACTED]');
    f.publish(prepared.rows);
    const conversation = readConversation(f.root, SESSION);
    expect(conversation.sourceRows.find(r => r.id === row.id)!.content).toBe(row.content);
    expect(providerConversationProjection(conversation, prepared.recordBlocks).messages.some(message =>
      typeof message.content === 'string' && message.content.includes('Oversized record preview:'))).toBe(true);
    read.mockClear();
    expect(foldConversation(f.root, SESSION).entries.find(r => r.id === row.id)).toEqual(projected);
    if (regression === 'R3') {
      await publishThreeGenerationCompactedConversation(f.root);
      const history = readHistoricalConversationSegment(f.root, SESSION, 1);
      expect(foldHistoricalConversationRows(history.rows).find(r => r.id === row.id)).toEqual(projected);
      const current = foldConversation(f.root, SESSION);
      if (current.segmentContext?.kind !== 'compacted') throw new Error('Expected compaction.');
      expect(current.segmentContext.protected_prompts.find(entry => entry.message.id === row.id)!.message).toEqual(projected);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('shortens a custom body-bearing brief without changing the separate complete bootstrap or source', () => {
    const f = fixture([input('brief.md', 'accepted', 'required')]);
    const body = `START${'a'.repeat(40000)}OMITTED REQUIREMENT${'b'.repeat(40000)}END`;
    f.store.acceptRecord('project', 'brief.md', body, { kind: 'agent', agent: 'analyst' });
    const before = f.store.readRecordCurrent('project', 'brief.md');
    const read = jest.spyOn(f.store, 'readRecordCurrent');
    const first = f.prepare();
    expect(read).toHaveBeenCalledTimes(1);
    const row = prompts(first.rows)[0]!;
    expect(row.content).toContain('Oversized record preview:');
    expect(row.content).not.toContain('OMITTED REQUIREMENT');
    expect(row.record_observations![0]!.observed.exposure).toEqual({ kind: 'excerpt' });
    expect(first.recordBlocks[0]!.content).toContain(canonicalJson(body));
    expect(first.rows.at(-1)!.record_observations![0]!.observed.exposure).toEqual({ kind: 'full_body' });
    f.publish(first.rows);
    expect(f.prepare().rows).toEqual([]);
    expect(f.store.readRecordCurrent('project', 'brief.md')).toEqual(before);
  });

  it('leaves exact selected record files unchanged and reads latest B through the preview pointer with ordinary bounded middle pages', async () => {
    const f = fixture([input('status.md', 'effective')]);
    const a = `A-START${'a'.repeat(40000)}A-OMITTED-REQUIREMENT${'a'.repeat(40000)}A-END`;
    const predecessor = f.store.acceptRecord('project', 'status.md', 'Prior accepted status', { kind: 'agent', agent: 'planner' });
    const accepted = f.store.acceptRecord('project', 'status.md', a, { kind: 'agent', agent: 'planner' });
    const selectedFiles = [
      cardRecordHeadFile(f.root, 'project', { filename: 'status.md' }),
      cardRecordPreviousHeadFile(f.root, 'project', { filename: 'status.md' }),
      cardAcceptedRecordFile(f.root, 'project', accepted.accepted!.source_entry_id),
      cardAcceptedRecordFile(f.root, 'project', predecessor.accepted!.source_entry_id),
    ];
    const before = selectedFiles.map(path => readFileSync(path));
    const prepared = f.prepare();
    const row = prompts(prepared.rows)[0]!;
    const pointer = 'record:///status.md?card=project';
    expect(row.content).toContain(`Read the current record: ${pointer}.`);
    expect(row.content).not.toContain('A-OMITTED-REQUIREMENT');
    f.publish(prepared.rows);
    expect(selectedFiles.map(path => readFileSync(path))).toEqual(before);

    const b = `B-START${'b'.repeat(40000)}B-OMITTED-REQUIREMENT${'b'.repeat(40000)}B-END`;
    f.store.openRecord('project', 'status.md');
    f.store.editRecord('project', 'status.md', b);
    const latest = await readIntoConversation(f, pointer);
    const result = JSON.parse(latest.content);
    expect(result.success).toBe(true);
    expect(Buffer.byteLength(latest.content)).toBeLessThanOrEqual(32768);
    expect(result.data.content.content).toContain('B-START');
    expect(result.data.content.content).not.toContain('A-START');
    expect(result.data.content.next_offset_bytes).toBeLessThan(Buffer.byteLength(b));
    expect(latest.record_observations![0]!.observed).toMatchObject({
      selection: { kind: 'draft' }, exposure: { kind: 'slice', offset_bytes: 0 },
    });
    const offset = b.indexOf('B-OMITTED-REQUIREMENT');
    const middle = await readIntoConversation(f, pointer, {
      response_bytes: 1200, position: { kind: 'text', byte_offset: offset },
    });
    const publicMiddle = projectCanonicalConversationRow(middle, projectToolInvocation);
    const data = JSON.parse(publicMiddle.content).data;
    expect(data.content.content.startsWith('B-OMITTED-REQUIREMENT')).toBe(true);
    expect(data.content.offset_bytes).toBe(offset);
    expect(Buffer.byteLength(publicMiddle.content)).toBeLessThanOrEqual(1200);
    expect(publicMiddle.content).not.toContain('Oversized record preview:');
    const historical = await readIntoConversation(f, `${pointer}&v=${accepted.accepted!.source_version}`);
    expect(JSON.parse(historical.content).data.content.content).toContain('A-START');
    expect(historical.record_observations![0]!.observed.selection_kind).toBe('historical');
    expect(readFileSync(selectedFiles[2]!)).toEqual(before[2]);
  });

  it('keeps excerpt exposure when redaction alone fits, then fires only for a changed oversized selection', () => {
    const f = fixture([input('status.md', 'effective')]);
    f.store.openRecord('project', 'status.md');
    f.store.editRecord('project', 'status.md', `api_key=${'x'.repeat(40000)}\nEND-A`);
    const first = f.prepare();
    const row = prompts(first.rows)[0]!;
    expect(row.record_prompt!.reason).toBe('initial');
    expect(row.record_observations![0]!.observed.exposure).toEqual({ kind: 'excerpt' });
    expect(row.content).toContain('No further middle elision was needed.');
    expect(row.content).toContain('END-A');
    f.publish(first.rows);
    expect(prompts(f.prepare().rows)).toEqual([]);
    f.store.editRecord('project', 'status.md', `api_key=${'x'.repeat(40000)}\nEND-B`);
    const changed = prompts(f.prepare().rows)[0]!;
    expect(changed.record_prompt!.reason).toBe('changed');
    expect(changed.record_observations![0]!.observed.exposure).toEqual({ kind: 'excerpt' });
    expect(changed.content).toContain('END-B');
    expect(changed.content).not.toContain('END-A');
  });

  it.each([0, 1, 2, 3, 'unmatched-quote'] as const)(
    'keeps compiler literal adjacency %s opaque and confidential for initial/changed draft bodies',
    (adjacency) => {
      const f = fixture([input('status.md', 'effective')]);
      const body = `${adjacency === 'unmatched-quote' ? '' : 'Notes\n'}api_key: SYNTHETIC_CANARY\nSafe "quote" \\ path \\n {{recordSelection}} {{> never-expand}}\nFINAL-SAFE-Z`;
      const text = `Selection: {{recordSelection}}\nData: ${adjacency === 'unmatched-quote' ? '"label\\' : '\\'.repeat(adjacency)}{{recordContent}}`;
      const node = f.node();
      const declaration = node.recordPrompts[0]!;
      const compiled = compilePromptTemplate({
        host: { kind: 'record-context', cardType: 'project' },
        name: declaration.prompt.promptId,
        path: 'test-only.md',
        text,
        resolveFragment: () => {
          throw new Error('No fragments.');
        },
      });
      const customNode = {
        ...node,
        recordPrompts: [{ ...declaration, artifact: { ...declaration.artifact, compiled } }],
      };
      const prepare = () =>
        bootstrapContextSupplier(
          f.store,
          f.card,
          customNode,
        )({ inputId: randomUUID(), conversation: readConversation(f.root, SESSION) });
      expect(
        projectCanonicalConversationRow(prompts(prepare().rows)[0]!, projectToolInvocation).content,
      ).toContain('null');
      f.store.openRecord('project', 'status.md');
      f.store.editRecord('project', 'status.md', body);
      for (const reason of ['initial', 'changed']) {
        const prepared = prepare();
        const row = prompts(prepared.rows)[0]!;
        expect(row.record_prompt!.reason).toBe(reason);
        const original = structuredClone(prepared);
        const projected = projectCanonicalConversationRow(row, projectToolInvocation);
        expect(projected.content).not.toContain('SYNTHETIC_CANARY');
        expect(projected.content).toContain('FINAL-SAFE-Z');
        expect(projected.content).toContain('{{recordSelection}} {{> never-expand}}');
        const prefix = text.slice(text.indexOf('Data: '), text.indexOf('{{recordContent}}'));
        const quoted = projected.content.slice(projected.content.indexOf(prefix) + prefix.length);
        expect(JSON.parse(quoted)).toContain('FINAL-SAFE-Z');
        expect(
          row.content.endsWith(canonicalJson(reason === 'initial' ? body : `${body}\nchanged`)),
        ).toBe(true);
        expect(prepared).toEqual(original);
        f.publish(prepared.rows);
        if (reason === 'initial') f.store.editRecord('project', 'status.md', `${body}\nchanged`);
      }
    },
  );

  it('projects supplier evidence identically in current, indexed history, protected genesis and session-tail reads', async () => {
    const declaration = input('brief.md', 'accepted', 'required');
    declaration.prompt.compactable = false;
    const f = fixture([declaration]);
    const body =
      'Notes\napi_key: SYNTHETIC_CANARY\n{{recordSelection}} {{> never-expand}}\nFINAL-SAFE-Z';
    f.store.acceptRecord('project', 'brief.md', body, { kind: 'agent', agent: 'analyst' });
    const prepared = f.prepare();
    const row = prompts(prepared.rows)[0]!;
    const before = structuredClone(row);
    f.publish(prepared.rows);
    const safe = projectCanonicalConversationRow(row, projectToolInvocation);
    const binder = globalObservationToolBinders.find((tool) => tool.name === 'read_agent_session')!;
    const bound = binder.bind({
      projectRoot: f.root,
      store: f.store,
      captureExecutingLlmSnapshots: () => executingLlmSnapshots([SESSION]),
    } as unknown as GlobalObservationToolContext);
    const tail = await bound.executor(
      bound.inputSchema.parse({ session_id: SESSION, section: 'messages', last_n: 10 }),
      new AbortController().signal,
    );
    expect(JSON.stringify(tail)).not.toContain('SYNTHETIC_CANARY');
    expect(JSON.stringify(tail)).toContain('FINAL-SAFE-Z');
    await publishThreeGenerationCompactedConversation(f.root);
    const history = readHistoricalConversationSegment(f.root, SESSION, 1);
    expect(foldHistoricalConversationRows(history.rows).find((r) => r.id === row.id)).toEqual(safe);
    expect(history.rows.find((r) => r.id === row.id)).toEqual(before);
    const current = foldConversation(f.root, SESSION);
    if (current.segmentContext?.kind !== 'compacted')
      throw new Error('Expected compacted fixture.');
    const retained = current.segmentContext.protected_prompts.find(
      (entry) => entry.message.id === row.id,
    )!;
    expect(retained.message).toEqual(safe);
    expect(retained.source.segment_version).toBe(1);
    expect(retained.source.row_index).toBe(history.rows.findIndex((r) => r.id === row.id));
    expect(retained.message.record_observations![0]!.observed.selection).toMatchObject({
      kind: 'accepted',
      locator: expect.stringContaining('record:///brief.md?card=project&v='),
    });
    expect(retained.message.record_observations![0]!.observed.selection).not.toHaveProperty(
      'content_sha256',
    );
    expect(row).toEqual(before);
  });

  it('reads the union once per record; compares both views before the batch; substitutes opaque same-read bodies', () => {
    const f = fixture([input('brief.md', 'accepted', 'required'), input('brief.md', 'effective')]);
    f.store.openRecord('project', 'brief.md');
    f.store.editRecord('project', 'brief.md', 'D {{> never-expand}}');
    const read = jest.spyOn(f.store, 'readRecordCurrent');
    const prepared = f.prepare();
    expect(read).toHaveBeenCalledTimes(1);
    expect(prompts(prepared.rows).map((row) => row.record_observations![0]!.observed.view)).toEqual(
      ['accepted', 'effective'],
    );
    expect(prompts(prepared.rows).map((row) => row.record_prompt!.reason)).toEqual([
      'initial',
      'initial',
    ]);
    expect(prompts(prepared.rows)[0]!.content).toContain(
      JSON.stringify('A {{recordSelection}} {{> missing}} "quoted"'),
    );
    expect(prompts(prepared.rows)[1]!.content).toContain(JSON.stringify('D {{> never-expand}}'));
    expect(prepared.rows.at(-1)!.kind).toBe('record_observation');
    f.publish(prepared.rows);
    const catalog = readConversationCatalog(f.root, SESSION);
    const filename = catalog.versions.find(
      (entry) => entry.version === catalog.currentVersion,
    )!.filename;
    const physical = readFileSync(
      cardConversationVersionFile(f.root, 'project', 'planner', filename),
      'utf8',
    )
      .trimEnd()
      .split('\n');
    const envelope = JSON.parse(physical.at(-1)!);
    expect(envelope).toMatchObject({ version: 12, type: 'conversation-segment' });
    expect(envelope.rows[0].kind).toBe('ordinary_segment_genesis');
    expect(envelope.rows.slice(1)).toEqual(prepared.rows);
    expect(f.prepare().rows).toEqual([]);
    expect(prompts(f.prepare('recover').rows)).toEqual([]);
    expect(prompts(f.prepare('plan', 'agent:reviewer:project').rows)).toHaveLength(2);
    f.store.closeRecord('project', 'brief.md', 'analyst');
    const changed = f.store.acceptRecord(
      'project',
      'brief.md',
      'A {{recordSelection}} {{> missing}} "quoted"',
      { kind: 'agent', agent: 'analyst' },
    );
    read.mockClear();
    const next = f.prepare();
    expect(read).toHaveBeenCalledTimes(1);
    expect(prompts(next.rows).map((row) => row.record_prompt!.reason)).toEqual([
      'changed',
      'changed',
    ]);
    expect(next.recordBlocks[0]!.content).toContain(changed.accepted!.source_entry_id);
  });

  it('handles optional absent/empty and required missing strictly, then observes draft publication', () => {
    const f = fixture([input('status.md', 'effective')]);
    const read = jest.spyOn(f.store, 'readRecordCurrent');
    const first = f.prepare();
    expect(read.mock.calls).toEqual([
      ['project', 'brief.md'],
      ['project', 'status.md'],
    ]);
    expect(prompts(first.rows)[0]!.content).toContain('null');
    expect(prompts(first.rows)[0]!.record_observations![0]!.observed.selection.kind).toBe('absent');
    f.publish(first.rows);
    f.store.openRecord('project', 'status.md');
    f.store.editRecord('project', 'status.md', 'Now a draft');
    expect(prompts(f.prepare().rows)[0]!.record_prompt!.reason).toBe('changed');
    const missing = fixture([input('status.md', 'accepted', 'required')]);
    expect(() => missing.prepare()).toThrow(/Required accepted/);
    expect(readConversation(missing.root, SESSION).sourceRows).toEqual([]);
  });

  it('records exact head provenance without firing on a head-only accepted-view change', () => {
    const f = fixture([input('brief.md', 'accepted', 'required', false)]);
    const first = f.prepare();
    f.publish(first.rows);
    f.store.openRecord('project', 'brief.md');
    const next = f.prepare();
    expect(prompts(next.rows)).toEqual([]);
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0]!.record_observations![0]!.observed.selection).toEqual(
      first.rows.at(-1)!.record_observations![0]!.observed.selection,
    );
    expect(next.rows[0]!.record_observations![0]!.observed.head).not.toEqual(
      first.rows.at(-1)!.record_observations![0]!.observed.head,
    );
  });

  it.each(['metadata', 'slice'] as const)(
    'uses actual %s B knowledge to suppress prompts, even after historical A; upgrades bootstrap exposure only',
    async (kind) => {
      const f = fixture([input('brief.md', 'accepted', 'required', false)]);
      const a = f.prepare();
      f.publish(a.rows);
      const aVersion = a.rows.at(-1)!.record_observations![0]!.observed.selection;
      if (aVersion.kind !== 'accepted') throw new Error('Expected accepted fixture.');
      f.store.acceptRecord('project', 'brief.md', 'B'.repeat(6000), { kind: 'agent', agent: 'analyst' });
      const result = await readIntoConversation(
        f,
        'record:///brief.md?card=project',
        kind === 'metadata' ? { metadata_only: true } : { response_bytes: 1200 },
      );
      expect(
        result.record_observations!.find((o) => o.observed.view === 'accepted')!.observed.exposure
          .kind,
      ).toBe(kind);
      await readIntoConversation(f, `record:///brief.md?card=project&v=${aVersion.version}`);
      const read = jest.spyOn(f.store, 'readRecordCurrent');
      const b = f.prepare();
      expect(read).toHaveBeenCalledTimes(1);
      expect(prompts(b.rows)).toEqual([]);
      expect(b.rows).toHaveLength(1);
      expect(b.rows[0]!.record_observations![0]!.observed.exposure.kind).toBe('full_body');
      expect(b.recordBlocks[0]!.content).toContain('B'.repeat(6000));
      const projected = providerConversationProjection(
        readConversation(f.root, SESSION),
        b.recordBlocks,
      );
      const facts = projected.messages.find(
        (message) =>
          'block_identity' in message && message.block_identity === 'latest-record-observations',
      )!;
      expect(facts.content).toContain(result.id);
      expect(facts.content).not.toContain('B'.repeat(6000));
      expect(facts.content).not.toContain(a.rows[0]!.content);
    },
  );

  it('keeps declaration policy independent of factual supersession and projects tokens, not record bodies', () => {
    const inputs = [
      input('brief.md', 'accepted', 'required', false),
      input('status.md', 'effective'),
    ];
    inputs[0]!.prompt = {
      reference: 'changed-record',
      compactable: false,
      compaction_key: 'brief',
    };
    inputs[1]!.prompt = { reference: 'changed-record-with-body', compactable: false };
    const f = fixture(inputs);
    const a = f.prepare();
    f.publish(a.rows);
    f.store.acceptRecord('project', 'brief.md', 'new B', { kind: 'agent', agent: 'analyst' });
    f.store.openRecord('project', 'status.md');
    f.store.editRecord('project', 'status.md', 'status B');
    const b = f.prepare();
    f.publish(b.rows);
    const source = readConversation(f.root, SESSION);
    const protection = selectConversationProtection({
      inherited: [],
      rows: source.sourceRows,
      sourceVersion: 1,
      cutoffCount: source.sourceRows.length,
    });
    expect(protection.protectedPrompts.map((entry) => entry.message.id)).toEqual([
      prompts(a.rows)[1]!.id,
      ...prompts(b.rows).map((row) => row.id),
    ]);
    const graph = projectCompiledGraphs({
      ...TEST_RUNTIME_WORKFLOWS,
      cardTypes: f.workflows.cardTypes,
    });
    const declared = graph.graphs
      .find((g) => g.card_type === 'project')!
      .nodes.find((n) => n.node_id === 'plan')!.record_prompts;
    expect(declared[1]!.placeholders).toEqual(['recordSelection', 'recordContent']);
    expect(JSON.stringify(declared)).not.toContain('status B');
  });

  it('rejects foreign, duplicate and missing template declarations; enforces placeholders after fragments and preserves override closure', () => {
    const f = fixture([]);
    const plan = f.config.card_types.project!.workflow.nodes.plan!;
    for (const declarations of [
      [input('foreign.md', 'accepted')],
      [input('brief.md', 'accepted'), input('brief.md', 'accepted')],
    ]) {
      plan.record_prompts = declarations;
      expect(() => compileProjectWorkflows(f.config)).toThrow(/unknown record|duplicates/);
    }
    plan.record_prompts = [
      {
        ...input('brief.md', 'accepted'),
        prompt: { reference: 'missing-record-prompt', compactable: true },
      },
    ];
    expect(() => compileProjectWorkflows(f.config)).toThrow(/missing-record-prompt/);
    const compile = (text: string) =>
      compilePromptTemplate({
        host: { kind: 'record-context', cardType: 'project' },
        name: 'x',
        path: 'x.md',
        text,
        resolveFragment: () => ({ path: 'fragment.md', text: '{{recordSelection}}' }),
      });
    expect(() => compile('{{cardType}}')).toThrow(/found 0/);
    expect(() => compile('{{> fragment}} {{recordSelection}}')).toThrow(/found 2/);
    expect(() => compile('{{recordSelection}} {{recordContent}} {{recordContent}}')).toThrow(
      /found 2/,
    );
    expect(() => compile('{{recordSelection}} {{cardId}}')).toThrow(/inapplicable/);
    const dir = join(f.root, '.saivage/config/prompts/process/project');
    mkdirSync(dir, { recursive: true });
    const fragments = join(f.root, '.saivage/config/prompts/fragments/project');
    mkdirSync(fragments, { recursive: true });
    writeFileSync(join(dir, 'changed-record.md'), '{{cardType}} {{> selected}}');
    writeFileSync(join(fragments, 'selected.md'), '{{recordSelection}}');
    plan.record_prompts = [input('brief.md', 'accepted', 'required', false)];
    const workflows = compileProjectWorkflows(f.config, { projectRoot: f.root });
    const node = workflows.cardTypes
      .get('project')!
      .states.get('node:plan') as CompiledNodeContract;
    expect(node.recordPrompts[0]!.artifact.source).toBe('override-card');
    expect(
      node.recordPrompts[0]!.artifact.compiled.tokens.filter((t) => t.kind === 'placeholder').map(
        (t) => t.key,
      ),
    ).toEqual(['cardType', 'recordSelection']);
  });
});
