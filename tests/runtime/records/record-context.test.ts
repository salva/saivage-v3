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
} from '../../../src/persistence/conversation-file.js';
import { cardConversationVersionFile } from '../../../src/persistence/layout.js';
import { compilePromptTemplate } from '../../../src/utils/prompt-api.js';
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
    'analyst',
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

async function readIntoConversation(
  f: ReturnType<typeof fixture>,
  path: string,
  options: { metadata_only?: boolean; response_bytes?: number } = {},
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
    expect(envelope).toMatchObject({ version: 9, type: 'conversation-segment' });
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
      'analyst',
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
      f.store.acceptRecord('project', 'brief.md', 'B'.repeat(6000), 'analyst');
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
    f.store.acceptRecord('project', 'brief.md', 'new B', 'analyst');
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
