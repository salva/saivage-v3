import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService, initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { cardChildrenRoot } from '../../src/persistence/layout.js';
import { listCards } from '../../src/persistence/card-files.js';
import { cardDepth, MAX_CARD_DEPTH } from '../../src/schemas/card-id.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

const childInput = (parent: string, type: 'goal' | 'code') => ({
  type,
  parent,
  title: `${type} child`,
  bootstrap_content: `${type} child brief.`,
  tags: [],
  priority: 0,
  urgency: 'normal' as const,
  created_by: 'planner' as const,
  depends_on: [],
  related: [],
});

describe('CardService maximum depth admission', () => {
  it('allows only a leaf at depth twelve and rejects both boundaries before effects', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-depth-'));
    roots.push(root);
    initProjectTree(root);
    const cardProjectionChanged = jest.fn();
    const runtimeChanged = jest.fn();
    const agentMembershipChanged = jest.fn();
    const cards = new CardService(root, { cardProjectionChanged, runtimeChanged, agentMembershipChanged });

    let parent = 'project';
    for (let depth = 1; depth < MAX_CARD_DEPTH; depth += 1) parent = cards.create(childInput(parent, 'goal')).id;
    expect(cardDepth(parent)).toBe(11);
    const effectsBeforeBoundaryChecks = {
      card: cardProjectionChanged.mock.calls.length,
      runtime: runtimeChanged.mock.calls.length,
      membership: agentMembershipChanged.mock.calls.length,
    };

    expect(() => cards.create(childInput(parent, 'goal'))).toThrow("Cannot create non-leaf child type 'goal' at maximum card depth 12.");
    expect(existsSync(cardChildrenRoot(root, parent))).toBe(false);
    expect(cardProjectionChanged).toHaveBeenCalledTimes(effectsBeforeBoundaryChecks.card);
    expect(runtimeChanged).toHaveBeenCalledTimes(effectsBeforeBoundaryChecks.runtime);
    expect(agentMembershipChanged).toHaveBeenCalledTimes(effectsBeforeBoundaryChecks.membership);

    const leaf = cards.create(childInput(parent, 'code'));
    expect(cardDepth(leaf.id)).toBe(MAX_CARD_DEPTH);
    expect(listCards(root).map((card) => card.id)).toContain(leaf.id);
    const effectsAfterLeaf = {
      card: cardProjectionChanged.mock.calls.length,
      runtime: runtimeChanged.mock.calls.length,
      membership: agentMembershipChanged.mock.calls.length,
    };

    expect(() => cards.create({ ...childInput(leaf.id, 'goal'), depends_on: ['missing-card'] })).toThrow('Cannot create card at depth 13. Maximum allowed depth is 12.');
    expect(existsSync(cardChildrenRoot(root, leaf.id))).toBe(false);
    expect(cardProjectionChanged).toHaveBeenCalledTimes(effectsAfterLeaf.card);
    expect(runtimeChanged).toHaveBeenCalledTimes(effectsAfterLeaf.runtime);
    expect(agentMembershipChanged).toHaveBeenCalledTimes(effectsAfterLeaf.membership);
    expect(TEST_WORKFLOWS.cardTypes.get('code')!.permittedChildTypes.size).toBe(0);
  });
});
