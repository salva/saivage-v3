import { describe, expect, it } from 'vitest';
import { presentToolResult } from '../../utils/tool-presenters';
const data = { kind: 'text', redacted_url: 'https://example.test/?[REDACTED]', status: 200, headers: {}, head: 'first\nsecond', head_utf8_bytes: 12, redacted_text_utf8_bytes: 40, head_complete: false, fetch_truncated: true, content_url: 'work:///tmp/stash/webfetch-1-0123456789abcdef.txt' };
const present = (value: unknown) => presentToolResult(JSON.stringify({ success: true, data: value }), { tool: 'webfetch' });
describe('web evidence and distinct save effects', () => {
  it('exposes top-level record save refusal facts returned by the actual producer', () => {
    const view = presentToolResult(JSON.stringify({ success: false, error: 'Record mutation is not authorized.', data: { code: 'record_mutation_denied', card_id: 'card-a', name: 'brief.md', operation: 'write', reason: 'cross_card_scope' } }), { tool: 'webfetch' });
    expect(view.outcome).toBe('Failed · Refused');
    expect(JSON.stringify(view.sections)).toContain('cross_card_scope');
    const mutation = view.sections.find((s) => s.title === 'Record mutation')!;
    expect(mutation.fields?.map((f) => f.label)).toEqual(['card id', 'name', 'code', 'reason']);
    expect(JSON.stringify(view.sections)).toContain('operation');
    expect(JSON.stringify(view.sections)).not.toContain('Accepted version');
  });
  it('exposes the returned text head and coverage with only the actual supported artifact link', () => {
    const view = present(data);
    expect(view.sections.find((s) => s.title === 'Recorded text head')?.content).toBe('first\nsecond');
    expect(JSON.stringify(view.sections)).toContain('head complete');
    expect(view.outcome).toContain('Fetch truncated');
    expect(view.outcome).toContain('Text head incomplete');
    expect(JSON.stringify(view.sections)).toContain('.saivage/work/tmp/stash/webfetch-1-0123456789abcdef.txt');
  });
  it.each(['project:///tmp/stash/webfetch-1-0123456789abcdef.txt', 'work:///tmp/stash/webfetch-1-0123456789abcdef.txt?x=1', 'work:///tmp/stash/%77ebfetch-1-0123456789abcdef.txt'])('does not invent a link for %s', (content_url) => {
    expect(present({ ...data, content_url }).sections.some((s) => s.title === 'Returned text artifact')).toBe(false);
  });
  it('does not equate saved_as with record acceptance; consumes nested record write data', () => {
    const record = { card_id: 'card-a', name: 'brief.md', state: 'open', surface: 'card_agent', revision: 7, head_id: 'head', current_url: 'record:///brief.md?card=card-a', accepted_version_url: 'record:///brief.md?card=card-a&v=4', bytes: 10, written: true };
    expect(JSON.stringify(present({ saved_as: record.current_url }).sections)).not.toContain('Draft updated');
    const view = present({ saved_as: record.current_url, write: { kind: 'record', data: record } });
    expect(view.outcome).toContain('Draft updated');
    expect(JSON.stringify(view.sections)).toContain('Retained accepted version');
    const file = present({ saved_as: 'saved.txt', write: { kind: 'workspace_file', data: { destination_kind: 'project_relative', target: 'saved.txt', written: true, bytes: 10 } } });
    expect(JSON.stringify(file.sections)).toContain('workspace_file');
    expect(JSON.stringify(file.sections)).not.toContain('Accepted version');
  });
  it('distinguishes metadata and omitted binary content', () => {
    expect(present({ metadata_only: true, status: 200 }).outcome).toBe('Metadata only');
    expect(present({ binary: true, content: null, bytes: 40 }).outcome).toBe('Binary content omitted');
  });
});
