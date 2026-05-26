import { describe, expect, it } from 'vitest';
import debugViewSource from '../views/DebugView.vue?raw';

describe('DebugView operator events surface', () => {
  it('does not contain per-note or per-notification management handlers', () => {
    expect(debugViewSource).not.toMatch(/acknowledgeNotification/i);
    expect(debugViewSource).not.toMatch(/clearAllNotes/i);
    expect(debugViewSource).not.toMatch(/acknowledgeNote/i);
    expect(debugViewSource).not.toMatch(/deleteNote/i);
    expect(debugViewSource).not.toMatch(/@click="[^"]*acknowledge/i);
  });
});
