import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { CardRecord } from '../../src/schemas/index.js';
import { IndeterminatePublicationError } from '../../src/persistence/errors.js';
import {
  openProjectPersistenceAuthority,
  verifyBootstrapEligibleLayout,
  type ProjectPersistenceAuthority,
} from '../../src/persistence/project-persistence-authority.js';
import { acquireLock, releaseLock, type RuntimeLifecycleLockHandle } from '../../src/runtime/lock.js';

const stamp = '2026-07-13T12:00:00.000Z';
const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-authority-'));
  roots.push(root);
  return root;
}

function rootCard(): CardRecord {
  return {
    id: 'project', type: 'project', parent: null, depth: 0, position: 0, title: 'Project', status: 'backlog', subtype: null,
    tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: stamp, updated_at: stamp,
    assigned_to: null, depends_on: [], related: [], lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null,
    status_text_author_session_id: null, latest_self_report: null, retries: 0, version_seq: 1,
  };
}

function rootInput() {
  return { card: rootCard(), brief: '# Goal\n\nBuild the project.' };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function initialBrief() {
  return {
    kind: 'record-version', format_version: 1, card_id: 'project', slot: 'brief', version: 1, state: 'closed',
    opened_at: stamp, committed_at: stamp, closed_at: stamp, discarded_at: null, reason: null, writer: 'analyst',
    format: 'markdown', schema: 'record.brief.markdown.v1', card_version_seq: 1, content: '# interrupted bootstrap',
  };
}

function snapshot(path: string): unknown {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { type: 'symlink' };
  if (!stat.isDirectory()) return { type: 'file', bytes: readFileSync(path).toString('base64') };
  return Object.fromEntries(readdirSync(path).sort().map((entry) => [entry, snapshot(join(path, entry))]));
}

function acquire(root: string): RuntimeLifecycleLockHandle {
  return acquireLock(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bootstrap eligibility', () => {
  it('accepts a fresh lock-only layout without mutation and returns an immutable root-bound proof', () => {
    const root = makeRoot();
    const lock = acquire(root);
    const before = snapshot(root);
    const proof = verifyBootstrapEligibleLayout(root, lock);
    expect(proof.canonicalProjectRoot).toBe(root);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(snapshot(root)).toEqual(before);
    releaseLock(lock);
  });

  it('accepts reset-empty generated directories, exact defaults, and an interrupted project prefix', () => {
    const root = makeRoot();
    const lock = acquire(root);
    for (const relative of ['cards/project/brief/versions', 'cards/project/card/versions', 'agents/runtime/actors', 'work/cards', 'stages', 'state', 'logs']) {
      mkdirSync(join(root, '.saivage', relative), { recursive: true });
    }
    writeJson(join(root, '.saivage', 'cards', 'project', 'brief', 'versions', '1.json'), initialBrief());
    writeFileSync(join(root, '.saivage', 'cards', 'project', 'brief', 'index.json'), '{derived');
    writeFileSync(join(root, '.saivage', 'cards', 'project', 'card', 'versions', '.1.json.saivage-write-12345678-1234-4234-8234-123456789abc.tmp'), 'temporary');
    writeJson(join(root, '.saivage', 'state', 'runtime.json'), {
      version: 1,
      data: { status: 'stopped', project_id: 'project', pid: 123, started_at: stamp, active_card_run: null, updated_at: stamp, last_tick_at: null },
    });
    writeFileSync(join(root, '.saivage', 'logs', 'app.jsonl'), '');
    writeFileSync(join(root, '.saivage', 'state', '.runtime.json.saivage-write-12345678-1234-4234-8234-123456789abc.tmp'), 'unpublished');
    const before = snapshot(root);
    expect(() => verifyBootstrapEligibleLayout(root, lock)).not.toThrow();
    expect(snapshot(root)).toEqual(before);
    releaseLock(lock);
  });

  it.each<[string, (root: string) => void]>([
    ['unknown generated entry', (root) => writeFileSync(join(root, '.saivage', 'unknown'), 'evidence')],
    ['nonempty app log', (root) => { mkdirSync(join(root, '.saivage', 'logs')); writeFileSync(join(root, '.saivage', 'logs', 'app.jsonl'), 'event\n'); }],
    ['nondefault runtime state', (root) => writeJson(join(root, '.saivage', 'state', 'runtime.json'), { version: 1, data: { status: 'running' } })],
    ['committed root', (root) => writeJson(join(root, '.saivage', 'cards', 'project', 'card', 'versions', '1.json'), { malformed: true })],
    ['committed non-root card', (root) => writeJson(join(root, '.saivage', 'cards', 'goal-1', 'card', 'versions', '1.json'), { malformed: true })],
    ['generated symlink', (root) => symlinkSync(root, join(root, '.saivage', 'cards'))],
    ['obsolete external work root', (root) => mkdirSync(join(root, '.saivage-work'))],
  ])('rejects %s without changing generated state', (_label, arrange) => {
    const root = makeRoot();
    const lock = acquire(root);
    arrange(root);
    const before = snapshot(root);
    expect(() => verifyBootstrapEligibleLayout(root, lock)).toThrow();
    expect(snapshot(root)).toEqual(before);
    releaseLock(lock);
  });

  it('rejects foreign and released lifecycle-lock handles before layout reads', () => {
    const root = makeRoot();
    const other = makeRoot();
    const lock = acquire(root);
    expect(() => verifyBootstrapEligibleLayout(other, lock)).toThrow(/belongs to/);
    releaseLock(lock);
    expect(() => verifyBootstrapEligibleLayout(root, lock)).toThrow(/live runtime lifecycle lock/);
  });
});

describe('project persistence authority opening', () => {
  it('bootstraps through one private writer, transitions through normal scanning, and supports normal reopen', () => {
    const root = makeRoot();
    const lock = acquire(root);
    const authority = openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'bootstrap', root: rootInput() } });
    expect(authority.state).toBe('open');
    expect('writer' in authority).toBe(false);
    expect(authority.generation.cards.get('project')?.current.card.title).toBe('Project');
    expect(readFileSync(join(root, '.saivage', 'cards', 'project', 'brief', 'versions', '1.json'), 'utf8')).toContain('Build the project.');
    expect(existsSync(join(root, '.saivage', 'state', 'runtime.json'))).toBe(true);
    expect(existsSync(join(root, '.saivage', 'logs', 'app.jsonl'))).toBe(true);

    authority.close();
    const reopened = openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'normal' } });
    expect(reopened.state).toBe('open');
    expect(reopened.generation.cards.has('project')).toBe(true);
    reopened.close();
    releaseLock(lock);
  });

  it('cleans an exact interrupted pre-card bootstrap prefix and retries with the configured root', () => {
    const root = makeRoot();
    const lock = acquire(root);
    writeJson(join(root, '.saivage', 'cards', 'project', 'brief', 'versions', '1.json'), initialBrief());
    mkdirSync(join(root, '.saivage', 'cards', 'project', 'card', 'versions'), { recursive: true });

    const authority = openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'bootstrap', root: rootInput() } });
    expect(authority.generation.cards.get('project')?.records.brief.latest?.content).toBe(rootInput().brief);
    authority.close();
    releaseLock(lock);
  });

  it('rejects bootstrap after canonical root publication and preserves the committed root', () => {
    const root = makeRoot();
    const lock = acquire(root);
    const authority = openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'bootstrap', root: rootInput() } });
    authority.close();
    const cardPath = join(root, '.saivage', 'cards', 'project', 'card', 'versions', '1.json');
    const before = readFileSync(cardPath, 'utf8');
    expect(() => openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'bootstrap', root: rootInput() } })).toThrow(/committed canonical card/);
    expect(readFileSync(cardPath, 'utf8')).toBe(before);
    releaseLock(lock);
  });

  it('normal reopen rebuilds a missing derived index after canonical root publication', () => {
    const root = makeRoot();
    const lock = acquire(root);
    const authority = openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'bootstrap', root: rootInput() } });
    authority.close();
    const indexPath = join(root, '.saivage', 'cards', 'project', 'card', 'index.json');
    rmSync(indexPath);
    const reopened = openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'normal' } });
    expect(existsSync(indexPath)).toBe(true);
    reopened.close();
    releaseLock(lock);
  });

  it('rejects invalid root input before establishing bootstrap defaults', () => {
    const root = makeRoot();
    const lock = acquire(root);
    const before = snapshot(root);
    const invalid = { ...rootInput(), card: { ...rootCard(), position: 1 } };
    expect(() => openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'bootstrap', root: invalid } })).toThrow(/canonical project card/);
    expect(snapshot(root)).toEqual(before);
    releaseLock(lock);
  });

  it('keeps failed normal opening mutation-free when canonical root authority is absent', () => {
    const root = makeRoot();
    const lock = acquire(root);
    const before = snapshot(root);
    expect(() => openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'normal' } })).toThrow(/Cannot enumerate canonical project/);
    expect(snapshot(root)).toEqual(before);
    releaseLock(lock);
  });
});

