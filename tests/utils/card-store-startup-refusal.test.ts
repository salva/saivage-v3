import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';

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
});
