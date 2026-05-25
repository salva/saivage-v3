import { describe, expect, it } from 'vitest';
import source from '../views/DebugView.vue?raw';

describe('DebugView S06 diagnostic-only integration contract', () => {
  it('retains diagnostic tabs and refresh controls while removing mutation controls', () => {
    expect(source).toContain("label: 'State'");
    expect(source).toContain("label: 'Errors'");
    expect(source).toContain("label: 'Timeline'");
    expect(source).toContain("label: 'Processes'");
    expect(source).toContain('@click="refreshOperatorControl"');
    expect(source).toContain('@click="debugStore.fetchProcesses()"');

    expect(source).not.toMatch(/terminateProcess|@click="[^"]*terminate/i);
    expect(source).not.toMatch(/acknowledgeNote|acknowledgeNotification|clearAllNotes|deleteNote|pauseRuntime|resumeRuntime/);
    expect(source).not.toMatch(/NotificationsPanel/);
  });

  it('adds read-only per-card child rendering through cardsStore.childrenOf', () => {
    expect(source).toContain('data-testid="debug-view-card-children"');
    expect(source).toContain('data-testid="debug-card-children-list"');
    expect(source).toContain('cardsStore.childrenOf(card.id)');

    const start = source.indexOf('<section class="card-children-section"');
    const end = source.indexOf('</section>', start);
    const childSection = source.slice(start, end);
    expect(childSection).not.toMatch(/@click|@submit|@drag|createCard|updateCard|deleteCard/);
  });
});
