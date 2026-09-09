import { describe, expect, it } from '@jest/globals';

import { buildWorkspaceContextNote } from '../../src/agents/analyst-handler.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';
import { formatVocabularySnippet } from '../../src/agents/analyst-prompt.js';

describe('analyst workspace-context prompt contract', () => {
  it('includes the deictic-resolution paragraph in the rendered system prompt', () => {
    const prompt = createTestPromptTemplateRegistry().render({kind:'global-agent'}, 'analyst', {
      vocabularySnippet: formatVocabularySnippet(['project','goal','architecture','code','test','doc','data','research','ops']),
    });
    expect(prompt).toContain('Resolve deictic phrases');
    expect(prompt).toContain('workspace context');
    expect(prompt).toContain('none — no entity is currently in focus');
    expect(prompt).toContain('ask exactly one clarifying question');
    expect(prompt).toContain('reopening done, failed, or blocked cards to changed without editing content');
    expect(prompt).toContain('Reopenable card status: blocked | done | failed. Reopen target status: changed');
    expect(prompt).toContain('its configured current/next workflow-node agent should resolve the issue');
    expect(prompt).not.toContain('its planner/executor should resolve the issue');
    expect(prompt).toContain('Roles and session IDs are not notification targets.');
    expect(prompt).toContain('perform planner/executor work');
    expect(prompt).not.toMatch(/\{\{[^}]+\}\}/u);
  });

  it('renders the no-entity workspace-context fixture deterministically', () => {
    expect(buildWorkspaceContextNote()).toBe('[workspace-context] none — no entity is currently in focus');
    expect(buildWorkspaceContextNote({ view: null, entityId: null, refinement: null })).toBe('[workspace-context] none — no entity is currently in focus');
  });

  it('renders a populated workspace-context fixture deterministically', () => {
    expect(buildWorkspaceContextNote({ view: 'cards', entityId: '33333333-3333-4333-8333-333333333333', refinement: { tab: 'plan', filter: 'open' } })).toBe([
      '[workspace-context]',
      'view: cards',
      'entity: 33333333-3333-4333-8333-333333333333',
      'refinement: tab=plan;filter=open',
    ].join('\n'));
  });
});
