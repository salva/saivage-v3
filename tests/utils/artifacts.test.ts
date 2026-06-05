import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import {
  registerArtifact,
  registerAttachment,
  registerEvidenceRefs,
  getArtifacts,
  getArtifactsByRetention,
  getAttachments,
  removeArtifact,
  removeAttachment,
} from '../../src/cards/artifacts.js';

// ── Helpers ───────────────────────────────────────────────────

function makeSourceFile(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

function makeCard(
  store: CardStore,
  type: string,
  title: string,
  parent: string = 'project',
) {
  return store.create({
    type: type as 'goal',
    parent,
    depth: 1,
    title,
    description: '',
    status: 'backlog',
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: '',
    artifacts: [],
    attachments: [],
    retries: 0,
    subtype: null,
    assigned_to: null,
    lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    metrics: null,
    estimate: null,
    started_at: null,
    duration_ms: null,
  });
}

let tmpDir: string;
let saivageWorkDir: string;
let store: CardStore;
let sourceDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'saivage-art-'));
  sourceDir = mkdtempSync(join(tmpdir(), 'saivage-art-src-'));
  initProjectTree(tmpDir);
  store = new CardStore(tmpDir);
  saivageWorkDir = join(tmpDir, '.saivage-work');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
});

// ── registerArtifact ──────────────────────────────────────────

describe('registerArtifact', () => {
  it('creates artifact ref and copies file to retained/ directory', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const srcFile = makeSourceFile(sourceDir, 'model.pkl', 'model data');

    const ref = registerArtifact(saivageWorkDir, store, card.id, {
      type: 'model',
      description: 'Trained model',
      retain: true,
    }, srcFile);

    expect(ref.id).toBe(`art-${card.id}-1`);
    expect(ref.card_id).toBe(card.id);
    expect(ref.type).toBe('model');
    expect(ref.description).toBe('Trained model');
    expect(ref.retain).toBe(true);
    expect(ref.created_at).toBeDefined();
    expect(ref.path).toContain('retained/model.pkl');

    // File was copied
    expect(existsSync(ref.path)).toBe(true);
    expect(readFileSync(ref.path, 'utf-8')).toBe('model data');

    // Card was updated
    const updated = store.read(card.id)!;
    expect(updated.artifacts.length).toBe(1);
    expect(updated.artifacts[0].id).toBe(ref.id);
  });

  it('registerArtifact with retain=false puts file in working/ directory', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const srcFile = makeSourceFile(sourceDir, 'output.log', 'log content');

    const ref = registerArtifact(saivageWorkDir, store, card.id, {
      type: 'log',
      description: 'Command output',
      retain: false,
    }, srcFile);

    expect(ref.path).toContain('working/output.log');
    expect(ref.retain).toBe(false);
    expect(existsSync(ref.path)).toBe(true);
  });

  it('throws when card not found', () => {
    const srcFile = makeSourceFile(sourceDir, 'file.txt', 'content');
    expect(() =>
      registerArtifact(saivageWorkDir, store, 'nonexistent', {
        type: 'data',
        description: 'Test',
        retain: true,
      }, srcFile),
    ).toThrow(/not found/);
  });

  it('throws when source file not found', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    expect(() =>
      registerArtifact(saivageWorkDir, store, card.id, {
        type: 'data',
        description: 'Test',
        retain: true,
      }, '/nonexistent/path/file.txt'),
    ).toThrow(/Source file not found/);
  });

  it('throws when source path is a directory', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const sourcePath = join(sourceDir, 'output-dir');
    mkdirSync(sourcePath, { recursive: true });
    expect(() =>
      registerArtifact(saivageWorkDir, store, card.id, {
        type: 'data',
        description: 'Directory output',
        retain: true,
      }, sourcePath),
    ).toThrow(/Source path is not a file/);
  });

  it('generates sequential IDs for multiple artifacts on same card', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const src1 = makeSourceFile(sourceDir, 'a.txt', 'a');
    const src2 = makeSourceFile(sourceDir, 'b.txt', 'b');
    const src3 = makeSourceFile(sourceDir, 'c.txt', 'c');

    const ref1 = registerArtifact(saivageWorkDir, store, card.id, {
      type: 'data',
      description: 'First',
      retain: true,
    }, src1);

    const ref2 = registerArtifact(saivageWorkDir, store, card.id, {
      type: 'data',
      description: 'Second',
      retain: false,
    }, src2);

    const ref3 = registerArtifact(saivageWorkDir, store, card.id, {
      type: 'config',
      description: 'Third',
      retain: true,
    }, src3);

    expect(ref1.id).toBe(`art-${card.id}-1`);
    expect(ref2.id).toBe(`art-${card.id}-2`);
    expect(ref3.id).toBe(`art-${card.id}-3`);

    const updated = store.read(card.id)!;
    expect(updated.artifacts.length).toBe(3);
  });

  it('validates with artifactRefSchema (Zod)', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const srcFile = makeSourceFile(sourceDir, 'data.csv', 'a,b,c');

    const ref = registerArtifact(saivageWorkDir, store, card.id, {
      type: 'report',
      description: 'A report',
      retain: false,
    }, srcFile);

    // Zod validation passed (types match)
    expect(ref.type).toBe('report');
    expect(ref.created_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});

