import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cardRecordSchema } from '../../src/schemas/index.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('card record hierarchy shape', () => {
  it('rejects duplicate children at schema parsing', () => {
    const project = fixture().cards.read('project')!;
    expect(() => cardRecordSchema.parse({ ...project, children: ['card-a', 'card-a'] })).toThrow(/unique immediate hierarchical children/);
  });

  it.each(['card-a-a-a', 'project'] as const)('rejects non-direct or ancestor child %s at schema parsing', (childId) => {
    const { cards } = fixture();
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    expect(() => cardRecordSchema.parse({ ...child, children: [childId] })).toThrow(/unique immediate hierarchical children/);
  });
});

function fixture(): { cards: CardService } {
  const root = mkdtempSync(join(tmpdir(), 'card-record-schema-')); roots.push(root); initProjectTree(root);
  return { cards: new CardService(root) };
}
