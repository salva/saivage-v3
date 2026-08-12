import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { cardVersionIndexSchema } from '../../src/persistence/canonical-card-artifacts.js';
import { cardVersionFile, cardVersionIndexFile } from '../../src/persistence/layout.js';
import { buildContentPolicyReadModel } from '../../src/application/read-models/content-policy-read-model.js';
import { CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY } from '../../src/schemas/index.js';
import { recoverCurrentCardHead } from '../../src/persistence/card-files.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-')); roots.push(root); initProjectTree(root);
  return { root, cards: new CardService(root) };
}

function index(root: string, cardId: string) {
  return cardVersionIndexSchema.parse(JSON.parse(readFileSync(cardVersionIndexFile(root, cardId), 'utf8')));
}

describe('card version files', () => {
  it('publishes immutable N+UUID artifacts and a cumulative authoritative index', () => {
    const { root, cards } = fixture();
    const child = cards.create({ type: 'code', parent: 'project', title: 'before', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.editCard(child.id, { title: 'after' }, 'planner');

    const catalog = index(root, child.id);
    expect(catalog.versions.map(({ version }) => version)).toEqual([1, 2]);
    expect(catalog.current_version).toBe(2);
    expect(catalog.current_filename).toBe(catalog.versions[1]!.filename);
    expect(catalog.versions.every(({ filename, version }) => filename.startsWith(`${version}-`) && filename.endsWith('.json'))).toBe(true);
    expect(cards.read(child.id)?.title).toBe('after');
  });

  it('lists metadata without opening historical content and returns a typed local selected failure', () => {
    const { root, cards } = fixture();
    const child = cards.create({ type: 'code', parent: 'project', title: 'before', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.editCard(child.id, { title: 'after' }, 'planner');
    const catalog = index(root, child.id);
    unlinkSync(cardVersionFile(root, child.id, catalog.versions[0]!.filename));

    const reads: string[] = [];
    expect(cards.listCardVersions(child.id, { onRead: (path) => reads.push(path) })).toMatchObject({ kind: 'found', value: [{ version: 1 }, { version: 2 }] });
    expect(reads).not.toContain(cardVersionFile(root, child.id, catalog.versions[1]!.filename));
    expect(cards.readCardVersion(child.id, 1)).toEqual({ kind: 'historical-unavailable', version: 1, reason: 'missing' });
    expect(cards.read(child.id)?.title).toBe('after');
  });

  it('publishes deletion as the final indexed version and keeps the parent link', () => {
    const { root, cards } = fixture();
    const child = cards.create({ type: 'code', parent: 'project', title: 'delete', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.deleteSubtrees([child.id], () => true, 'analyst');
    const catalog = index(root, child.id);
    expect(catalog.versions.map(({ artifact_kind }) => artifact_kind)).toEqual(['card-version', 'card-tombstone']);
    expect(cards.read(child.id)).toBeNull();
    expect(cards.read('project')?.children).toContain(child.id);
    expect(cards.readCardVersion(child.id, 2)).toMatchObject({ kind: 'found', value: { kind: 'card-tombstone', prior_card_version: 1 } });
  });

  it('derives content-policy history from index metadata without opening old card versions', () => {
    const { root, cards } = fixture();
    const child = cards.create({ type: 'code', parent: 'project', title: 'blocked', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.setStatus(child.id, 'running');
    const settledAt = '2026-08-12T00:00:00.000Z';
    cards.commitActivationOutcome(child.id, { status: 'blocked', summary: CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY, result: { kind: 'content-policy-refusal', summary: CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY, session_id: `agent:executor:${child.id}`, marker_id: 'marker', evidence_url: '/evidence' } }, settledAt);
    const catalog = index(root, child.id);
    unlinkSync(cardVersionFile(root, child.id, catalog.versions[0]!.filename));
    unlinkSync(cardVersionFile(root, child.id, catalog.versions[1]!.filename));
    const reads: string[] = [];
    expect(buildContentPolicyReadModel(root, { onRead: (path) => reads.push(path) })).toMatchObject({ refusal_high_water: 1, latest: { card_id: child.id, blocked_at: settledAt } });
    expect(reads).not.toContain(cardVersionFile(root, child.id, catalog.versions[0]!.filename));
    expect(reads).not.toContain(cardVersionFile(root, child.id, catalog.versions[1]!.filename));
  });

  it('rewrites one invalid head before opening the promoted predecessor', () => {
    const { root, cards } = fixture();
    const child = cards.create({ type: 'code', parent: 'project', title: 'before', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.editCard(child.id, { title: 'after' }, 'planner');
    const catalog = index(root, child.id); const predecessor = cardVersionFile(root, child.id, catalog.versions[0]!.filename); const head = cardVersionFile(root, child.id, catalog.versions[1]!.filename);
    writeFileSync(head, '{malformed}\n'); const operations: string[] = [];
    recoverCurrentCardHead(root, child.id, undefined, { onRead(path) { operations.push(path); } });
    expect(index(root, child.id).current_version).toBe(1);
    expect(operations).toEqual([cardVersionIndexFile(root, child.id), head, predecessor]);
  });
});
