import { describe, expect, it } from '@jest/globals';

import { buildWorkspaceContextNote } from '../../src/agents/analyst-handler.js';
import { ANALYST_TOOL_DEFINITIONS } from '../../src/tools/analyst-tool-registry.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';
import { formatVocabularySnippet } from '../../src/agents/analyst-prompt.js';
import { formatPromptToolList } from '../../src/utils/prompt-api.js';

describe('analyst workspace-context prompt contract', () => {
  it('includes the deictic-resolution paragraph in the rendered system prompt', () => {
    const prompt = createTestPromptTemplateRegistry().render('analyst', 'analyst', {
      toolList: formatPromptToolList(ANALYST_TOOL_DEFINITIONS),
      vocabularySnippet: formatVocabularySnippet(),
      projectContext: '{"projectRoot":"test"}',
    });
    expect(prompt).toContain('Resolve deictic phrases');
    expect(prompt).toContain('workspace context');
    expect(prompt).toContain('none — no entity is currently in focus');
    expect(prompt).toContain('ask exactly one clarifying question');
    expect(prompt).toContain('{"projectRoot":"test"}');
    expect(prompt).toContain('Registered tools:');
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
