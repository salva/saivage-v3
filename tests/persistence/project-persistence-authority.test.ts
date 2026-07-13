import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { CardRecord } from '../../src/schemas/index.js';
import { IndeterminatePublicationError } from '../../src/persistence/errors.js';
import {
  classifyPersistenceOpenMode,
  openProjectPersistenceAuthority,
  verifyBootstrapEligibleLayout,
  type ProjectPersistenceAuthority,
} from '../../src/persistence/project-persistence-authority.js';
import { acquireRuntimeLifecycleLock, releaseRuntimeLifecycleLock, type RuntimeLifecycleLockHandle } from '../../src/runtime/lock.js';
import { CardStore } from '../../src/cards/card-store.js';

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

function childCard(id: string, versionSeq = 1): CardRecord {
  return {
    ...rootCard(), id, type: 'goal', parent: 'project', depth: 1, title: id, position: 0,
    version_seq: versionSeq, updated_at: versionSeq === 1 ? stamp : '2026-07-13T12:00:01.000Z',
  };
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
  return acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'init' });
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
    releaseRuntimeLifecycleLock(lock);
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
    releaseRuntimeLifecycleLock(lock);
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
    releaseRuntimeLifecycleLock(lock);
  });

  it('rejects foreign and released lifecycle-lock handles before layout reads', () => {
    const root = makeRoot();
    const other = makeRoot();
    const lock = acquire(root);
    expect(() => verifyBootstrapEligibleLayout(other, lock)).toThrow(/belongs to/);
    releaseRuntimeLifecycleLock(lock);
    expect(() => verifyBootstrapEligibleLayout(root, lock)).toThrow(/foreign or already released/);
  });
});

describe('bootstrap-capable command mode classification', () => {
  it('selects bootstrap only for an unpublished root whose complete layout is eligible', () => {
    const root = makeRoot();
    const lock = acquire(root);
    const before = snapshot(root);
    expect(classifyPersistenceOpenMode(root, lock, rootInput())).toEqual({ kind: 'bootstrap', root: rootInput() });
    expect(snapshot(root)).toEqual(before);
    releaseRuntimeLifecycleLock(lock);
  });

  it('selects normal without invoking bootstrap mutation for malformed canonical root evidence', () => {
    const root = makeRoot();
    const lock = acquire(root);
    mkdirSync(join(root, '.saivage', 'cards', 'project', 'card', 'versions'), { recursive: true });
    writeFileSync(join(root, '.saivage', 'cards', 'project', 'card', 'versions', '1.json'), '{malformed');
    const before = snapshot(root);
    expect(classifyPersistenceOpenMode(root, lock, rootInput())).toEqual({ kind: 'normal' });
    expect(snapshot(root)).toEqual(before);
    expect(() => openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'normal' } })).toThrow(/Failed to parse JSON/);
    expect(snapshot(root)).toEqual(before);
    releaseRuntimeLifecycleLock(lock);
  });

  it('selects normal mutation-free when the root is missing from a nonfresh generated layout', () => {
    const root = makeRoot();
    const lock = acquire(root);
    mkdirSync(join(root, '.saivage', 'logs'), { recursive: true });
    writeFileSync(join(root, '.saivage', 'logs', 'app.jsonl'), 'authored evidence\n');
    const before = snapshot(root);
    expect(classifyPersistenceOpenMode(root, lock, rootInput())).toEqual({ kind: 'normal' });
    expect(() => openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'normal' } })).toThrow(/Cannot enumerate canonical project/);
    expect(snapshot(root)).toEqual(before);
    releaseRuntimeLifecycleLock(lock);
  });
});

