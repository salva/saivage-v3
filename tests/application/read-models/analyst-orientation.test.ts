import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';

import { canonicalJson } from '../../../src/schemas/index.js';
import {
  AnalystOrientationPreparationError,
  ANALYST_ORIENTATION_MAX_BYTES,
  ANALYST_ORIENTATION_OMISSION_MARKER,
  ANALYST_ORIENTATION_TITLE_PREVIEW_BYTES,
  buildAnalystOrientationSnapshot,
  type AnalystOrientationCard,
  type AnalystOrientationRuntime,
} from '../../../src/application/read-models/analyst-orientation.js';

const stopped: AnalystOrientationRuntime = { status: 'stopped', currentCardId: null };
const errorStatus: AnalystOrientationRuntime = { status: 'error', currentCardId: null };

let cardCounter = 0;
function card(input: Partial<AnalystOrientationCard> & Pick<AnalystOrientationCard, 'id' | 'parent' | 'children'>): AnalystOrientationCard {
  cardCounter += 1;
  return {
    type: 'goal',
    status: 'backlog',
    title: `Title ${cardCounter}`,
    version_seq: 1,
    ...input,
  };
}

function projectCard(children: readonly string[], status: AnalystOrientationCard['status'] = 'backlog'): AnalystOrientationCard {
  return card({ id: 'project', parent: null, type: 'project', status, title: 'Project', children, version_seq: 3 });
}

type SnapshotNode = {
  id: string;
  status: string;
  type: string;
  title: string;
  title_bytes: number;
  title_truncated: boolean;
  children_count: number;
  descendants: number;
  contains_running: boolean;
  children?: SnapshotNode[];
  omitted_children?: number;
  omitted_status_counts?: Record<string, number>;
  omitted_type_counts?: Record<string, number>;
  omission_marker?: string;
};

function parse(content: string): { runtime: { status: string; current_card: string | null }; active_path: string[]; full_observation_sha256: string; root: SnapshotNode } {
  return JSON.parse(content) as never;
}

