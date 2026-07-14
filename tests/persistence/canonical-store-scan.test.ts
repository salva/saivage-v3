import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { discardIncompleteCardNamespace, loadProjectStore } from '../../src/persistence/canonical-store-scan.js';
import type { CardRecord } from '../../src/schemas/index.js';

const stamp = '2026-07-13T12:00:00.000Z';
let projectRoot: string;
let cardsPath: string;

function card(id: string, parent: string | null, depth: number): CardRecord {
  return {
    id, type: id === 'project' ? 'project' : 'goal', parent, depth, position: 0, title: id, status: 'backlog', subtype: null,
    tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: stamp, updated_at: stamp,
    assigned_to: null, depends_on: [], related: [], lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null,
    status_text_author_session_id: null, latest_self_report: null, retries: 0, version_seq: 1,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function writeCommittedCard(value: CardRecord, includeBrief = true): void {
  writeJson(join(cardsPath, value.id, 'card', 'versions', '1.json'), { kind: 'card-version', format_version: 1, card_id: value.id, version: 1, committed_at: stamp, card: value, history: null });
  if (includeBrief) writeJson(join(cardsPath, value.id, 'brief', 'versions', '1.json'), { kind: 'record-version', format_version: 1, card_id: value.id, slot: 'brief', version: 1, state: 'closed', opened_at: stamp, committed_at: stamp, closed_at: stamp, discarded_at: null, reason: null, writer: 'analyst', format: 'markdown', schema: 'record.brief.markdown.v1', card_version_seq: 1, content: `# ${value.id}` });
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'saivage-canonical-scan-'));
  cardsPath = join(projectRoot, '.saivage', 'cards');
  mkdirSync(cardsPath, { recursive: true });
  writeCommittedCard(card('project', null, 0));
});

afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

describe('loadProjectStore', () => {
  it('loads active cards directly from immutable artifacts without indexes', () => {
    writeCommittedCard(card('card-1', 'project', 1));
    const model = loadProjectStore(cardsPath);
    expect([...model.cards.keys()]).toEqual(['card-1', 'project']);
    expect(model.tombstonedIds.size).toBe(0);
  });

  it('classifies an exact tombstone namespace and excludes it from active cards', () => {
    const finalCard = card('card-1', 'project', 1);
    writeJson(join(cardsPath, 'card-1', 'tombstone.json'), { kind: 'card-tombstone', format_version: 1, card_id: 'card-1', deleted_at: stamp, final_card: finalCard, deletion_history: { entry_id: '12345678-1234-4234-8234-123456789abc', kind: 'delete', card_id: 'card-1', version_seq: 1, snapshot: finalCard, changed_at: stamp, changed_by_actor: 'analyst', changed_by_surface: 'web-chat', change_reason: null, changed_fields: ['__deleted__'], change_summary: 'deleted' } });
    const model = loadProjectStore(cardsPath);
    expect(model.cards.has('card-1')).toBe(false);
    expect(model.tombstonedIds.has('card-1')).toBe(true);
  });

  it('retains and fails on a malformed complete card artifact', () => {
    const path = join(cardsPath, 'card-1', 'card', 'versions', '1.json');
    writeJson(path, { malformed: true });
    const before = readFileSync(path, 'utf8');
    expect(() => loadProjectStore(cardsPath)).toThrow(/card-1/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('discards only a recognizable never-committed namespace', () => {
    const namespace = join(cardsPath, 'card-1');
    mkdirSync(join(namespace, 'card', 'versions'), { recursive: true });
    discardIncompleteCardNamespace(cardsPath, 'card-1');
    expect(existsSync(namespace)).toBe(false);
  });

  it('requires a closed brief for each active card', () => {
    writeCommittedCard(card('card-1', 'project', 1), false);
    expect(() => loadProjectStore(cardsPath)).toThrow(/required closed brief/);
  });
});