describe('project persistence authority opening', () => {
  it('bootstraps through one private writer, transitions through normal scanning, and supports normal reopen', () => {
    const root = makeRoot();
    const lock = acquire(root);
    const authority = openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'bootstrap', root: rootInput() } });
    expect(authority.state).toBe('open');
    expect(authority.writer).toBeDefined();
    expect(authority.generation.cards.get('project')?.current.card.title).toBe('Project');
    expect(readFileSync(join(root, '.saivage', 'cards', 'project', 'brief', 'versions', '1.json'), 'utf8')).toContain('Build the project.');
    expect(existsSync(join(root, '.saivage', 'state', 'runtime.json'))).toBe(true);
    expect(existsSync(join(root, '.saivage', 'logs', 'app.jsonl'))).toBe(true);

    authority.close();
    const reopened = openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'normal' } });
    expect(reopened.state).toBe('open');
    expect(reopened.generation.cards.has('project')).toBe(true);
    reopened.close();
    releaseRuntimeLifecycleLock(lock);
  });

  it('cleans an exact interrupted pre-card bootstrap prefix and retries with the configured root', () => {
    const root = makeRoot();
    const lock = acquire(root);
    writeJson(join(root, '.saivage', 'cards', 'project', 'brief', 'versions', '1.json'), initialBrief());
    mkdirSync(join(root, '.saivage', 'cards', 'project', 'card', 'versions'), { recursive: true });

    const authority = openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'bootstrap', root: rootInput() } });
    expect(authority.generation.cards.get('project')?.records.brief.latest?.content).toBe(rootInput().brief);
    authority.close();
    releaseRuntimeLifecycleLock(lock);
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
    releaseRuntimeLifecycleLock(lock);
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
    releaseRuntimeLifecycleLock(lock);
  });

  it('rejects invalid root input before establishing bootstrap defaults', () => {
    const root = makeRoot();
    const lock = acquire(root);
    const before = snapshot(root);
    const invalid = { ...rootInput(), card: { ...rootCard(), position: 1 } };
    expect(() => openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'bootstrap', root: invalid } })).toThrow(/canonical project card/);
    expect(snapshot(root)).toEqual(before);
    releaseRuntimeLifecycleLock(lock);
  });

  it('keeps failed normal opening mutation-free when canonical root authority is absent', () => {
    const root = makeRoot();
    const lock = acquire(root);
    const before = snapshot(root);
    expect(() => openProjectPersistenceAuthority({ projectRoot: root, lifecycleLock: lock, mode: { kind: 'normal' } })).toThrow(/Cannot enumerate canonical project/);
    expect(snapshot(root)).toEqual(before);
    releaseRuntimeLifecycleLock(lock);
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
    authority.writer.request(() => order.push('first'));
    authority.writer.request(() => order.push('second'));
    expect(order).toEqual(['first', 'second']);
    expect(() => authority.writer.request(() => authority.writer.request(() => undefined))).toThrow(/Recursive/);
    expect(authority.state).toBe('open');
    releaseRuntimeLifecycleLock(lock);
  });

  it('injects the exact authority reader and writer into the CardStore composition', () => {
    const { authority, lock } = opened();
    const store = new CardStore({ projectRoot: authority.projectRoot, reader: authority.reader, writer: authority.writer });
    expect(store.recordReader).toBe(authority.reader);
    expect((store as unknown as { persistenceWriter: unknown }).persistenceWriter).toBe(authority.writer);
    authority.close();
    releaseRuntimeLifecycleLock(lock);
  });

  it('runs a real multi-artifact CardStore request without recursive admission', () => {
    const { authority, lock } = opened();
    const store = new CardStore({ projectRoot: authority.projectRoot, reader: authority.reader, writer: authority.writer });
    const card = store.create({ type: 'goal', parent: 'project', title: 'Composite', brief: 'Initial', status: 'backlog', depth: 1, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    store.runPersistenceRequest(() => {
      const open = store.openRecord(card.id, 'status.md');
      store.editRecord(card.id, 'status.md', open.version, 'composite status');
      store.closeRecord(card.id, 'status.md', open.version, 'planner', card.version_seq);
      store.mutateCard(card.id, { priority: 2 }, { actor: 'planner', surface: 'runtime', reason: 'composite test' });
    });
    expect(authority.reader.record(card.id, 'status.md').artifact.content).toBe('composite status');
    expect(authority.generation.cards.get(card.id)?.current.card).toMatchObject({ priority: 2, version_seq: 2 });
    authority.close();
    releaseRuntimeLifecycleLock(lock);
  });

  it('checks expected card versions in the admitted turn against the latest generation', () => {
    const { authority, lock } = opened();
    const first = new CardStore({ projectRoot: authority.projectRoot, reader: authority.reader, writer: authority.writer });
    const card = first.create({ type: 'goal', parent: 'project', title: 'Before', brief: 'brief', status: 'backlog', depth: 1, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    const stale = new CardStore({ projectRoot: authority.projectRoot, reader: authority.reader, writer: authority.writer });
    first.mutateCard(card.id, { title: 'First accepted update' }, { actor: 'planner', surface: 'runtime', reason: 'first' });
    expect(() => stale.mutateCard(card.id, { title: 'Stale update' }, { actor: 'planner', surface: 'runtime', reason: 'stale' })).toThrow(/expected version 3/);
    expect(authority.state).toBe('open');
    authority.close();
    releaseRuntimeLifecycleLock(lock);
  });

  it('invalidates the authority after a real canonical publication failure', () => {
    const { authority, lock } = opened();
    const target = join(authority.projectRoot, '.saivage', 'cards', 'project', 'status', 'versions', '1.json');
    mkdirSync(target, { recursive: true });
    expect(() => authority.writer.request((writer) => writer.openRecord('project', 'status.md'))).toThrow();
    expect(authority.state).toBe('failed');
    expect(() => authority.writer.request(() => undefined)).toThrow(/failed/);
    releaseRuntimeLifecycleLock(lock);
  });

  it('invalidates after post-publication index failure and normal reopen reaches the canonical fixed point', () => {
    const { authority, lock } = opened();
    const store = new CardStore({ projectRoot: authority.projectRoot, reader: authority.reader, writer: authority.writer });
    const card = store.create({ type: 'goal', parent: 'project', title: 'Before', brief: 'brief', status: 'backlog', depth: 1, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    const indexPath = join(authority.projectRoot, '.saivage', 'cards', card.id, 'card', 'index.json');
    rmSync(indexPath);
    mkdirSync(indexPath);
    expect(() => store.mutateCard(card.id, { title: 'Published before index failure' }, { actor: 'planner', surface: 'runtime', reason: 'fault injection' })).toThrow();
    expect(authority.state).toBe('failed');
    expect(existsSync(join(authority.projectRoot, '.saivage', 'cards', card.id, 'card', 'versions', '2.json'))).toBe(true);
    releaseRuntimeLifecycleLock(lock);

    rmSync(indexPath, { recursive: true });
    const reopenLock = acquire(authority.projectRoot);
    const reopened = openProjectPersistenceAuthority({ projectRoot: authority.projectRoot, lifecycleLock: reopenLock, mode: { kind: 'normal' } });
    expect(reopened.generation.cards.get(card.id)?.current.card).toMatchObject({ title: 'Published before index failure', version_seq: 2 });
    expect(lstatSync(indexPath).isFile()).toBe(true);
    reopened.close();
    releaseRuntimeLifecycleLock(reopenLock);
  });

  it('creates no card, project, slot, or per-file lock during canonical mutations', () => {
    const { authority, lock } = opened();
    authority.writer.request((writer) => writer.createCard(childCard('card-lock'), 'brief', 'planner'));
    authority.writer.request((writer) => {
      const open = writer.openRecord('card-lock', 'status.md');
      writer.editRecord('card-lock', 'status.md', open.version, 'status');
      writer.closeRecord('card-lock', 'status.md', open.version, 'planner', 1);
    });
    expect(readdirSync(join(authority.projectRoot, '.saivage', 'locks'))).toEqual(['runtime.lock']);
    authority.close();
    releaseRuntimeLifecycleLock(lock);
  });

  it('rejects admission after an orderly close rather than queueing it', () => {
    const { authority, lock } = opened();
    authority.close();
    expect(() => authority.writer.request(() => undefined)).toThrow(/closed/);
    expect(authority.state).toBe('closed');
    releaseRuntimeLifecycleLock(lock);
  });

  it('does not mistake a caller error for a publication failure', () => {
    const { authority, lock } = opened();
    expect(() => authority.writer.request(() => { throw new IndeterminatePublicationError('/target'); })).toThrow(IndeterminatePublicationError);
    expect(authority.state).toBe('open');
    releaseRuntimeLifecycleLock(lock);
  });

  it('invalidates admission when its lifecycle-lock handle is released', () => {
    const { authority, lock } = opened();
    releaseRuntimeLifecycleLock(lock);
    expect(() => authority.writer.request(() => undefined)).toThrow(/foreign or already released/);
    expect(authority.state).toBe('failed');
  });
});
