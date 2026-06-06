import { describe, expect, it } from '@jest/globals';

import { buildWorkspaceContextNote } from '../../src/agents/analyst-handler.js';
import { getAnalystSystemPrompt } from '../../src/agents/analyst-prompt.js';

describe('analyst workspace-context prompt contract', () => {
  it('includes the deictic-resolution paragraph in the rendered system prompt', () => {
    const prompt = getAnalystSystemPrompt();
    expect(prompt).toContain('Resolve deictic phrases');
    expect(prompt).toContain('[workspace-context] header');
    expect(prompt).toContain('none — no entity is currently in focus');
    expect(prompt).toContain('ask exactly one clarifying question');
  });

  it('renders the no-entity workspace-context fixture deterministically', () => {
    expect(buildWorkspaceContextNote()).toBe('[workspace-context] none — no entity is currently in focus');
    expect(buildWorkspaceContextNote({ view: null, entityId: null, refinement: null })).toBe('[workspace-context] none — no entity is currently in focus');
  });

  it('renders a populated workspace-context fixture deterministically', () => {
    expect(buildWorkspaceContextNote({ view: 'cards', entityId: 'card-3', refinement: { tab: 'plan', filter: 'open' } })).toBe([
      '[workspace-context]',
      'view: cards',
      'entity: card-3',
      'refinement: tab=plan;filter=open',
    ].join('\n'));
  });
});
