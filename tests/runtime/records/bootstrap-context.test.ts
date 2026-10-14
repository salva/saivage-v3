import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CardService, initProjectTree } from '../../helpers/canonical-project.js';
import { bootstrapContextSupplier } from '../../../src/runtime/records/bootstrap-context.js';
import { appendConversationBatch, readConversation } from '../../../src/persistence/conversation-file.js';
import { agentMessageSchema } from '../../../src/schemas/index.js';

const roots: string[] = [];
const SESSION = 'agent:planner:project' as const;
afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-context-')); roots.push(root);
  initProjectTree(root);
  const store = new CardService(root);
  store.acceptRecord('project', 'brief.md', 'CURRENT ACCEPTED {{opaque}}\n"quoted body"', 'analyst');
  const card = store.read('project')!;
  const supplier = bootstrapContextSupplier(store, card, { nodeId: 'plan', recordPrompts: [] });
  const prepare = () => supplier({ inputId: randomUUID(), conversation: readConversation(root, SESSION) });
  return { root, store, card, supplier, prepare };
}

describe('owner-local current bootstrap preparation', () => {
  it('selects complete accepted body, identity and full exposure from exactly one owning read', () => {
    const f = fixture();
    f.store.openRecord('project', 'brief.md');
    f.store.editRecord('project', 'brief.md', 'UNACCEPTED DRAFT');
    const read = jest.spyOn(f.store, 'readRecordCurrent');
    const prepared = f.prepare();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('project', 'brief.md');
    expect(prepared.recordBlocks[0]!.content).toContain('CURRENT ACCEPTED {{opaque}}');
    expect(prepared.recordBlocks[0]!.content).not.toContain('UNACCEPTED DRAFT');
    expect(prepared.rows[0]!.record_observations![0]!.observed).toMatchObject({
      view: 'accepted', selection: { kind: 'accepted' }, exposure: { kind: 'full_body' },
    });
    expect(prepared.rows[0]!.content).toBe('');
    expect(prepared.recordBlocks[0]!.audience).toBe('primary_and_summarizer');
  });

  it('deduplicates exact selection/exposure from actual history across nodes, never the current full body', () => {
    const f = fixture();
    const first = f.prepare();
    appendConversationBatch({ projectRoot: f.root }, [...first.rows]);
    const read = jest.spyOn(f.store, 'readRecordCurrent');
    const second = bootstrapContextSupplier(f.store, f.card, { nodeId: 'different-node', recordPrompts: [] })({
      inputId: randomUUID(), conversation: readConversation(f.root, SESSION),
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(second.rows).toEqual([]);
    expect(second.recordBlocks).toEqual(first.recordBlocks);
    expect(readConversation(f.root, SESSION).effectiveRequiredModelFacts.latestRecordObservations[0]!.observation.source)
      .toEqual(first.rows[0]!.record_observations![0]!.source);
  });

  it('records full prepared exposure after metadata knowledge without copying a body into the descriptor', () => {
    const f = fixture();
    const first = f.prepare();
    const descriptor = first.rows[0]!;
    appendConversationBatch({ projectRoot: f.root }, [agentMessageSchema.parse({
      ...descriptor,
      record_observations: descriptor.record_observations!.map(observation => ({
        ...observation, observed: { ...observation.observed, exposure: { kind: 'metadata' } },
      })),
    })]);
    const second = f.prepare();
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.record_observations![0]!.observed.exposure).toEqual({ kind: 'full_body' });
    expect(second.rows[0]!.content).toBe('');
    appendConversationBatch({ projectRoot: f.root }, [...second.rows]);
    expect(f.prepare().rows).toEqual([]);
  });

  it.each(['missing', 'unaccepted'] as const)('fails strictly for %s required bootstrap without reusing an old body', (missing) => {
    const f = fixture();
    appendConversationBatch({ projectRoot: f.root }, [...f.prepare().rows]);
    const read = jest.spyOn(f.store, 'readRecordCurrent');
    if (missing === 'missing') read.mockReturnValue({ kind: 'found', value: { projection: null } } as never);
    else {
      read.mockRestore();
      const projection = f.store.readRecordCurrent('project', 'brief.md');
      if (projection.kind !== 'found' || !projection.value.projection) throw new Error('Missing fixture record.');
      jest.spyOn(f.store, 'readRecordCurrent').mockReturnValue({ ...projection, value: { ...projection.value, projection: { ...projection.value.projection, accepted: null } } });
    }
    expect(f.prepare).toThrow(missing === 'missing' ? /unavailable/ : /no accepted content/);
    expect(readConversation(f.root, SESSION).sourceRows.filter(row => row.kind === 'record_observation')).toHaveLength(1);
  });
});
