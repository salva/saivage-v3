import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cardRecordSchema, outboundCardRecordSchema } from '../../src/schemas/index.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('card record hierarchy shape', () => {
  it.each(['child_membership', 'active_child_order'] as const)('rejects duplicate %s at schema parsing', (field) => {
    const project = fixture().cards.read('project')!;
    const parsed = cardRecordSchema.safeParse({ ...project, child_membership: ['card-a'], active_child_order: ['card-a'], [field]: ['card-a', 'card-a'] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: [field], message: `Card ${field} must be duplicate-free.` })]));
  });

  it.each(['child_membership', 'active_child_order'] as const)('rejects non-direct ids in %s at schema parsing', (field) => {
    const { cards } = fixture();
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const parsed = cardRecordSchema.safeParse({ ...child, child_membership: ['card-a-a-a'], active_child_order: ['card-a-a-a'], [field]: ['project'] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: [field], message: `Card ${field} must contain only direct child ids.` })]));
  });

  it.each([
    { child_membership: ['card-a'], active_child_order: [] },
    { child_membership: ['card-a'], active_child_order: ['card-b'] },
  ])('rejects unequal relationship sets %#', (relationships) => {
    const project = fixture().cards.read('project')!;
    const parsed = cardRecordSchema.safeParse({ ...project, ...relationships });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['active_child_order'], message: 'Card child_membership and active_child_order must contain the same ids.' })]));
  });

  it('strictly rejects the old children field and missing current relationship fields', () => {
    const project = fixture().cards.read('project')!;
    expect(() => cardRecordSchema.parse({ ...project, children: [] })).toThrow();
    const { child_membership: _membership, ...missingMembership } = project;
    const { active_child_order: _order, ...missingOrder } = project;
    expect(() => cardRecordSchema.parse(missingMembership)).toThrow();
    expect(() => cardRecordSchema.parse(missingOrder)).toThrow();
  });

  it.each(['tags', 'related'] as const)('strictly rejects removed %s on durable and outbound records', (field) => {
    const project = fixture().cards.read('project')!;
    const { pending_notifications: _pending, ...outbound } = project;
    expect(cardRecordSchema.safeParse({ ...project, [field]: [] }).success).toBe(false);
    expect(outboundCardRecordSchema.safeParse({ ...outbound, [field]: [] }).success).toBe(false);
  });

  it('keeps pending notifications required only on the durable record and forbidden on the outbound record', () => {
    const project = fixture().cards.read('project')!;
    const { pending_notifications: _pending, ...outbound } = project;
    expect(cardRecordSchema.safeParse(outbound).success).toBe(false);
    expect(outboundCardRecordSchema.parse(outbound)).toEqual(outbound);
    expect(outboundCardRecordSchema.safeParse(project).success).toBe(false);
  });
});

function fixture(): { cards: CardService } {
  const root = mkdtempSync(join(tmpdir(), 'card-record-schema-')); roots.push(root); initProjectTree(root);
  return { cards: new CardService(root) };
}
