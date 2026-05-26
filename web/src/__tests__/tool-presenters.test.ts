import { describe, it, expect } from 'vitest';
import { presentToolCall, presentToolResult } from '../utils/tool-presenters';

function makeCall(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ toolCalls: [{ id: `call-${name}`, function: { name, arguments: JSON.stringify(args) } }] });
}
function text(parts: Array<{ kind: string; text?: string; path?: string; label?: string }>): string {
  return parts.map((part) => part.text ?? part.label ?? part.path ?? '').join('');
}

describe('presentToolCall', () => {
  it('renders project paths as text and meta/output paths as file parts', () => {
    expect(presentToolCall(makeCall('read_project_file', { path: 'src/foo.ts' })).headline).toEqual([{ kind: 'text', text: 'src/foo.ts' }]);
    expect(presentToolCall(makeCall('read_file', { path: '.saivage/plan.json' })).headline[0]).toMatchObject({ kind: 'file', root: 'meta', path: '.saivage/plan.json' });
    expect(presentToolCall(makeCall('read_file', { path: '.saivage-work/output.txt' })).headline[0]).toMatchObject({ kind: 'file', root: 'output', path: '.saivage-work/output.txt' });
  });

  it('renders write_project_file with char count detail', () => {
    const view = presentToolCall(makeCall('write_project_file', { path: 'src/foo.ts', content: 'hello world' }));
    expect(view.icon).toBe('✏️');
    expect(text(view.headline)).toBe('src/foo.ts');
    expect(text(view.detail ?? [])).toBe('11 chars');
    expect(view.bodyKind).toBe('json');
  });

  it('falls back to generic preview for unknown tools', () => {
    const view = presentToolCall(makeCall('some_custom_tool', { foo: 1, bar: 2 }));
    expect(view.icon).toBe('🔧');
    expect(view.name).toBe('some_custom_tool');
    expect(text(view.headline)).toBe('(foo, bar)');
  });
});

describe('presentToolResult', () => {
  it('formats read_project_file result with line and byte counts', () => {
    const view = presentToolResult(JSON.stringify({ ok: true, content: 'line1\nline2\nline3', bytes: 17 }), { tool: 'read_project_file' });
    expect(view.status).toBe('ok');
    expect(text(view.headline)).toContain('3 lines');
    expect(text(view.headline)).toContain('17 B');
  });

  it('formats run_project_command result with exit code and process id', () => {
    const view = presentToolResult(JSON.stringify({ ok: true, exitCode: 0, status: 'exited', id: 'p-123' }), { tool: 'run_project_command' });
    expect(text(view.headline)).toContain('exit 0');
    expect(text(view.headline)).toContain('exited');
    expect(text(view.detail ?? [])).toBe('process p-123');
  });

  it('renders error results with the error icon and message', () => {
    const view = presentToolResult(JSON.stringify({ ok: false, error: 'boom' }), { tool: 'run_project_command' });
    expect(view.status).toBe('error');
    expect(text(view.headline)).toBe('boom');
  });
});
