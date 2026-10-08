import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Ajv } from 'ajv';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardIdSchema } from '../../src/schemas/card-id.js';
import { cardInspectionToolBinders } from '../../src/tools/card-inspection-provider.js';
import { invokeToolForLlm, llmToolDefinition } from '../../src/tools/invocation.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const cases = [
  { name: 'get_card', field: 'id', method: 'listDeclaredRecordMetadata', args: { section: 'records', position: { item_index: 0, item_byte_offset: 0 }, response_bytes: 8000 } },
  { name: 'get_tree', field: 'rootId', method: 'readCardInspectionTree', args: {} },
  { name: 'list_cards', field: 'parent', method: 'listCardInspectionRows', args: {} },
] as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'saivage-card-id-admission-')); roots.push(root);
  initProjectTree(root);
  const cards = new CardService(root);
  const provider = bindToolProvider('card-inspection', cardInspectionToolBinders, { store: cards, cardTypeVocabulary: cards.workflows.cardTypeVocabulary });
  const surface = buildInvocationSurfaceFixture('analyst', [provider]);
  const invoke = (name: string, args: unknown) => invokeToolForLlm(surface, name, args, testLlmToolInvocationContext({ sessionId: 'agent:analyst:global', toolName: name }));
  return { root, cards, surface, invoke };
}

describe('current card-inspection ID admission', () => {
  it.each(cases)('$name rejects malformed and non-string IDs without store entry', async ({ name, field, args }) => {
    const { cards, invoke } = fixture();
    const reads = [
      jest.spyOn(cards, 'listDeclaredRecordMetadata'), jest.spyOn(cards, 'getCardDetail'),
      jest.spyOn(cards, 'getCardChildren'), jest.spyOn(cards, 'readCardInspectionTree'),
      jest.spyOn(cards, 'listCardInspectionRows'),
    ];
    for (const id of ['card-s6a7988d', 42]) {
      const settlement = await invoke(name, { ...args, [field]: id });
      expect(settlement.kind).toBe('rejected_before_execution');
      if (settlement.kind !== 'rejected_before_execution') throw new Error('Expected argument rejection.');
      expect(settleToolActionOutcome(settlement.providerOutcome).providerResult.success).toBe(false);
      for (const read of reads) expect(read).not.toHaveBeenCalled();
    }
  });

  it.each(cases)('$name admits root and hierarchical IDs, with executed not-found for absent cards', async ({ name, field, method, args }) => {
    const { cards, invoke } = fixture();
    const parent = cards.create({ type: 'goal', parent: 'project', title: 'Parent', bootstrap_content: 'Parent brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const child = cards.create({ type: 'code', parent: parent.id, title: 'Child', bootstrap_content: 'Child brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    expect(child.id).toBe('card-a-a');
    const read = jest.spyOn(cards, method);
    for (const id of ['project', child.id, 'card-a-b']) {
      read.mockClear();
      const settlement = await invoke(name, { ...args, [field]: id });
      expect(settlement.kind).toBe('executed');
      expect(read).toHaveBeenCalledTimes(1);
      if (settlement.kind !== 'executed') throw new Error('Expected executor entry.');
      const result = settleToolActionOutcome(settlement.execution.providerOutcome).providerResult;
      expect(result.success).toBe(id !== 'card-a-b');
      if (!result.success) expect(result.error).toContain('not found');
    }
  });

  it('keeps omitted parent as unrestricted discovery', async () => {
    const { cards, invoke } = fixture();
    const read = jest.spyOn(cards, 'listCardInspectionRows');
    const settlement = await invoke('list_cards', {});
    expect(settlement.kind).toBe('executed');
    expect(read).toHaveBeenCalledTimes(1);
    if (settlement.kind !== 'executed') throw new Error('Expected executor entry.');
    expect(settleToolActionOutcome(settlement.execution.providerOutcome).providerResult).toMatchObject({ success: true, data: { cards: { total: 1, items: [expect.objectContaining({ id: 'project' })] } } });
  });

  it.each(cases)('$name advertises the owning root-or-pattern grammar to the provider', ({ name, field, args }) => {
    const { surface } = fixture();
    const parameters = llmToolDefinition(surface.tools.get(name)!).function.parameters;
    const schema = parameters as { properties: Record<string, { anyOf: unknown[] }>; required?: string[] };
    expect(schema.properties[field]!.anyOf).toEqual([
      expect.objectContaining({ const: 'project' }),
      expect.objectContaining({ type: 'string', pattern: expect.any(String) }),
    ]);
    expect(schema.required?.includes(field) ?? false).toBe(field !== 'parent');
    const validate = new Ajv().compile(parameters);
    for (const id of ['project', 'card-a-b', 'card-s6a7988d', ' card-a', 'card-A', `card-${Array(13).fill('a').join('-')}`, 42]) {
      expect(validate({ ...args, [field]: id })).toBe(cardIdSchema.safeParse(id).success);
    }
    if (field === 'parent') expect(validate(args)).toBe(true);
  });

  it('propagates a complete malformed current head for a valid ID through invocation', async () => {
    const { root, invoke } = fixture();
    writeFileSync(join(root, '.saivage/cards/project/card-head.json'), '{}\n');
    await expect(invoke('get_card', { id: 'project', section: 'summary' })).rejects.toThrow();
  });
});
