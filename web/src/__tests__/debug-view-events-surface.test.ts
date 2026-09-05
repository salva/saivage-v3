import { describe, expect, it } from 'vitest';
import debugViewSource from '../views/DebugView.vue?raw';
import operatorPanelSource from '../components/debug/OperatorControlPanel.vue?raw';
import errorsPanelSource from '../components/debug/ErrorsPanel.vue?raw';

describe('DebugView operator events surface', () => {
  it('does not contain per-note or per-notification management handlers', () => {
    const debugSurface = [debugViewSource, operatorPanelSource, errorsPanelSource].join('\n');
    expect(debugSurface).not.toMatch(/acknowledgeNotification/i);
    expect(debugSurface).not.toMatch(/clearAllNotes/i);
    expect(debugSurface).not.toMatch(/acknowledgeNote/i);
    expect(debugSurface).not.toMatch(/deleteNote/i);
    expect(debugSurface).not.toMatch(/@click="[^"]*acknowledge/i);
  });
});