describe('authority admission and failure behavior', () => {
  function opened(): { authority: ProjectPersistenceAuthority; lock: RuntimeLifecycleLockHandle } {
    const root = makeRoot();
    const lock = acquire(root);
    const authority = openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'bootstrap', root: rootInput() } });
    return { authority, lock };
  }

  it('serializes admitted synchronous requests in call order and forbids recursive admission', () => {
    const { authority, lock } = opened();
    const order: string[] = [];
    authority.admitAuthorizedMutation(() => order.push('first'));
    authority.admitAuthorizedMutation(() => order.push('second'));
    expect(order).toEqual(['first', 'second']);
    expect(() => authority.admitAuthorizedMutation(() => authority.admitAuthorizedMutation(() => undefined))).toThrow(/Recursive/);
    expect(authority.state).toBe('failed');
    expect(() => authority.admitAuthorizedMutation(() => undefined)).toThrow(/failed/);
    releaseLock(lock);
  });

  it('rejects admission after an orderly close rather than queueing it', () => {
    const { authority, lock } = opened();
    authority.close();
    expect(() => authority.admitAuthorizedMutation(() => undefined)).toThrow(/closed/);
    expect(authority.state).toBe('closed');
    releaseLock(lock);
  });

  it('permanently invalidates admission after an indeterminate publication', () => {
    const { authority, lock } = opened();
    expect(() => authority.admitAuthorizedMutation(() => { throw new IndeterminatePublicationError('/target'); })).toThrow(IndeterminatePublicationError);
    expect(authority.state).toBe('failed');
    expect(() => authority.admitAuthorizedMutation(() => undefined)).toThrow(/failed/);
    releaseLock(lock);
  });

  it('invalidates admission when its lifecycle-lock handle is released', () => {
    const { authority, lock } = opened();
    releaseLock(lock);
    expect(() => authority.admitAuthorizedMutation(() => undefined)).toThrow(/live runtime lifecycle lock/);
    expect(authority.state).toBe('failed');
  });
});