describe('registerEvidenceRefs', () => {
  it('registers multiple artifacts in one card mutation with contiguous ids', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const src1 = makeSourceFile(sourceDir, 'batch-a.txt', 'a');
    const src2 = makeSourceFile(sourceDir, 'batch-b.txt', 'b');
    const before = store.read(card.id)!;

    const result = registerEvidenceRefs(saivageWorkDir, store, card.id, {
      artifacts: [
        { type: 'data', description: 'A', retain: true, sourceFile: src1 },
        { type: 'log', description: 'B', retain: false, sourceFile: src2 },
      ],
    });

    expect(result.artifacts.map((artifact) => artifact.id)).toEqual([
      `art-${card.id}-1`,
      `art-${card.id}-2`,
    ]);
    const updated = store.read(card.id)!;
    expect(updated.version_seq).toBe(before.version_seq + 1);
    expect(updated.artifacts.map((artifact) => artifact.id)).toEqual(result.artifacts.map((artifact) => artifact.id));
    expect(store.listCardHistory(card.id)).toHaveLength(1);
  });

  it('derives ids from locked current card state when another store has a stale snapshot', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const staleStore = new CardStore(tmpDir);
    expect(staleStore.read(card.id)!.artifacts).toHaveLength(0);
    const src1 = makeSourceFile(sourceDir, 'fresh.txt', 'fresh');
    const src2 = makeSourceFile(sourceDir, 'stale.txt', 'stale');

    const first = registerEvidenceRefs(saivageWorkDir, store, card.id, {
      artifacts: [{ type: 'data', description: 'Fresh', retain: true, sourceFile: src1 }],
    });
    const second = registerEvidenceRefs(saivageWorkDir, staleStore, card.id, {
      artifacts: [{ type: 'log', description: 'Stale', retain: false, sourceFile: src2 }],
    });

    expect(first.artifacts[0].id).toBe(`art-${card.id}-1`);
    expect(second.artifacts[0].id).toBe(`art-${card.id}-2`);
    expect(store.read(card.id)!.artifacts.map((artifact) => artifact.id)).toEqual([
      `art-${card.id}-1`,
      `art-${card.id}-2`,
    ]);
  });
});

// ── registerAttachment ────────────────────────────────────────

