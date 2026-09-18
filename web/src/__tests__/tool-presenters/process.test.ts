import { describe, expect, it } from 'vitest';
import { presentToolResult } from '../../utils/tool-presenters';
import { inlineText } from './_helpers';

const id = 'proc-0123456789ab';
const base = {
  process_id: id,
  exit_code: 0,
  status: 'exited',
  stdout: 'first\nsecond',
  stderr: 'warning',
  stdout_complete: true,
  stderr_complete: false,
  stdout_url: `work:///cards/card-a-b/processes/${id}/stdout.log`,
  stderr_url: `work:///cards/card-a-b/processes/${id}/stderr.log`,
  stdout_bytes: 12,
  stderr_bytes: 10000,
};

describe('process result presenter', () => {
  it.each(['run_command', 'wait_process', 'kill_process'] as const)('shows independent stream state and canonical Files links for %s while retaining raw output', (tool) => {
    const body = { success: true, data: base };
    const view = presentToolResult(JSON.stringify(body), { tool });

    expect(inlineText(view.headline)).toBe('exit 0 · exited');
    expect(inlineText(view.detail ?? [])).toBe(`process ${id} · stdout complete · stdout Files · stderr partial · stderr Files`);
    expect(view.detail).toContainEqual({ kind: 'file', root: 'output', path: `.saivage/work/cards/card-a-b/processes/${id}/stdout.log`, label: 'stdout Files' });
    expect(view.detail).toContainEqual({ kind: 'file', root: 'output', path: `.saivage/work/cards/card-a-b/processes/${id}/stderr.log`, label: 'stderr Files' });
    expect(view.body).toEqual(body);
    expect(inlineText([...(view.headline), ...(view.detail ?? [])])).not.toContain('first');
    expect(inlineText([...(view.headline), ...(view.detail ?? [])])).not.toContain('warning');
  });

  it('maps canonical non-card process URLs to the output root', () => {
    const data = { ...base, stdout_url: `work:///processes/${id}/stdout.log`, stderr_url: `work:///processes/${id}/stderr.log` };
    const view = presentToolResult(JSON.stringify({ success: true, data }), { tool: 'run_command' });
    expect(view.detail).toContainEqual({ kind: 'file', root: 'output', path: `.saivage/work/processes/${id}/stdout.log`, label: 'stdout Files' });
    expect(view.detail).toContainEqual({ kind: 'file', root: 'output', path: `.saivage/work/processes/${id}/stderr.log`, label: 'stderr Files' });
  });

  it.each([
    `work:///processes/${id}/stdout.log?raw=1`,
    `work:///processes/${id}/stdout.log#raw`,
    `work:///processes/%70roc-0123456789ab/stdout.log`,
    `work:///processes/proc-1/stdout.log`,
    `work:///cards/card-A/processes/${id}/stdout.log`,
    `work:///cards/card-a/processes/${id}/output.log`,
    `work:///processes/${id}/stderr.log`,
    `project:///processes/${id}/stdout.log`,
    `work:///processes//${id}/stdout.log`,
  ])('does not synthesize a Files link for a noncanonical URL: %s', (stdout_url) => {
    const view = presentToolResult(JSON.stringify({ success: true, data: { ...base, stdout_url } }), { tool: 'run_command' });
    expect(view.detail).not.toContainEqual(expect.objectContaining({ kind: 'file', label: 'stdout Files' }));
    expect(view.detail).toContainEqual(expect.objectContaining({ kind: 'file', label: 'stderr Files' }));
  });
});
