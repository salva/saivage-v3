import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CanonicalCardFilesReadModel, type CanonicalCardFilesReader } from '../../src/application/read-models/canonical-card-files-read-model.js';
import { MAX_CARD_DEPTH } from '../../src/schemas/card-id.js';
import { cardStreamFile } from '../../src/persistence/layout.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import type { CardArtifact } from '../../src/persistence/canonical-card-artifacts.js';
import type { CardRecord } from '../../src/schemas/index.js';

function cardPath(depth: number): string {
  return `.saivage/cards/project${'/children/a'.repeat(depth)}`;
}

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('CanonicalCardFilesReadModel card depth', () => {
  it('delegates a depth-twelve path and rejects a thirteenth without a reader call', () => {
    const getCanonicalCardFilesMetadata = jest.fn(() => ({ kind: 'card-not-found' as const }));
    const reader = {
      getCanonicalCardFilesMetadata,
    } as unknown as CanonicalCardFilesReader;
    const model = new CanonicalCardFilesReadModel(() => reader);
    const twelve = `card-${Array.from({ length: MAX_CARD_DEPTH }, () => 'a').join('-')}`;

    expect(model.list(cardPath(MAX_CARD_DEPTH))).toEqual({ statusCode: 404, body: { error: 'Path not found', path: cardPath(MAX_CARD_DEPTH) } });
    expect(getCanonicalCardFilesMetadata).toHaveBeenCalledWith(twelve);
    getCanonicalCardFilesMetadata.mockClear();
    expect(model.list(cardPath(MAX_CARD_DEPTH + 1))).toEqual({ statusCode: 404, body: { error: 'Path not found', path: cardPath(MAX_CARD_DEPTH + 1) } });
    expect(getCanonicalCardFilesMetadata).not.toHaveBeenCalled();
  });
});

const NAMESPACE = '.saivage/cards/project';
const MAX_FILE_SIZE_BYTES = 1_048_576;

function fixture(): CardService {
  const root = mkdtempSync(join(tmpdir(), 'saivage-card-files-'));
  roots.push(root);
  initProjectTree(root);
  return new CardService(root);
}

function readerFor(cards: CardService): CanonicalCardFilesReader {
  return {
    current: (cardId, filename) => cards.readCurrentRecord(cardId, filename),
    historical: (cardId, filename, version) => cards.readHistoricalRecord(cardId, filename, version),
    definition: (cardId, filename) => cards.recordReader.definition(cardId, filename),
    getCanonicalCard: (cardId) => cards.getCanonicalCard(cardId),
    getCanonicalCardChildren: (cardId) => cards.getCanonicalCardChildren(cardId),
    getCanonicalCardFilesMetadata: (cardId) => cards.getCanonicalCardFilesMetadata(cardId),
    readCardVersion: (cardId, version) => cards.readCardVersion(cardId, version),
  };
}

function lastRow(cards: CardService): CardArtifact {
  const stream = readFileSync(cardStreamFile(cards.projectRoot, 'project'), 'utf8').trimEnd().split('\n');
  const rows = (JSON.parse(stream.at(-1)!) as { rows: CardArtifact[] }).rows;
  return rows[0]!;
}

function retitle(cards: CardService, title: string): CardRecord {
  return cards.editCard('project', { title }, 'planner');
}

