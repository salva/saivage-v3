import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.unstable_mockModule('node:dns/promises', () => ({
  lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

const { CardStore } = await import('../../src/cards/card-store.js');
const { buildInvocationSurface, invokeTool } = await import('../../src/tools/invocation.js');
const { createWebProvider } = await import('../../src/tools/web-tools.js');
const { initProjectTree } = await import('../../src/persistence/file-tree.js');
const { initRuntimeState, updateRuntimeState } = await import('../../src/runtime/state.js');
const { materializeProjectCard } = await import('../helpers/materialize-project-card.js');
const { readRecordSlotIndex } = await import('../../src/runtime/records/record-slots.js');

function mockFetch(text = 'fetched body'): jest.SpiedFunction<typeof fetch> {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(text, { status: 200, headers: { 'content-type': 'text/plain' } }));
}

describe('webfetch save_as scoped URLs', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saivage-web-save-as-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('writes executor project:// save_as through canonical workspace write', async () => {
    mockFetch('project body');
    const surface = buildInvocationSurface('executor', [createWebProvider({ projectRoot: root, cardId: 'card-1', agentRole: 'executor' })]);

    const result = await invokeTool(surface, 'webfetch', { url: 'https://example.com/page.txt', save_as: 'project:///docs/page.txt' });

    expect(result.success).toBe(true);
    expect(readFileSync(join(root, 'docs', 'page.txt'), 'utf8')).toBe('project body');
    if (result.success) expect(result.data).toMatchObject({ saved_as: 'docs/page.txt' });
  });

  it('denies planner project:// save_as before network fetch', async () => {
    const fetchSpy = mockFetch();
    const surface = buildInvocationSurface('planner', [createWebProvider({ projectRoot: root, cardId: 'card-1', agentRole: 'planner' })]);

    const result = await invokeTool(surface, 'webfetch', { url: 'https://example.com/page.txt', save_as: 'project:///docs/page.txt' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('planner cannot write project files');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows planner record://status.md save_as for the current card', async () => {
    mockFetch('planner status');
    const surface = buildInvocationSurface('planner', [createWebProvider({ projectRoot: root, cardId: 'card-1', agentRole: 'planner' })]);

    const result = await invokeTool(surface, 'webfetch', { url: 'https://example.com/status.txt', save_as: 'record:///status.md?v=next' });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ saved_as: 'record:///status.md?card=card-1&v=1' });
    expect(readFileSync(join(root, '.saivage', 'outputs', 'cards', 'card-1', 'status', '1.md'), 'utf8')).toBe('planner status');
  });

  it('denies planner record://review.md save_as through record-slot policy before network fetch', async () => {
    const fetchSpy = mockFetch();
    const surface = buildInvocationSurface('planner', [createWebProvider({ projectRoot: root, cardId: 'card-1', agentRole: 'planner' })]);

    const result = await invokeTool(surface, 'webfetch', { url: 'https://example.com/review.txt', save_as: 'record:///review.md?v=next' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("planner cannot write record slot 'review'");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows reviewer record://review.md save_as', async () => {
    mockFetch('review text');
    const surface = buildInvocationSurface('reviewer', [createWebProvider({ projectRoot: root, cardId: 'card-1', agentRole: 'reviewer' })]);

    const result = await invokeTool(surface, 'webfetch', { url: 'https://example.com/review.txt', save_as: 'record:///review.md?v=next' });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ saved_as: 'record:///review.md?card=card-1&v=1' });
    expect(readFileSync(join(root, '.saivage', 'outputs', 'cards', 'card-1', 'review', '1.md'), 'utf8')).toBe('review text');
  });

  it('restricts tmp:// save_as writes to the current card before network fetch', async () => {
    const fetchSpy = mockFetch();
    const surface = buildInvocationSurface('executor', [createWebProvider({ projectRoot: root, cardId: 'card-1', agentRole: 'executor' })]);

    const result = await invokeTool(surface, 'webfetch', { url: 'https://example.com/tmp.txt', save_as: 'tmp:///card-2/fetched.txt' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Agents may write tmp files only for their current card');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows analyst explicit record://brief.md save_as when runtime is paused', async () => {
    initProjectTree(root);
    materializeProjectCard(root);
    initRuntimeState(root);
    updateRuntimeState(root, { status: 'paused' });
    const store = new CardStore(root);
    const card = store.create({
      type: 'goal',
      parent: 'project',
      title: 'Goal',
      brief: 'old',
      status: 'backlog',
      depth: 1,
      tags: [],
      priority: 1,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
      related: [],
      retries: 0,
    });
    store.repairTerminalLifecycle(card.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-01-01T00:00:00.000Z' } });
    mockFetch('# Goal\n\nFetched.\n\n# Instructions\n\nUse it.\n\n# Acceptance Criteria\n\nDone.\n');
    const notifyCard = jest.fn(() => ({ ok: true as const }));
    const surface = buildInvocationSurface('analyst', [createWebProvider({ projectRoot: root, agentRole: 'analyst', store, notifyCard })]);

    const result = await invokeTool(surface, 'webfetch', { url: 'https://example.com/brief.md', save_as: `record:///brief.md?card=${card.id}&v=next` });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ saved_as: `record:///brief.md?card=${card.id}&v=2` });
    expect(notifyCard).toHaveBeenCalledWith(card.id, expect.objectContaining({ reason: 'card_changed' }));
  });

  it('allows analyst record://brief.md save_as to backlog cards without notifying the target', async () => {
    initProjectTree(root);
    materializeProjectCard(root);
    initRuntimeState(root);
    updateRuntimeState(root, { status: 'paused' });
    const store = new CardStore(root);
    const parent = store.create({
      type: 'goal',
      parent: 'project',
      title: 'Parent',
      brief: 'parent',
      status: 'backlog',
      depth: 1,
      tags: [],
      priority: 1,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
      related: [],
      retries: 0,
    });
    const card = store.create({
      type: 'code',
      parent: parent.id,
      title: 'Backlog child',
      brief: 'old',
      status: 'backlog',
      depth: 2,
      tags: [],
      priority: 1,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
      related: [],
      retries: 0,
    });
    store.setStatus('project', 'running');
    store.repairTerminalLifecycle(parent.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-01-01T00:00:00.000Z' } });
    const fetchedBrief = '# Goal\n\nFetched backlog.\n\n# Instructions\n\nUse it.\n\n# Acceptance Criteria\n\nDone.\n';
    mockFetch(fetchedBrief);
    const notifyCard = jest.fn(() => ({ ok: true as const }));
    const surface = buildInvocationSurface('analyst', [createWebProvider({ projectRoot: root, agentRole: 'analyst', store, notifyCard })]);

    const result = await invokeTool(surface, 'webfetch', { url: 'https://example.com/brief.md', save_as: `record:///brief.md?card=${card.id}&v=next` });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ saved_as: `record:///brief.md?card=${card.id}&v=2` });
    expect(readFileSync(join(root, '.saivage', 'outputs', 'cards', card.id, 'brief', '2.md'), 'utf8')).toBe(fetchedBrief);
    expect(store.read(card.id)?.status).toBe('backlog');
    expect(store.read(parent.id)?.status).toBe('changed');
    expect(store.read('project')?.status).toBe('running');
    expect((notifyCard.mock.calls as unknown as Array<[string, unknown]>).map((call) => call[0])).toEqual([parent.id, 'project']);
  });

  it('denies analyst record://brief.md save_as to unsupported statuses before fetch or slot open', async () => {
    initProjectTree(root);
    materializeProjectCard(root);
    initRuntimeState(root);
    updateRuntimeState(root, { status: 'paused' });
    const store = new CardStore(root);
    const card = store.create({
      type: 'goal',
      parent: 'project',
      title: 'Changed target',
      brief: 'old',
      status: 'backlog',
      depth: 1,
      tags: [],
      priority: 1,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
      related: [],
      retries: 0,
    });
    store.setStatus(card.id, 'running');
    store.setStatus(card.id, 'changed');
    const latestBefore = readRecordSlotIndex(root, card.id, 'brief').latest;
    const fetchSpy = mockFetch('# Goal\n\nFetched.\n\n# Instructions\n\nUse it.\n\n# Acceptance Criteria\n\nDone.\n');
    const surface = buildInvocationSurface('analyst', [createWebProvider({ projectRoot: root, agentRole: 'analyst', store, notifyCard: () => ({ ok: true }) })]);

    const result = await invokeTool(surface, 'webfetch', { url: 'https://example.com/brief.md', save_as: `record:///brief.md?card=${card.id}&v=next` });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('status backlog, done, failed, or running');
    expect(fetchSpy).not.toHaveBeenCalled();
    const index = readRecordSlotIndex(root, card.id, 'brief');
    expect(index.latest).toBe(latestBefore);
    expect(index.open).toBeNull();
  });
});