function flatten(node: SnapshotNode): SnapshotNode[] {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

describe('buildAnalystOrientationSnapshot', () => {
  it('emits the stable key, bounded content, and both hashes over one stopped project', () => {
    const child = card({ id: 'card-a', parent: 'project', children: [] });
    const snapshot = buildAnalystOrientationSnapshot([projectCard(['card-a']), child], stopped);
    expect(Buffer.byteLength(snapshot.content, 'utf8')).toBeLessThanOrEqual(ANALYST_ORIENTATION_MAX_BYTES);
    const parsed = parse(snapshot.content);
    expect(parsed.runtime).toEqual({ status: 'stopped', current_card: null });
    expect(parsed.active_path).toEqual([]);
    expect(parsed.full_observation_sha256).toBe(snapshot.fullObservationSha256);
    expect(parsed.root.children?.map((node) => node.id)).toEqual(['card-a']);
    expect(snapshot.contentSha256).toBe(createHash('sha256').update(snapshot.content, 'utf8').digest('hex'));
  });

  it('renders the exact active path and expands only running branches at multiple depths', () => {
    const cards: AnalystOrientationCard[] = [
      projectCard(['card-a', 'card-z'], 'running'),
      card({ id: 'card-a', parent: 'project', children: ['card-a-b'], status: 'running' }),
      card({ id: 'card-a-b', parent: 'card-a', children: [], status: 'running' }),
      card({ id: 'card-z', parent: 'project', children: ['card-z-x'] }),
      card({ id: 'card-z-x', parent: 'card-z', children: [] }),
    ];
    const snapshot = buildAnalystOrientationSnapshot(cards, { status: 'running', currentCardId: 'card-a-b' });
    const parsed = parse(snapshot.content);
    expect(parsed.active_path).toEqual(['project', 'card-a', 'card-a-b']);
    expect(parsed.runtime).toEqual({ status: 'running', current_card: 'card-a-b' });
    const ids = flatten(parsed.root).map((node) => node.id);
    expect(ids).toContain('card-a-b');
    expect(ids).toContain('card-z');
    expect(ids).not.toContain('card-z-x');
    const runningLeaf = flatten(parsed.root).find((node) => node.id === 'card-a-b')!;
    expect(runningLeaf.contains_running).toBe(true);
    const collapsed = flatten(parsed.root).find((node) => node.id === 'card-z')!;
    expect(collapsed.children).toBeUndefined();
    expect(collapsed.descendants).toBe(1);
    expect(collapsed.contains_running).toBe(false);
  });

  it('fails preparation when the runtime current card disagrees with the strict running chain', () => {
    const cards: AnalystOrientationCard[] = [
      projectCard(['card-a'], 'running'),
      card({ id: 'card-a', parent: 'project', children: [], status: 'running' }),
    ];
    expect(() => buildAnalystOrientationSnapshot(cards, { status: 'running', currentCardId: 'card-b' })).toThrow(AnalystOrientationPreparationError);
    expect(() => buildAnalystOrientationSnapshot(cards, { status: 'running', currentCardId: 'card-a' })).not.toThrow();
    const dormant = [projectCard(['card-a'], 'backlog'), card({ id: 'card-a', parent: 'project', children: [], status: 'backlog' })];
    expect(() => buildAnalystOrientationSnapshot(dormant, { status: 'running', currentCardId: 'card-a' })).toThrow(/disagrees/u);
  });

  it('renders a stopped-mid-run project as inactive with an empty active path and exact status', () => {
    const cards: AnalystOrientationCard[] = [
      projectCard(['card-a'], 'running'),
      card({ id: 'card-a', parent: 'project', children: [], status: 'running' }),
    ];
    const snapshot = buildAnalystOrientationSnapshot(cards, { status: 'paused', currentCardId: null });
    const parsed = parse(snapshot.content);
    expect(parsed.active_path).toEqual([]);
    expect(parsed.runtime).toEqual({ status: 'paused', current_card: null });
    expect(flatten(parsed.root).map((node) => node.id)).toEqual(['project', 'card-a']);
  });

  it('omits wide non-running siblings behind deterministic aggregates and the literal marker', () => {
    const children = Array.from({ length: 400 }, (_, index) => `card-${'w'.repeat(index + 1)}`);
    const cards: AnalystOrientationCard[] = [projectCard(children)];
    for (const [index, id] of children.entries()) {
      cards.push(card({ id, parent: 'project', children: [], status: index % 3 === 0 ? 'done' : 'backlog', type: index % 2 === 0 ? 'goal' : 'code', title: `Sibling ${index} with a reasonably long descriptive title ${index}` }));
    }
    const snapshot = buildAnalystOrientationSnapshot(cards, stopped);
    expect(Buffer.byteLength(snapshot.content, 'utf8')).toBeLessThanOrEqual(ANALYST_ORIENTATION_MAX_BYTES);
    const parsed = parse(snapshot.content);
    const shown = parsed.root.children?.length ?? 0;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(children.length);
    expect(parsed.root.omitted_children).toBe(children.length - shown);
    expect(parsed.root.omission_marker).toBe(ANALYST_ORIENTATION_OMISSION_MARKER);
    const expectedStatusCounts: Record<string, number> = {};
    const expectedTypeCounts: Record<string, number> = {};
    for (const [index, id] of children.entries()) {
      if (parsed.root.children!.some((node) => node.id === id)) continue;
      const status = index % 3 === 0 ? 'done' : 'backlog';
      const type = index % 2 === 0 ? 'goal' : 'code';
      expectedStatusCounts[status] = (expectedStatusCounts[status] ?? 0) + 1;
      expectedTypeCounts[type] = (expectedTypeCounts[type] ?? 0) + 1;
    }
    expect(parsed.root.omitted_status_counts).toEqual(expectedStatusCounts);
    expect(parsed.root.omitted_type_counts).toEqual(expectedTypeCounts);
    expect(Object.keys(parsed.root.omitted_status_counts!)).toEqual([...Object.keys(parsed.root.omitted_status_counts!)].sort());
  });

  it('keeps shown siblings in canonical child order', () => {
    const children = ['card-b', 'card-a', 'card-c'];
    const cards: AnalystOrientationCard[] = [
      projectCard(children),
      card({ id: 'card-b', parent: 'project', children: [] }),
      card({ id: 'card-a', parent: 'project', children: [] }),
      card({ id: 'card-c', parent: 'project', children: [] }),
    ];
    const snapshot = buildAnalystOrientationSnapshot(cards, stopped);
    expect(parse(snapshot.content).root.children?.map((node) => node.id)).toEqual(['card-b', 'card-a', 'card-c']);
  });

  it('clips multi-byte titles on UTF-8 boundaries with exact byte metadata', () => {
    const emojiTitle = 'tré'.repeat(600);
    const cards: AnalystOrientationCard[] = [
      projectCard(['card-a']),
      card({ id: 'card-a', parent: 'project', children: [], title: emojiTitle }),
    ];
    const snapshot = buildAnalystOrientationSnapshot(cards, stopped);
    const shown = parse(snapshot.content).root.children![0]!;
    expect(shown.title_truncated).toBe(true);
    expect(shown.title_bytes).toBe(ANALYST_ORIENTATION_TITLE_PREVIEW_BYTES);
    expect(Buffer.byteLength(shown.title, 'utf8')).toBe(ANALYST_ORIENTATION_TITLE_PREVIEW_BYTES);
    expect(shown.title.endsWith('tré')).toBe(true);
  });

  it('changes fullObservationSha256 for an omitted card version change while visible bytes stay bounded', () => {
    const children = Array.from({ length: 300 }, (_, index) => `card-${'v'.repeat(index + 1)}`);
    const build = (versionBump: number): readonly AnalystOrientationCard[] => {
      const cards: AnalystOrientationCard[] = [projectCard(children)];
      for (const [index, id] of children.entries()) {
        cards.push(card({ id, parent: 'project', children: [], title: `Omittable sibling ${index}`, version_seq: index === 299 ? 1 + versionBump : 1 }));
      }
      return cards;
    };
    const before = buildAnalystOrientationSnapshot(build(0), stopped);
    const after = buildAnalystOrientationSnapshot(build(1), stopped);
    expect(Buffer.byteLength(before.content, 'utf8')).toBeLessThanOrEqual(ANALYST_ORIENTATION_MAX_BYTES);
    expect(Buffer.byteLength(after.content, 'utf8')).toBeLessThanOrEqual(ANALYST_ORIENTATION_MAX_BYTES);
    expect(parse(before.content).root.children!.some((node) => node.id === 'card-' + 'v'.repeat(300))).toBe(false);
    expect(before.fullObservationSha256).not.toBe(after.fullObservationSha256);
  });

  it('commits the observation over the complete ordered projection plus runtime identity', () => {
    const cards: AnalystOrientationCard[] = [projectCard(['card-a']), card({ id: 'card-a', parent: 'project', children: [], version_seq: 7 })];
    const snapshot = buildAnalystOrientationSnapshot(cards, stopped);
    const observation = { cards: [{ card_id: 'project', version_seq: 3 }, { card_id: 'card-a', version_seq: 7 }], runtime: { status: 'stopped', current_card_id: null } };
    const expected = createHash('sha256').update(canonicalJson(observation), 'utf8').digest('hex');
    expect(snapshot.fullObservationSha256).toBe(expected);
  });

  it('bounds a deep thousand-card graph and fails preparation when even the mandatory skeleton cannot fit', () => {
    const deep: AnalystOrientationCard[] = [];
    const width = 40;
    const depth = 12;
    const rootChildren: string[] = [];
    for (let branch = 0; branch < width; branch += 1) {
      let parent = 'project';
      const branchId = `card-${'d'.repeat(branch + 1)}`;
      rootChildren.push(branchId);
      for (let level = 0; level < depth - 1; level += 1) {
        const currentId = `${branchId}${'-d'.repeat(level + 1)}`;
        deep.push(card({ id: currentId, parent, children: level === depth - 2 ? [] : [`${branchId}${'-d'.repeat(level + 2)}`], title: `Deep node ${branch}-${level} with padding text to stress the byte budget` }));
        parent = currentId;
      }
    }
    const cards: AnalystOrientationCard[] = [projectCard(rootChildren), ...deep];
    const snapshot = buildAnalystOrientationSnapshot(cards, stopped);
    expect(Buffer.byteLength(snapshot.content, 'utf8')).toBeLessThanOrEqual(ANALYST_ORIENTATION_MAX_BYTES);

    const hugeTitles = [projectCard(['card-huge']), card({ id: 'card-huge', parent: 'project', children: [], title: `Å`.repeat(ANALYST_ORIENTATION_MAX_BYTES * 2) })];
    expect(() => buildAnalystOrientationSnapshot(hugeTitles, stopped)).not.toThrow();

    const chain: AnalystOrientationCard[] = [projectCard(['card-c0'], 'running')];
    for (let level = 0; level < 400; level += 1) {
      chain.push(card({ id: `card-c${level}`, parent: level === 0 ? 'project' : `card-c${level - 1}`, children: level === 399 ? [] : [`card-c${level + 1}`], status: 'running', title: `Mandatory running chain node ${level} with a long-enough title to overflow the fixed orientation budget quickly` }));
    }
    expect(() => buildAnalystOrientationSnapshot(chain, { status: 'running', currentCardId: 'card-c399' })).toThrow(/mandatory root\/active-path skeleton/u);
  });

  it('fits the maximal structural running chain with schema-maximum type names inside the budget', () => {
    const maxTypeName = 't'.repeat(64);
    const chainIds: string[] = [];
    for (let level = 0; level < 12; level += 1) {
      chainIds.push(level === 0 ? 'card-seg' : `${chainIds[level - 1]!}-seg`);
    }
    const cards: AnalystOrientationCard[] = [projectCard([chainIds[0]!], 'running')];
    for (const [level, id] of chainIds.entries()) {
      cards.push(card({
        id,
        parent: level === 0 ? 'project' : chainIds[level - 1]!,
        children: level === 11 ? [] : [chainIds[level + 1]!],
        status: 'running',
        type: maxTypeName,
        title: 'T'.repeat(600),
      }));
    }
    const snapshot = buildAnalystOrientationSnapshot(cards, { status: 'running', currentCardId: chainIds[11]! });
    expect(Buffer.byteLength(snapshot.content, 'utf8')).toBeLessThanOrEqual(ANALYST_ORIENTATION_MAX_BYTES);
    const parsed = parse(snapshot.content);
    expect(parsed.active_path).toEqual(['project', ...chainIds]);
    const nodes = flatten(parsed.root);
    expect(nodes).toHaveLength(13);
    expect(nodes.map((node) => node.id)).toEqual(['project', ...chainIds]);
    const chainNodes = nodes.filter((node) => node.id !== 'project');
    for (const node of chainNodes) {
      expect(node.title_bytes).toBe(ANALYST_ORIENTATION_TITLE_PREVIEW_BYTES);
      expect(node.title_truncated).toBe(true);
    }
    const tail = nodes.find((node) => node.id === chainIds[11]!)!;
    expect(tail).toMatchObject({ id: chainIds[11]!, type: maxTypeName, status: 'running', children_count: 0, descendants: 0, contains_running: true });
  });

  it('degrades oversized non-running siblings around the maximal chain behind aggregates and the marker', () => {
    const chainIds: string[] = [];
    for (let level = 0; level < 12; level += 1) {
      chainIds.push(level === 0 ? 'card-seg' : `${chainIds[level - 1]!}-seg`);
    }
    const siblings = Array.from({ length: 400 }, (_, index) => `card-${'w'.repeat(index + 1)}`);
    const cards: AnalystOrientationCard[] = [projectCard([chainIds[0]!, ...siblings], 'running')];
    for (const [level, id] of chainIds.entries()) {
      cards.push(card({
        id,
        parent: level === 0 ? 'project' : chainIds[level - 1]!,
        children: level === 11 ? [] : [chainIds[level + 1]!],
        status: 'running',
        title: 'Mandatory chain node with a long title that exceeds the preview budget by a wide margin',
      }));
    }
    for (const [index, id] of siblings.entries()) {
      cards.push(card({ id, parent: 'project', children: [], status: index % 3 === 0 ? 'done' : 'backlog', type: index % 2 === 0 ? 'goal' : 'code', title: `Sibling ${index} with a reasonably long descriptive title ${index}` }));
    }
    const snapshot = buildAnalystOrientationSnapshot(cards, { status: 'running', currentCardId: chainIds[11]! });
    expect(Buffer.byteLength(snapshot.content, 'utf8')).toBeLessThanOrEqual(ANALYST_ORIENTATION_MAX_BYTES);
    const parsed = parse(snapshot.content);
    expect(parsed.active_path).toEqual(['project', ...chainIds]);
    const ids = flatten(parsed.root).map((node) => node.id);
    for (const chainId of ['project', ...chainIds]) expect(ids).toContain(chainId);
    const rootChildren = parsed.root.children!.map((node) => node.id);
    expect(rootChildren[0]).toBe(chainIds[0]!);
    const shownSiblings = rootChildren.slice(1);
    expect(shownSiblings.length).toBeGreaterThan(0);
    expect(shownSiblings.length).toBeLessThan(siblings.length);
    expect(shownSiblings).toEqual(siblings.slice(0, shownSiblings.length));
    expect(parsed.root.omitted_children).toBe(siblings.length - shownSiblings.length);
    expect(parsed.root.omission_marker).toBe(ANALYST_ORIENTATION_OMISSION_MARKER);
    const expectedStatusCounts: Record<string, number> = {};
    const expectedTypeCounts: Record<string, number> = {};
    for (const [index, id] of siblings.entries()) {
      if (shownSiblings.includes(id)) continue;
      const status = index % 3 === 0 ? 'done' : 'backlog';
      const type = index % 2 === 0 ? 'goal' : 'code';
      expectedStatusCounts[status] = (expectedStatusCounts[status] ?? 0) + 1;
      expectedTypeCounts[type] = (expectedTypeCounts[type] ?? 0) + 1;
    }
    expect(parsed.root.omitted_status_counts).toEqual(expectedStatusCounts);
    expect(parsed.root.omitted_type_counts).toEqual(expectedTypeCounts);
  });

  it('exposes only the strict two-argument builder surface callers cannot inject hashes through', () => {
    expect(buildAnalystOrientationSnapshot).toHaveLength(2);
    expect(parse(buildAnalystOrientationSnapshot([projectCard([])], errorStatus).content).runtime.status).toBe('error');
    expect(buildAnalystOrientationSnapshot([projectCard([])], errorStatus).content).toContain('"snapshot":"analyst.project_tree"');
  });
});
