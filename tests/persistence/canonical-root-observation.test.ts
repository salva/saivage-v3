import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { observeCanonicalProjectRoot, type CardVersionArtifact } from '../../src/persistence/index.js';
import type { CardRecord } from '../../src/schemas/index.js';

const stamp = '2026-07-13T12:00:00.000Z';
let root: string;
let cardsPath: string;
let versionsPath: string;

function card(version = 1, overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: 'project', type: 'project', parent: null, depth: 0, position: 0, title: `Project ${version}`, status: 'backlog', subtype: null,
    tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: stamp, updated_at: stamp,
    assigned_to: null, depends_on: [], related: [], lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null,
    status_text_author_session_id: null, latest_self_report: null, retries: 0, version_seq: version, ...overrides,
  };
}

function artifact(version = 1): CardVersionArtifact {
  return {
    kind: 'card-version', format_version: 1, card_id: 'project', version, committed_at: stamp, card: card(version),
    history: version === 1 ? null : {
      entry_id: '11111111-1111-4111-8111-111111111111', kind: 'update', card_id: 'project', version_seq: version - 1,
      snapshot: card(version - 1), changed_at: stamp, changed_by_actor: 'analyst', changed_by_surface: 'web-chat',
      change_reason: 'test', changed_fields: ['title'], change_summary: 'updated title',
    },
  };
}

function writeArtifact(version = 1, value: unknown = artifact(version)): void {
  mkdirSync(versionsPath, { recursive: true });
  writeFileSync(join(versionsPath, `${version}.json`), `${JSON.stringify(value)}\n`);
}

function index(latest: number, entries: number[], overrides: Record<string, unknown> = {}) {
  return {
    kind: 'card-index', format_version: 1, card_id: 'project', latest,
    versions: Object.fromEntries(entries.map((version) => [String(version), { version, committed_at: stamp, history: artifact(version).history }])),
    ...overrides,
  };
}

function snapshot(path: string): unknown {
  if (!lstatSync(path).isDirectory()) return { type: lstatSync(path).isSymbolicLink() ? 'symlink' : 'file', bytes: readFileSync(path).toString('base64') };
  return Object.fromEntries(readdirSync(path).sort().map((entry) => [entry, snapshot(join(path, entry))]));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-root-observation-'));
  cardsPath = join(root, '.saivage', 'cards');
  versionsPath = join(cardsPath, 'project', 'card', 'versions');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('observeCanonicalProjectRoot', () => {
  it('completely selects canonical authority, returns an immutable observation, and performs no mutation', () => {
    writeArtifact(1);
    writeArtifact(2);
    const indexTemporary = join(cardsPath, 'project', 'card', '.index.json.saivage-write-12345678-1234-4234-8234-123456789abc.tmp');
    writeFileSync(indexTemporary, 'unpublished');
    const before = snapshot(root);

    const observed = observeCanonicalProjectRoot(cardsPath);

    expect(observed.selected.version).toBe(2);
    expect(observed.artifacts.map((entry) => entry.version)).toEqual([1, 2]);
    expect(observed.indexDiagnostic).toEqual({ kind: 'absent' });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.selected.card)).toBe(true);
    expect(snapshot(root)).toEqual(before);
  });

  it.each<[string, () => unknown]>([
    ['missing versions directory', () => mkdirSync(cardsPath, { recursive: true })],
    ['empty versions directory', () => mkdirSync(versionsPath, { recursive: true })],
    ['aliased filename', () => { writeArtifact(1); writeFileSync(join(versionsPath, '01.json'), JSON.stringify(artifact(1))); }],
    ['unexpected entry', () => { writeArtifact(1); mkdirSync(join(versionsPath, 'unexpected')); }],
    ['malformed JSON', () => { mkdirSync(versionsPath, { recursive: true }); writeFileSync(join(versionsPath, '1.json'), '{'); }],
    ['malformed lower artifact', () => { writeArtifact(1, { malformed: true }); writeArtifact(2); }],
    ['wrong envelope identity', () => { writeArtifact(1, { ...artifact(1), card_id: 'other' }); }],
  ])('fails mutation-free for %s', (_label, arrange) => {
    arrange();
    const before = snapshot(root);
    expect(() => observeCanonicalProjectRoot(cardsPath)).toThrow();
    expect(snapshot(root)).toEqual(before);
  });

  it('rejects a non-root selected project artifact without selecting around it', () => {
    writeArtifact(1);
    writeArtifact(2, { ...artifact(2), card: card(2, { parent: 'other', depth: 1 }) });
    const before = snapshot(root);
    expect(() => observeCanonicalProjectRoot(cardsPath)).toThrow(/not a root project card/);
    expect(snapshot(root)).toEqual(before);
  });

  it.each<[string, string | undefined, 'absent' | 'invalid' | 'inconsistent' | 'consistent']>([
    ['absent', undefined, 'absent'],
    ['malformed', '{', 'invalid'],
    ['truncated', '{"kind":"card-index"', 'invalid'],
    ['dangling/ahead', JSON.stringify(index(3, [1, 2, 3])), 'inconsistent'],
    ['stale/conflicting selection', JSON.stringify(index(1, [1])), 'inconsistent'],
    ['wrong identity', JSON.stringify(index(2, [1, 2], { card_id: 'other' })), 'invalid'],
    ['conflicting timestamp', JSON.stringify({ ...index(2, [1, 2]), versions: { ...index(2, [1, 2]).versions, '2': { version: 2, committed_at: '2026-07-13T13:00:00.000Z', history: artifact(2).history } } }), 'inconsistent'],
    ['consistent', JSON.stringify(index(2, [1, 2])), 'consistent'],
  ])('treats a %s derived index as nonblocking diagnostics', (_label, content, expectedKind) => {
    writeArtifact(1);
    writeArtifact(2);
    const indexPath = join(cardsPath, 'project', 'card', 'index.json');
    if (content !== undefined) writeFileSync(indexPath, content);
    const before = snapshot(root);

    const observed = observeCanonicalProjectRoot(cardsPath);

    expect(observed.selected.version).toBe(2);
    expect(observed.indexDiagnostic.kind).toBe(expectedKind);
    expect(snapshot(root)).toEqual(before);
  });

  it('fails on symlinked canonical entries without changing the tree', () => {
    writeArtifact(1);
    symlinkSync(join(versionsPath, '1.json'), join(versionsPath, '2.json'));
    const before = snapshot(root);
    expect(() => observeCanonicalProjectRoot(cardsPath)).toThrow(/not a regular file/);
    expect(snapshot(root)).toEqual(before);
  });
});
