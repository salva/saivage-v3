import { describe, it, expect } from 'vitest';
import { presentToolCall, presentToolResult } from '../utils/tool-presenters';

function makeCall(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ toolCalls: [{ id: `call-${name}`, function: { name, arguments: JSON.stringify(args) } }] });
}

describe('presentToolCall', () => {
  it('renders read_project_file as a file read with path', () => {
    const view = presentToolCall(makeCall('read_project_file', { path: 'src/foo.ts' }));
    expect(view.icon).toBe('📖');
    expect(view.name).toBe('read_project_file');
    expect(view.headline).toBe('src/foo.ts');
  });

  it('renders write_project_file with byte count detail', () => {
    const view = presentToolCall(makeCall('write_project_file', { path: 'src/foo.ts', content: 'hello world' }));
    expect(view.icon).toBe('✏️');
    expect(view.headline).toBe('src/foo.ts');
    expect(view.detail).toBe('11 chars');
  });

  it('renders run_project_command with truncated command', () => {
    const view = presentToolCall(makeCall('run_project_command', { command: 'npm test --runInBand' }));
    expect(view.icon).toBe('⚡');
    expect(view.headline).toBe('npm test --runInBand');
  });

  it('renders activate_card with card id', () => {
    const view = presentToolCall(makeCall('activate_card', { cardId: 'G3' }));
    expect(view.icon).toBe('▶');
    expect(view.headline).toBe('card G3');
  });

  it('renders report_goal_done with status text', () => {
    const view = presentToolCall(makeCall('report_goal_done', { status_text: 'all stages complete', evidence_card_ids: ['G3-C1'] }));
    expect(view.icon).toBe('✅');
    expect(view.headline).toBe('all stages complete');
  });

  it('falls back to generic preview for unknown tools', () => {
    const view = presentToolCall(makeCall('some_custom_tool', { foo: 1, bar: 2 }));
    expect(view.icon).toBe('🔧');
    expect(view.name).toBe('some_custom_tool');
    expect(view.headline).toBe('(foo, bar)');
  });

  it('uses the fallback name when the body lacks a function name', () => {
    const view = presentToolCall(JSON.stringify({ toolCalls: [{}] }), 'activate_card');
    expect(view.name).toBe('activate_card');
  });
});

describe('presentToolResult', () => {
  it('formats read_project_file result with line and byte counts', () => {
    const view = presentToolResult(JSON.stringify({ ok: true, content: 'line1\nline2\nline3', bytes: 17 }), { tool: 'read_project_file' });
    expect(view.status).toBe('ok');
    expect(view.headline).toContain('3 lines');
    expect(view.headline).toContain('17 B');
  });

  it('formats run_project_command result with exit code and process id', () => {
    const view = presentToolResult(
      JSON.stringify({ ok: true, exitCode: 0, status: 'exited', id: 'p-123' }),
      { tool: 'run_project_command' },
    );
    expect(view.headline).toContain('exit 0');
    expect(view.headline).toContain('exited');
    expect(view.detail).toBe('process p-123');
  });

  it('formats list_project_files result with entry count', () => {
    const view = presentToolResult(JSON.stringify({ ok: true, entries: [1, 2, 3, 4] }), { tool: 'list_project_files' });
    expect(view.headline).toBe('4 entries');
  });

  it('renders error results with the error icon and message', () => {
    const view = presentToolResult(JSON.stringify({ ok: false, error: 'boom' }), { tool: 'run_project_command' });
    expect(view.status).toBe('error');
    expect(view.headline).toBe('boom');
  });

  it('respects tool_error kind even when payload looks ok', () => {
    const view = presentToolResult(JSON.stringify({ message: 'timeout' }), { tool: 'wait_for_process', kind: 'tool_error' });
    expect(view.status).toBe('error');
    expect(view.headline).toBe('timeout');
  });

  it('falls back to summary for unknown tools', () => {
    const view = presentToolResult(JSON.stringify({ ok: true, summary: 'done' }), { tool: 'some_custom_tool' });
    expect(view.status).toBe('ok');
    expect(view.headline).toBe('done');
  });
});