describe('CanonicalCardFilesReadModel virtual card documents', () => {
  it('serves strict row-format-2 current and historical artifacts with both relationship arrays', () => {
    const cards = fixture();
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const model = new CanonicalCardFilesReadModel(() => readerFor(cards));

    const current = model.content(`${NAMESPACE}/card.json`);
    const historical = model.content(`${NAMESPACE}/card.json?v=1`);
    if ('statusCode' in current || 'statusCode' in historical) throw new Error('Expected card documents.');
    const currentDocument = JSON.parse(current.body.content) as { format_version: number; card: Record<string, unknown> };
    const historicalDocument = JSON.parse(historical.body.content) as { format_version: number; card: Record<string, unknown> };
    expect(currentDocument).toMatchObject({ format_version: 2, card: { child_membership: [child.id], active_child_order: [child.id] } });
    expect(historicalDocument).toMatchObject({ format_version: 2, card: { child_membership: [], active_child_order: [] } });
    expect(currentDocument.card).not.toHaveProperty('children');
    expect(historicalDocument.card).not.toHaveProperty('children');
  });

  it('serves the small selected document of a cumulative stream over 1 MiB with exact bytes and committed_at', () => {
    const cards = fixture();
    retitle(cards, `huge-${'x'.repeat(1_100_000)}`);
    retitle(cards, 'small again');
    const model = new CanonicalCardFilesReadModel(() => readerFor(cards));
    expect(readFileSync(cardStreamFile(cards.projectRoot, 'project')).byteLength).toBeGreaterThan(MAX_FILE_SIZE_BYTES);

    const listed = model.list(NAMESPACE);
    const preview = model.content(`${NAMESPACE}/card.json`);
    if ('statusCode' in preview || 'statusCode' in listed) throw new Error('Expected success results.');
    const cardRow = listed.body.files.find(({ name }) => name === 'card.json')!;
    expect(cardRow.size).toBe(Buffer.byteLength(preview.body.content));
    expect(cardRow.size).toBe(preview.body.size);
    expect(cardRow.size).toBeLessThan(10_000);
    expect(cardRow.modifiedAt).toBe(preview.body.modifiedAt);
    expect(cardRow.modifiedAt).toBe(lastRow(cards).committed_at);
  });

  it('admits an oversized selected document alone against the virtual size', () => {
    const cards = fixture();
    retitle(cards, `oversized-${'y'.repeat(MAX_FILE_SIZE_BYTES + 4096)}`);
    const model = new CanonicalCardFilesReadModel(() => readerFor(cards));

    const preview = model.content(`${NAMESPACE}/card.json`);
    if (preview.statusCode !== 413) throw new Error('Expected a 413 admission.');
    expect(preview.body.maxSize).toBe(MAX_FILE_SIZE_BYTES);
    expect(preview.body.size).toBeGreaterThan(MAX_FILE_SIZE_BYTES);
    const listed = model.list(NAMESPACE);
    if ('statusCode' in listed) throw new Error('Expected a success listing.');
    expect(listed.body.files.find(({ name }) => name === 'card.json')!.size).toBe(preview.body.size);
  });

  it('keeps card.json?v=N size, modified time, and content stable after later appends', () => {
    const cards = fixture();
    retitle(cards, 'second title');
    const model = new CanonicalCardFilesReadModel(() => readerFor(cards));
    const before = model.content(`${NAMESPACE}/card.json?v=2`);
    if ('statusCode' in before) throw new Error('Expected a success result.');
    const secondRow = lastRow(cards);

    retitle(cards, 'third title');
    retitle(cards, 'fourth title');

    const after = model.content(`${NAMESPACE}/card.json?v=2`);
    if ('statusCode' in after) throw new Error('Expected a success result.');
    expect(after.body.content).toBe(before.body.content);
    expect(after.body.size).toBe(before.body.size);
    expect(after.body.modifiedAt).toBe(before.body.modifiedAt);
    expect(after.body.modifiedAt).toBe(secondRow.committed_at);
    expect(after.body.version).toBe(2);

    const current = model.content(`${NAMESPACE}/card.json`);
    if ('statusCode' in current) throw new Error('Expected a success result.');
    expect(current.body.version).toBe(4);
    expect(current.body.content).not.toBe(after.body.content);
    expect(current.body.modifiedAt).toBe(lastRow(cards).committed_at);
  });

  it('does not expose physical stream layout in the namespace', () => {
    const cards = fixture();
    const model = new CanonicalCardFilesReadModel(() => readerFor(cards));
    const listed = model.list(NAMESPACE);
    if ('statusCode' in listed) throw new Error('Expected a success listing.');
    expect(listed.body.files.map(({ name }) => name)).not.toContain('card.jsonl');
    expect(model.content(`${NAMESPACE}/card.jsonl`).statusCode).toBe(404);
    expect(existsSync(join(cards.projectRoot, NAMESPACE, 'card.json'))).toBe(false);
  });
});