describe('registerAttachment', () => {
  it('creates attachment ref and copies file to attachments/', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const srcFile = makeSourceFile(
      sourceDir,
      'screenshot.png',
      'fake-png-data',
    );

    const ref = registerAttachment(saivageWorkDir, store, card.id, {
      mime: 'image/png',
      title: 'Screenshot',
      description: 'A test screenshot',
    }, srcFile);

    expect(ref.id).toBe(`att-${card.id}-1`);
    expect(ref.card_id).toBe(card.id);
    expect(ref.mime).toBe('image/png');
    expect(ref.title).toBe('Screenshot');
    expect(ref.description).toBe('A test screenshot');
    expect(ref.created_at).toBeDefined();
    expect(ref.path).toContain('attachments/screenshot.png');

    // File was copied
    expect(existsSync(ref.path)).toBe(true);
    expect(readFileSync(ref.path, 'utf-8')).toBe('fake-png-data');

    // Card was updated
    const updated = store.read(card.id)!;
    expect(updated.attachments.length).toBe(1);
    expect(updated.attachments[0].id).toBe(ref.id);
  });

  it('attachment description is optional', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const srcFile = makeSourceFile(sourceDir, 'icon.svg', '<svg></svg>');

    const ref = registerAttachment(saivageWorkDir, store, card.id, {
      mime: 'image/svg+xml',
      title: 'Icon',
    }, srcFile);

    expect(ref.description).toBeUndefined();
    expect(ref.title).toBe('Icon');
  });

  it('throws when card not found', () => {
    const srcFile = makeSourceFile(sourceDir, 'file.png', 'data');
    expect(() =>
      registerAttachment(saivageWorkDir, store, 'nonexistent', {
        mime: 'image/png',
        title: 'Test',
      }, srcFile),
    ).toThrow(/not found/);
  });

  it('throws when source file not found', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    expect(() =>
      registerAttachment(saivageWorkDir, store, card.id, {
        mime: 'image/png',
        title: 'Test',
      }, '/missing/file.png'),
    ).toThrow(/Source file not found/);
  });

  it('generates sequential IDs for multiple attachments on same card', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const src1 = makeSourceFile(sourceDir, 'img1.png', 'p1');
    const src2 = makeSourceFile(sourceDir, 'img2.png', 'p2');

    const ref1 = registerAttachment(saivageWorkDir, store, card.id, {
      mime: 'image/png',
      title: 'Image 1',
    }, src1);

    const ref2 = registerAttachment(saivageWorkDir, store, card.id, {
      mime: 'image/png',
      title: 'Image 2',
      description: 'Second image',
    }, src2);

    expect(ref1.id).toBe(`att-${card.id}-1`);
    expect(ref2.id).toBe(`att-${card.id}-2`);
  });
});

// ── getArtifacts ──────────────────────────────────────────────

describe('getArtifacts', () => {
  it('returns artifact refs from card', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const src1 = makeSourceFile(sourceDir, 'a.txt', 'a');
    const src2 = makeSourceFile(sourceDir, 'b.txt', 'b');

    registerArtifact(saivageWorkDir, store, card.id, {
      type: 'data',
      description: 'First',
      retain: true,
    }, src1);
    registerArtifact(saivageWorkDir, store, card.id, {
      type: 'log',
      description: 'Second',
      retain: false,
    }, src2);

    const artifacts = getArtifacts(store, card.id);
    expect(artifacts.length).toBe(2);
    expect(artifacts[0].type).toBe('data');
    expect(artifacts[1].type).toBe('log');
  });

  it('throws when card not found', () => {
    expect(() => getArtifacts(store, 'nonexistent')).toThrow(/not found/);
  });
});

// ── getArtifactsByRetention ───────────────────────────────────

describe('getArtifactsByRetention', () => {
  it('filters by retain flag', () => {
    const card = makeCard(store, 'goal', 'Test Goal');

    const src1 = makeSourceFile(sourceDir, 'retained.txt', 'r');
    const src2 = makeSourceFile(sourceDir, 'working.txt', 'w');
    const src3 = makeSourceFile(sourceDir, 'retained2.txt', 'r2');

    registerArtifact(saivageWorkDir, store, card.id, {
      type: 'model',
      description: 'Retained model',
      retain: true,
    }, src1);
    registerArtifact(saivageWorkDir, store, card.id, {
      type: 'log',
      description: 'Working log',
      retain: false,
    }, src2);
    registerArtifact(saivageWorkDir, store, card.id, {
      type: 'config',
      description: 'Retained config',
      retain: true,
    }, src3);

    const retained = getArtifactsByRetention(store, card.id, true);
    expect(retained.length).toBe(2);
    expect(retained.every((a) => a.retain === true)).toBe(true);

    const working = getArtifactsByRetention(store, card.id, false);
    expect(working.length).toBe(1);
    expect(working[0].retain).toBe(false);
  });

  it('returns empty array when no artifacts match retention', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const src = makeSourceFile(sourceDir, 'retained.txt', 'r');
    registerArtifact(saivageWorkDir, store, card.id, {
      type: 'data',
      description: 'Only retained',
      retain: true,
    }, src);

    const working = getArtifactsByRetention(store, card.id, false);
    expect(working).toEqual([]);
  });
});

