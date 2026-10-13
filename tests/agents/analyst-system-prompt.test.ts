import { describe, expect, it } from '@jest/globals';

import { buildAnalystWorkspaceFocus } from '../../src/application/read-models/analyst-workspace-focus.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';
import { formatVocabularySnippet } from '../../src/tools/prompt-api.js';

describe('analyst workspace-context prompt contract', () => {
  it('renders the global Analyst with its selected vocabulary and no unresolved placeholders', () => {
    const prompt = createTestPromptTemplateRegistry().render({kind:'global-agent'}, 'analyst', {
      vocabularySnippet: formatVocabularySnippet(['project','goal','architecture','code','test','doc','data','research','ops']),
    });
    expect(prompt).toContain(formatVocabularySnippet(['project','goal','architecture','code','test','doc','data','research','ops']));
    expect(prompt).not.toMatch(/\{\{[^}]+\}\}/u);
  });

  it('renders the no-entity workspace-context fixture deterministically', () => {
    expect(buildAnalystWorkspaceFocus(undefined, [])).toMatchObject({ kind: 'rendered', content: expect.stringContaining('no_focus') });
    expect(buildAnalystWorkspaceFocus({ view: null, entityId: null, refinement: null }, [])).toMatchObject({ kind: 'rendered', content: expect.stringContaining('no_focus') });
  });

  it('renders a populated workspace-context fixture deterministically', () => {
    expect(buildAnalystWorkspaceFocus({ view: 'cockpit', entityId: 'card-a', refinement: { tab: 'plan', filter: 'open' } }, [])).toMatchObject({ kind: 'rendered', content: expect.stringContaining('"focus":"unavailable"') });
  });
});
