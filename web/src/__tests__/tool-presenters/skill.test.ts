import { describe, expect, it } from 'vitest';
import { presentToolResult } from '../../utils/tool-presenters';
describe('skill evidence', () => {
  it('exposes recorded skill instructions before safe original inspection', () => {
    const view = presentToolResult('{"success":true,"data":{"skill_name":"review","skill_content":"Exact instructions\\nlast"}}', { tool: 'skill' });
    expect(view.sections.find((s) => s.title === 'Skill instructions')?.content).toBe('Exact instructions\nlast');
  });
  it('exposes names and descriptions in a recorded catalog', () => {
    const view = presentToolResult('{"success":true,"data":{"skills":[{"name":"review","description":"How to review"}]}}', { tool: 'skill' });
    expect(JSON.stringify(view.sections)).toContain('How to review');
  });
});
