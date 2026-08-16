import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { cardVersionIndexSchema } from '../../src/persistence/canonical-card-artifacts.js';
import { cardVersionFile, cardVersionIndexFile } from '../../src/persistence/layout.js';
import { buildContentPolicyReadModel } from '../../src/application/read-models/content-policy-read-model.js';
import { CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY } from '../../src/schemas/index.js';
import { readCurrentCardArtifact } from '../../src/persistence/card-files.js';
import { runtimeFailure, workflowResult } from '../helpers/workflow-result.js';

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
  it.each(['blocked', 'failed'] as const)('retains strict changed-status then metadata-update history for a real %s correction', (status) => {
    const { root, cards } = fixture();
    const child = cards.create({ type: 'code', parent: 'project', title: 'before', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.setStatus(child.id, 'running');
    if (status === 'blocked') cards.commitActivationOutcome(child.id, { status, summary: 'blocked', result: workflowResult('BLOCKED', 'blocked') }, '2026-08-15T00:00:00.000Z');
    else cards.commitActivationOutcome(child.id, { status, summary: 'failed', result: runtimeFailure('failed') }, '2026-08-15T00:00:00.000Z');

    const beforeNoOp = index(root, child.id);
    expect(cards.editCard(child.id, { title: 'before' }, 'planner')).toMatchObject({ title: 'before', lifecycle: { status } });
    expect(index(root, child.id)).toEqual(beforeNoOp);

    cards.editCard(child.id, { title: 'after' }, 'planner');
    const catalog = index(root, child.id);
    const statusVersion = catalog.versions.at(-2)!.version;
    const updateVersion = catalog.versions.at(-1)!.version;
    expect(cards.readCardVersion(child.id, statusVersion)).toMatchObject({
      kind: 'found',
      value: {
        kind: 'card-version',
        card: { title: 'before', lifecycle: { status: 'changed' } },
        change: { kind: 'status', card_id: child.id, resulting_version: statusVersion, changed_by_actor: 'runtime', changed_by_surface: 'runtime', change_reason: 'status -> changed', changed_fields: ['lifecycle'] },
      },
    });
    expect(cards.readCardVersion(child.id, updateVersion)).toMatchObject({
      kind: 'found',
      value: {
        kind: 'card-version',
        card: { title: 'after', lifecycle: { status: 'changed' } },
        change: { kind: 'update', card_id: child.id, resulting_version: updateVersion, changed_by_actor: 'planner', changed_by_surface: 'runtime', change_reason: 'agent edit_card', changed_fields: ['title'] },
      },
    });
  });

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

  it.each(['malformed', 'missing', 'mismatched'] as const)('rejects a %s indexed current head without changing the index or opening its predecessor', (fault) => {
    const { root, cards } = fixture();
    const child = cards.create({ type: 'code', parent: 'project', title: 'before', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.editCard(child.id, { title: 'after' }, 'planner');
    const indexPath = cardVersionIndexFile(root, child.id); const indexBytes = readFileSync(indexPath);
    const catalog = index(root, child.id); const predecessor = cardVersionFile(root, child.id, catalog.versions[0]!.filename); const head = cardVersionFile(root, child.id, catalog.versions[1]!.filename);
    if (fault === 'malformed') writeFileSync(head, '{malformed}\n');
    else if (fault === 'missing') unlinkSync(head);
    else {
      const artifact = JSON.parse(readFileSync(head, 'utf8')) as { entry_id: string };
      writeFileSync(head, `${JSON.stringify({ ...artifact, entry_id: '00000000-0000-4000-8000-000000000001' })}\n`);
    }
    const operations: string[] = [];
    expect(() => readCurrentCardArtifact(root, child.id, { onRead(path) { operations.push(path); } })).toThrow();
    expect(readFileSync(indexPath)).toEqual(indexBytes);
    expect(operations).not.toContain(predecessor);
  });
});
