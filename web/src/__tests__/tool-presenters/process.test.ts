import { describe, expect, it } from 'vitest';
import { presentToolResult } from '../../utils/tool-presenters';
import { processData } from './fixtures';
describe('recorded process evidence', () => {
  it('preserves actual killed status even when a numeric exit is returned', () => {
    const view = presentToolResult(JSON.stringify({ success: true, data: { ...processData, status: 'killed' } }), { tool: 'kill_process' });
    expect(view.outcome).toBe('Exited · exit 0 · recorded status: killed · Output head incomplete');
  });
  it.each(['run_command', 'wait_process', 'kill_process'])('shows separate stream heads, coverage and real output links for %s', (tool) => {
    const view = presentToolResult(JSON.stringify({ success: true, data: processData }), { tool });
    expect(view.outcome).toBe('Exited · exit 0 · Output head incomplete');
    expect(view.headline).toEqual([]);
    expect(view.sections.filter((s) => s.disclosure).map((s) => s.title)).toEqual(['stdout', 'stderr']);
    expect(view.sections.find((s) => s.title === 'stdout')?.content).toBe('first\nsecond');
    expect(view.sections.find((s) => s.title === 'stderr')?.content).toBe('warning');
    expect(JSON.stringify(view.sections)).toContain('.saivage/work/processes/proc-0123456789ab/stdout.log');
    expect(JSON.stringify(view.sections)).not.toContain('duration');
    expect(JSON.stringify(view.sections)).not.toContain('PID');
  });
  it.each([
    [{ status: 'running', exit_code: null }, 'Running at observation', 'neutral'],
    [{ status: 'exited', exit_code: 1, stderr: 'test failure' }, 'Process failed · exit 1', 'error'],
    [{ status: 'killed', exit_code: null }, 'Recorded process status: killed', 'neutral'],
  ])('distinguishes domain outcome from successful settlement', (override, outcome, status) => {
    expect(presentToolResult(JSON.stringify({ success: true, data: { ...processData, ...override } }), { tool: 'run_command' })).toMatchObject({ outcome: `${outcome} · Output head incomplete`, status });
  });
  it('shows failed and uncertain calls without inventing process data', () => {
    for (const data of [undefined, { outcome_unknown: true }]) {
      const view = presentToolResult(JSON.stringify({ success: false, error: 'Prior effects may or may not have happened', data }), { tool: 'wait_process' });
      expect(view.outcome).toContain(data ? 'Effects uncertain' : 'Failed');
      expect(JSON.stringify(view.sections)).not.toContain('process id');
    }
  });
  it.each(['work:///processes/proc-0123456789ab/stdout.log?raw=1', 'work:///processes/proc-0123456789ab/stdout.log#raw', 'work:///processes/%70roc-0123456789ab/stdout.log', 'project:///processes/proc-0123456789ab/stdout.log'])('keeps unsupported output locator as text: %s', (stdout_url) => {
    const view = presentToolResult(JSON.stringify({ success: true, data: { ...processData, stdout_url } }), { tool: 'run_command' });
    const stdout = view.sections.find((s) => s.title.startsWith('stdout —'))!;
    expect(stdout.fields?.flatMap((f) => f.parts).some((p) => p.kind === 'file')).toBe(false);
  });
});