// ── getAttachments ────────────────────────────────────────────

describe('getAttachments', () => {
  it('returns attachment refs from card', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const src = makeSourceFile(sourceDir, 'img.png', 'png');
    registerAttachment(saivageWorkDir, store, card.id, {
      mime: 'image/png',
      title: 'Test image',
    }, src);

    const attachments = getAttachments(store, card.id);
    expect(attachments.length).toBe(1);
    expect(attachments[0].mime).toBe('image/png');
    expect(attachments[0].title).toBe('Test image');
  });

  it('throws when card not found', () => {
    expect(() => getAttachments(store, 'nonexistent')).toThrow(/not found/);
  });
});

// ── removeArtifact ────────────────────────────────────────────

describe('removeArtifact', () => {
  it('removes ref from card (no file deletion)', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const src = makeSourceFile(sourceDir, 'data.txt', 'data');
    const ref = registerArtifact(saivageWorkDir, store, card.id, {
      type: 'data',
      description: 'Remove me',
      retain: true,
    }, src);

    const removed = removeArtifact(saivageWorkDir, store, card.id, ref.id);
    expect(removed).toBe(true);

    const updated = store.read(card.id)!;
    expect(updated.artifacts.length).toBe(0);

    // File still exists (removeFile defaults to false)
    expect(existsSync(ref.path)).toBe(true);
  });

  it('removes ref and deletes file when removeFile=true', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const src = makeSourceFile(sourceDir, 'data.txt', 'data');
    const ref = registerArtifact(saivageWorkDir, store, card.id, {
      type: 'data',
      description: 'Delete me',
      retain: false,
    }, src);

    expect(existsSync(ref.path)).toBe(true);

    const removed = removeArtifact(
      saivageWorkDir,
      store,
      card.id,
      ref.id,
      true,
    );
    expect(removed).toBe(true);

    const updated = store.read(card.id)!;
    expect(updated.artifacts.length).toBe(0);
    expect(existsSync(ref.path)).toBe(false);
  });

  it('returns false when artifact not found', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const result = removeArtifact(
      saivageWorkDir,
      store,
      card.id,
      'art-nonexistent-1',
    );
    expect(result).toBe(false);
  });

  it('throws when card not found', () => {
    expect(() =>
      removeArtifact(saivageWorkDir, store, 'nonexistent', 'art-x-1'),
    ).toThrow(/not found/);
  });

  it('only removes the specified artifact, leaves others intact', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const src1 = makeSourceFile(sourceDir, 'keep.txt', 'k');
    const src2 = makeSourceFile(sourceDir, 'drop.txt', 'd');

    const ref1 = registerArtifact(saivageWorkDir, store, card.id, {
      type: 'data',
      description: 'Keep',
      retain: true,
    }, src1);
    const ref2 = registerArtifact(saivageWorkDir, store, card.id, {
      type: 'log',
      description: 'Drop',
      retain: false,
    }, src2);

    removeArtifact(saivageWorkDir, store, card.id, ref2.id, true);

    const updated = store.read(card.id)!;
    expect(updated.artifacts.length).toBe(1);
    expect(updated.artifacts[0].id).toBe(ref1.id);
    expect(existsSync(ref1.path)).toBe(true);
    expect(existsSync(ref2.path)).toBe(false);
  });
});

// ── removeAttachment ──────────────────────────────────────────

