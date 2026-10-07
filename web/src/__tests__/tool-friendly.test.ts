import { describe, expect, it } from 'vitest';
import { buildToolDisplay, inlinePartsText, isKnownTool } from '../utils/tool-friendly';
import { call, result, processData } from './tool-presenters/fixtures';
describe('single row tool display', () => {
  it('does not backdate a failed process outcome to its requested row', () => {
    const c = call('run_command', { command: 'npm test' });
    const r = result('run_command', { ...processData, exit_code: 1 });
    const requested = buildToolDisplay({ entry: c, mate: r });
    expect(requested.action).toBe('Requested Run command');
    expect(requested.statusTone).toBe('neutral');
    expect(requested.links).toContainEqual({ kind: 'entry', id: r.id, label: 'Result recorded below' });
    const recorded = buildToolDisplay({ entry: r, mate: c });
    expect(recorded.action).toBe('Recorded result');
    expect(inlinePartsText(recorded.status)).toContain('Process failed · exit 1');
    expect(recorded.statusTone).toBe('error');
    expect(inlinePartsText(recorded.target)).toContain('npm test');
  });
  it('renders unmatched calls and retained results honestly', () => {
    expect(inlinePartsText(buildToolDisplay({ entry: call('read'), mate: null }).status)).toBe('No result recorded');
    const recorded = buildToolDisplay({ entry: result('read', { metadata_only: true }), mate: null });
    expect(inlinePartsText(recorded.target)).toBe('Requested context unavailable');
    expect(inlinePartsText(recorded.status)).toContain('Metadata only');
  });
  it('keeps exact unknown tool names and opaque safe values', () => {
    expect(isKnownTool('custom_probe')).toBe(false);
    const display = buildToolDisplay({ entry: call('custom_probe', { exact: 'received' }), mate: null });
    expect(display.toolName).toBe('custom_probe');
    expect(display.sections[0].content).toContain('received');
  });
});
