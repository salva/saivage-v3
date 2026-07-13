import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseCardIndex, parseRecordSlotIndex } from '../../src/persistence/index.js';
import { observeCanonicalProjectRoot, type ObservedProjectRoot } from '../../src/persistence/canonical-root-observation.js';
import { restabilizeCanonicalStore } from '../../src/persistence/canonical-store-scan.js';
import type { CardRecord } from '../../src/schemas/index.js';

const stamp = '2026-07-13T12:00:00.000Z';
const uuid = '12345678-1234-4234-8234-123456789abc';
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

function cardArtifact(value: CardRecord) {
  return { kind: 'card-version', format_version: 1, card_id: value.id, version: 1, committed_at: stamp, card: value, history: null };
}

function briefArtifact(cardId: string) {
  return {
    kind: 'record-version', format_version: 1, card_id: cardId, slot: 'brief', version: 1, state: 'closed',
    opened_at: stamp, committed_at: stamp, closed_at: stamp, discarded_at: null, reason: null, writer: 'analyst',
    format: 'markdown', schema: 'record.brief.markdown.v1', card_version_seq: 1, content: `# ${cardId}`,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeCommittedCard(value: CardRecord, includeBrief = true): void {
  const namespace = join(cardsPath, value.id);
  writeJson(join(namespace, 'card', 'versions', '1.json'), cardArtifact(value));
  if (includeBrief) writeJson(join(namespace, 'brief', 'versions', '1.json'), briefArtifact(value.id));
}

function canonicalBytes(cardId: string): Record<string, string> {
  const namespace = join(cardsPath, cardId);
  const result: Record<string, string> = {};
  for (const slot of ['card', 'brief', 'status', 'review']) {
    const versions = join(namespace, slot, 'versions');
    if (!existsSync(versions)) continue;
    for (const name of readdirSync(versions).filter((entry) => /^\d+\.json$/.test(entry))) {
      result[`${slot}/${name}`] = readFileSync(join(versions, name), 'utf8');
    }
  }
  return result;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'saivage-canonical-scan-'));
  cardsPath = join(projectRoot, '.saivage', 'cards');
  mkdirSync(cardsPath, { recursive: true });
  writeCommittedCard(card('project', null, 0));
});

afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