describe('removeAttachment', () => {
  it('removes ref from card (no file deletion)', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const src = makeSourceFile(sourceDir, 'img.png', 'data');
    const ref = registerAttachment(saivageWorkDir, store, card.id, {
      mime: 'image/png',
      title: 'Remove me',
    }, src);

    const removed = removeAttachment(
      saivageWorkDir,
      store,
      card.id,
      ref.id,
    );
    expect(removed).toBe(true);

    const updated = store.read(card.id)!;
    expect(updated.attachments.length).toBe(0);

    // File still exists (removeFile defaults to false)
    expect(existsSync(ref.path)).toBe(true);
  });

  it('removes ref and deletes file when removeFile=true', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const src = makeSourceFile(sourceDir, 'doc.html', '<html></html>');
    const ref = registerAttachment(saivageWorkDir, store, card.id, {
      mime: 'text/html',
      title: 'Doc',
    }, src);

    expect(existsSync(ref.path)).toBe(true);

    const removed = removeAttachment(
      saivageWorkDir,
      store,
      card.id,
      ref.id,
      true,
    );
    expect(removed).toBe(true);

    expect(existsSync(ref.path)).toBe(false);
  });

  it('returns false when attachment not found', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const result = removeAttachment(
      saivageWorkDir,
      store,
      card.id,
      'att-nonexistent-1',
    );
    expect(result).toBe(false);
  });

  it('throws when card not found', () => {
    expect(() =>
      removeAttachment(saivageWorkDir, store, 'nonexistent', 'att-x-1'),
    ).toThrow(/not found/);
  });

  it('only removes the specified attachment, leaves others intact', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const src1 = makeSourceFile(sourceDir, 'keep.png', 'k');
    const src2 = makeSourceFile(sourceDir, 'drop.png', 'd');

    const ref1 = registerAttachment(saivageWorkDir, store, card.id, {
      mime: 'image/png',
      title: 'Keep',
    }, src1);
    const ref2 = registerAttachment(saivageWorkDir, store, card.id, {
      mime: 'image/png',
      title: 'Drop',
    }, src2);

    removeAttachment(saivageWorkDir, store, card.id, ref2.id, true);

    const updated = store.read(card.id)!;
    expect(updated.attachments.length).toBe(1);
    expect(updated.attachments[0].id).toBe(ref1.id);
    expect(existsSync(ref1.path)).toBe(true);
    expect(existsSync(ref2.path)).toBe(false);
  });
});

// ── Edge Cases ────────────────────────────────────────────────

describe('Edge Cases', () => {
  it('handles source files with paths containing special characters', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const srcFile = makeSourceFile(sourceDir, 'my-file_v1.0.txt', 'special');

    const ref = registerArtifact(saivageWorkDir, store, card.id, {
      type: 'other',
      description: 'Special chars in name',
      retain: true,
    }, srcFile);

    expect(existsSync(ref.path)).toBe(true);
    expect(ref.path).toContain('my-file_v1.0.txt');
  });

  it('ID sequences are independent between artifacts and attachments', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const artSrc = makeSourceFile(sourceDir, 'art.txt', 'a');
    const attSrc = makeSourceFile(sourceDir, 'att.png', 'b');

    const art = registerArtifact(saivageWorkDir, store, card.id, {
      type: 'data',
      description: 'Art',
      retain: true,
    }, artSrc);
    const att = registerAttachment(saivageWorkDir, store, card.id, {
      mime: 'image/png',
      title: 'Att',
    }, attSrc);

    expect(art.id).toBe(`art-${card.id}-1`);
    expect(att.id).toBe(`att-${card.id}-1`);
  });

  it('removing an artifact then registering another uses the next available seq', () => {
    const card = makeCard(store, 'goal', 'Test Goal');
    const src1 = makeSourceFile(sourceDir, 'first.txt', '1');
    const src2 = makeSourceFile(sourceDir, 'second.txt', '2');
    const src3 = makeSourceFile(sourceDir, 'third.txt', '3');

    const ref1 = registerArtifact(saivageWorkDir, store, card.id, {
      type: 'data',
      description: 'First',
      retain: true,
    }, src1);

    const ref2 = registerArtifact(saivageWorkDir, store, card.id, {
      type: 'data',
      description: 'Second',
      retain: true,
    }, src2);

    // Remove ref2 (seq 2)
    removeArtifact(saivageWorkDir, store, card.id, ref2.id, true);

    // Register new — should be seq 2 (next after existing max: 1)
    const ref3 = registerArtifact(saivageWorkDir, store, card.id, {
      type: 'data',
      description: 'Third',
      retain: false,
    }, src3);

    expect(ref3.id).toBe(`art-${card.id}-2`);
    // ref1 still exists
    const updated = store.read(card.id)!;
    expect(updated.artifacts.length).toBe(2);
    expect(updated.artifacts.map((a) => a.id).sort()).toEqual(
      [ref1.id, ref3.id].sort(),
    );
  });
});
