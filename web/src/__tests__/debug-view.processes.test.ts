import { describe, expect, it } from 'vitest';
import source from '../views/DebugView.vue?raw';

describe('DebugView processes tab after S06', () => {
  it('preserves process inspection and log browsing but removes termination controls', () => {
    expect(source).toContain("label: 'Processes'");
    expect(source).toContain('debugStore.fetchProcesses()');
    expect(source).toContain('sortedProcesses');
    expect(source).toContain('processLogEntries(proc)');
    expect(source).toContain('browseProcessLog(logEntry.value)');

    expect(source).not.toMatch(/terminateProcess|@click="[^"]*terminate/i);
    expect(source).not.toMatch(/class="[^"]*(?:terminate|kill)[^"]*"/i);
  });
});