describe('restabilizeCanonicalStore', () => {
  it('cleans exact owned temporaries, reconstructs deterministic indexes, validates, and reaches a fixed point', () => {
    writeCommittedCard(card('goal-1', 'project', 1));
    const observation = observeCanonicalProjectRoot(cardsPath);
    const rootCardPath = join(cardsPath, 'project', 'card');
    writeFileSync(join(rootCardPath, `.index.json.saivage-write-${uuid}.tmp`), 'temporary index');
    writeFileSync(join(rootCardPath, 'versions', `.2.json.saivage-write-${uuid}.tmp`), 'temporary version');
    writeFileSync(join(rootCardPath, 'index.json'), '{malformed');
    const beforeCanonical = canonicalBytes('project');

    const first = restabilizeCanonicalStore(projectRoot, cardsPath, observation);

    expect([...first.cards.keys()]).toEqual(['goal-1', 'project']);
    expect(canonicalBytes('project')).toEqual(beforeCanonical);
    expect(readdirSync(rootCardPath).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(join(rootCardPath, 'versions')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const cardIndexPath = join(rootCardPath, 'index.json');
    const briefIndexPath = join(cardsPath, 'project', 'brief', 'index.json');
    expect(parseCardIndex(JSON.parse(readFileSync(cardIndexPath, 'utf8')), cardIndexPath, 'project').latest).toBe(1);
    expect(parseRecordSlotIndex(JSON.parse(readFileSync(briefIndexPath, 'utf8')), briefIndexPath, { cardId: 'project', slot: 'brief' }).latest).toBe(1);
    const firstIndexes = [readFileSync(cardIndexPath, 'utf8'), readFileSync(briefIndexPath, 'utf8')];

    const secondObservation = observeCanonicalProjectRoot(cardsPath);
    restabilizeCanonicalStore(projectRoot, cardsPath, secondObservation);
    expect([readFileSync(cardIndexPath, 'utf8'), readFileSync(briefIndexPath, 'utf8')]).toEqual(firstIndexes);
    expect(canonicalBytes('project')).toEqual(beforeCanonical);
  });

  it('discards an exhaustively recognizable never-committed namespace and permits its id to disappear cleanly', () => {
    const namespace = join(cardsPath, 'goal-retry');
    writeJson(join(namespace, 'brief', 'versions', '1.json'), briefArtifact('goal-retry'));
    writeFileSync(join(namespace, 'brief', 'index.json'), '{derived may be stale');
    mkdirSync(join(namespace, 'card', 'versions'), { recursive: true });
    writeFileSync(join(namespace, 'card', 'versions', `.1.json.saivage-write-${uuid}.tmp`), 'unpublished');

    const generation = restabilizeCanonicalStore(projectRoot, cardsPath, observeCanonicalProjectRoot(cardsPath));

    expect(existsSync(namespace)).toBe(false);
    expect(generation.cards.has('goal-retry')).toBe(false);
  });

  it('does not treat a derived card index alone as committed authority', () => {
    const namespace = join(cardsPath, 'goal-derived-only');
    mkdirSync(join(namespace, 'card', 'versions'), { recursive: true });
    writeFileSync(join(namespace, 'card', 'index.json'), '{non-authoritative');
    restabilizeCanonicalStore(projectRoot, cardsPath, observeCanonicalProjectRoot(cardsPath));
    expect(existsSync(namespace)).toBe(false);
  });

  it.each<[string, (namespace: string) => void]>([
    ['unknown file', (namespace: string) => writeFileSync(join(namespace, 'unknown.txt'), 'operator evidence')],
    ['malformed initial brief', (namespace: string) => writeJson(join(namespace, 'brief', 'versions', '1.json'), { malformed: true })],
  ])('retains an ambiguous incomplete namespace with an %s', (_label, arrange) => {
    const namespace = join(cardsPath, 'goal-ambiguous');
    mkdirSync(namespace, { recursive: true });
    arrange(namespace);
    expect(() => restabilizeCanonicalStore(projectRoot, cardsPath, observeCanonicalProjectRoot(cardsPath))).toThrow();
    expect(existsSync(namespace)).toBe(true);
  });

  it('retains and fails on a malformed canonical card artifact rather than selecting or deleting around it', () => {
    const namespace = join(cardsPath, 'goal-bad');
    writeJson(join(namespace, 'card', 'versions', '1.json'), { malformed: true });
    const before = readFileSync(join(namespace, 'card', 'versions', '1.json'), 'utf8');

    expect(() => restabilizeCanonicalStore(projectRoot, cardsPath, observeCanonicalProjectRoot(cardsPath))).toThrow(/goal-bad/);
    expect(readFileSync(join(namespace, 'card', 'versions', '1.json'), 'utf8')).toBe(before);
  });

  it('rejects and retains a symlink in an incomplete namespace', () => {
    const namespace = join(cardsPath, 'goal-link');
    mkdirSync(namespace, { recursive: true });
    symlinkSync(join(cardsPath, 'project'), join(namespace, 'card'));
    expect(() => restabilizeCanonicalStore(projectRoot, cardsPath, observeCanonicalProjectRoot(cardsPath))).toThrow(/Ambiguous/);
    expect(existsSync(namespace)).toBe(true);
  });

  it('fails complete validation when a committed current card lacks its required brief', () => {
    writeCommittedCard(card('goal-no-brief', 'project', 1), false);
    expect(() => restabilizeCanonicalStore(projectRoot, cardsPath, observeCanonicalProjectRoot(cardsPath))).toThrow(/required closed brief/);
  });

  it('rejects a forged observation before any mutation', () => {
    const cardIndexPath = join(cardsPath, 'project', 'card', 'index.json');
    expect(existsSync(cardIndexPath)).toBe(false);
    expect(() => restabilizeCanonicalStore(projectRoot, cardsPath, {} as ObservedProjectRoot)).toThrow(/issued project-root observation/);
    expect(existsSync(cardIndexPath)).toBe(false);
  });

  it('rejects a valid observation issued for another cards root before mutation', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'saivage-canonical-scan-other-'));
    const otherCards = join(otherRoot, '.saivage', 'cards');
    const originalCards = cardsPath;
    try {
      cardsPath = otherCards;
      mkdirSync(cardsPath, { recursive: true });
      writeCommittedCard(card('project', null, 0));
      const foreignObservation = observeCanonicalProjectRoot(cardsPath);
      cardsPath = originalCards;
      const indexPath = join(cardsPath, 'project', 'card', 'index.json');
      expect(() => restabilizeCanonicalStore(projectRoot, cardsPath, foreignObservation)).toThrow(/observation belongs/);
      expect(existsSync(indexPath)).toBe(false);
    } finally {
      cardsPath = originalCards;
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
