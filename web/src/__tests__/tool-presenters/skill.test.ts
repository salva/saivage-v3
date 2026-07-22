import { describe, expect, it } from 'vitest';
import { presentToolResult } from '../../utils/tool-presenters';
import { inlineText } from './_helpers';

function present(envelope: unknown) {
  return presentToolResult(JSON.stringify(envelope), { tool: 'skill' });
}

describe('skill result presenter', () => {
  it.each([
    [[], '0 skills'],
    [[{ name: 'one' }], '1 skill'],
    [[{ name: 'one' }, { name: 'two' }], '2 skills'],
  ])('counts complete list envelopes', (skills, headline) => {
    const view = present({ success: true, data: { skills } });

    expect(view).toMatchObject({ name: 'skill', status: 'ok' });
    expect(inlineText(view.headline)).toBe(headline);
  });

  it('recognizes a complete named-load envelope', () => {
    const view = present({ success: true, data: { skill_name: 'one', skill_content: 'exact text' } });

    expect(view).toMatchObject({ name: 'skill', status: 'ok' });
    expect(inlineText(view.headline)).toBe('skill loaded');
  });

  it('uses a semantic success fallback for an unexpected projection', () => {
    const view = present({ success: true, data: { unexpected: true } });

    expect(view).toMatchObject({ name: 'skill', status: 'ok' });
    expect(inlineText(view.headline)).toBe('skills loaded');
  });

  it('keeps failed envelopes on the generic error path', () => {
    const view = present({ success: false, error: 'unavailable' });

    expect(view).toMatchObject({
      icon: '⚠',
      name: 'skill',
      status: 'error',
      headline: [{ kind: 'text', text: 'unavailable' }],
    });
  });
});
