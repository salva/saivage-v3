import { describe, expect, it } from 'vitest';
import source from '../views/DashboardView.vue?raw';

describe('DashboardView S06 read-only contract', () => {
  it('keeps refresh and navigation while removing runtime command controls and dashboard chat', () => {
    expect(source).toContain('class="ui-refresh-button"');
    expect(source).toContain('@click="refreshRuntime"');
    expect(source).toContain('goToCard');
    expect(source).toContain('goToAgent');

    expect(source).not.toContain('sendChatMessage');
    expect(source).not.toContain('Analyst Chat');
    expect(source).not.toContain('class="chat-panel"');
    expect(source).not.toMatch(/Start Project|Stop Project|startProject|stopProject/);
    expect(source).not.toMatch(/runtime-command start-project|runtime-command stop-project/);
    expect(source).not.toMatch(/pauseRuntime|resumeRuntime|freezeRuntime|resumeRuntimeFromFreeze/);
  });

  it('renders the new child-of-goal panel from cardsStore.childrenOf without mutating arms', () => {
    expect(source).toContain('data-testid="dashboard-child-of-goal-panel"');
    expect(source).toContain('data-testid="child-of-goal-list"');
    expect(source).toContain('cardsStore.childrenOf(displayedGoalId.value)');

    const panelSource = source.slice(source.indexOf('data-testid="dashboard-child-of-goal-panel"'));
    expect(panelSource).not.toMatch(/@click|@submit|@drag|createCard|updateCard|deleteCard/);
  });
});
