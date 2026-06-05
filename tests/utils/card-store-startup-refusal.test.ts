import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';
import type { CardRecord } from '../../src/schemas/types.js';

function writeCard(root: string, card: CardRecord): void {
  writeFileSync(
    join(root, '.saivage', 'cards', 'by-id', `${card.id}.json`),
    JSON.stringify(card, null, 2),
  );
}

describe('CardStore startup refusal for legacy cards', () => {
  it('fails with actionable saivage reset error when version_seq is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'card-legacy-'));
    try {
      initProjectTree(root);
      materializeProjectCard(root);
      const legacyPath = join(root, '.saivage', 'cards', 'by-id', 'project.json');
      const legacy = JSON.parse(readFileSync(legacyPath, 'utf-8')) as Record<string, unknown>;
      delete legacy.version_seq;
      writeFileSync(legacyPath, JSON.stringify(legacy, null, 2));
      expect(() => new CardStore(root)).toThrow(/is invalid|version_seq/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs non-contiguous sibling positions at boot instead of refusing', () => {
    const root = mkdtempSync(join(tmpdir(), 'card-position-gap-'));
    try {
      initProjectTree(root);
      materializeProjectCard(root);
      const setup = new CardStore(root);
      const a = setup.create({
        type: 'goal',
        parent: 'project',
        depth: 1,
        title: 'A',
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
      });
      const b = setup.create({ ...a, id: undefined, title: 'B' });
      const c = setup.create({ ...a, id: undefined, title: 'C' });
      writeCard(root, { ...a, position: 0 });
      writeCard(root, { ...b, position: 1 });
      writeCard(root, { ...c, position: 3 });

      const store = new CardStore(root);
      const positions = store
        .listChildren('project')
        .map((id) => store.read(id)!.position)
        .sort((x, y) => x - y);
      expect(positions).toEqual([0, 1, 2]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs duplicate sibling positions at boot deterministically', () => {
    const root = mkdtempSync(join(tmpdir(), 'card-position-duplicate-'));
    try {
      initProjectTree(root);
      materializeProjectCard(root);
      const setup = new CardStore(root);
      const a = setup.create({
        type: 'goal',
        parent: 'project',
        depth: 1,
        title: 'A',
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
      });
      const b = setup.create({ ...a, id: undefined, title: 'B' });
      writeCard(root, { ...a, position: 0, created_at: '2026-01-01T00:00:00.000Z' });
      writeCard(root, { ...b, position: 0, created_at: '2026-01-01T00:00:01.000Z' });

      const store = new CardStore(root);
      const positions = store
        .listChildren('project')
        .map((id) => store.read(id)!.position)
        .sort((x, y) => x - y);
      expect(positions).toEqual([0, 1]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
