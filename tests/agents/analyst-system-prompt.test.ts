import { describe, expect, it } from '@jest/globals';

import { buildAnalystWorkspaceFocus } from '../../src/application/read-models/analyst-workspace-focus.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';
import { formatVocabularySnippet } from '../../src/tools/prompt-api.js';

describe('analyst workspace-context prompt contract', () => {
  it('includes the referent-resolution rules in the rendered system prompt', () => {
    const prompt = createTestPromptTemplateRegistry().render({kind:'global-agent'}, 'analyst', {
      vocabularySnippet: formatVocabularySnippet(['project','goal','architecture','code','test','doc','data','research','ops']),
    });
    expect(prompt).toContain('analyst.workspace_focus');
    expect(prompt).toContain('ask exactly one clarifying question');
    expect(prompt).toContain('reopening done, failed, or blocked cards to changed without editing content');
    expect(prompt).toContain('Reopenable card status: blocked | done | failed. Reopen target status: changed');
    expect(prompt).toContain('its configured designated recipient should resolve the issue');
    expect(prompt).not.toContain('its planner/executor should resolve the issue');
    expect(prompt).toContain('Roles and session IDs are not notification targets.');
    expect(prompt).toContain('perform planner/executor work');
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
