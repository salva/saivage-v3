import { describe, expect, it } from 'vitest';
import source from '../views/DebugView.vue?raw';
import readModelSource from '../composables/useDebugReadModel?raw';

describe('DebugView S06 diagnostic-only integration contract', () => {
  it('exposes a route-owned root and route-body content for browser smoke assertions', () => {
    expect(source).toContain('data-testid="route-debug"');
    expect(source).toContain('debug-tabs');
    expect(source).toContain('Runtime State');
  });

  it('retains diagnostic tabs and refresh controls while removing mutation controls', () => {
    expect(readModelSource).toContain("label: 'State'");
    expect(readModelSource).toContain("label: 'Errors'");
    expect(readModelSource).toContain("label: 'Timeline'");
    expect(readModelSource).toContain("label: 'Processes'");
    expect(source).toContain('useDebugReadModel');
    expect(source).toContain('@click="refreshOperatorControl"');
    expect(source).toContain('@click="debugStore.fetchProcesses()"');

    expect(source).not.toMatch(/terminateProcess|@click="[^"]*terminate/i);
    expect(source).not.toMatch(/acknowledgeNote|acknowledgeNotification|clearAllNotes|deleteNote|pauseRuntime|resumeRuntime/);
    expect(source).not.toMatch(/NotificationsPanel/);
  });

  it('adds read-only per-card child rendering through the debug read-model composable', () => {
    expect(source).toContain('data-testid="debug-view-card-children"');
    expect(source).toContain('data-testid="debug-card-children-list"');
    expect(source).toContain('childrenForCard(card.id)');
    expect(source).not.toContain('cardsStore.childrenOf(card.id)');

    const start = source.indexOf('<section class="card-children-section"');
    const end = source.indexOf('</section>', start);
    const childSection = source.slice(start, end);
    expect(childSection).not.toMatch(/@click|@submit|@drag|createCard|updateCard|deleteCard/);
  });
});
