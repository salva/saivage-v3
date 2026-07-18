import { describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';
import source from '../views/DashboardView.vue?raw';
import { useDashboardReadModel } from '../composables/useDashboardReadModel';
import { useCardStore } from '../stores/cards';
import { cardView } from './card-view-fixtures';

describe('DashboardView S06 read-only contract', () => {
  it('exposes a route-owned root for browser smoke assertions', () => {
    expect(source).toContain('data-testid="route-dashboard"');
    expect(source).toContain('Runtime Status');
  });

  it('keeps refresh/navigation and exposes only Stop project plus capability-gated confirmed restart', () => {
    expect(source).toContain('class="ui-refresh-button"');
    expect(source).toContain('@click="refreshRuntime"');
    expect(source).toContain('goToCard');
    expect(source).not.toContain('goToAgent');

    expect(source).not.toContain('sendChatMessage');
    expect(source).not.toContain('Analyst Chat');
    expect(source).not.toContain('class="chat-panel"');
    expect(source).toContain('Stop project');
    expect(source).toContain('v-if="restartServerAvailable"');
    expect(source).toContain("window.prompt('Type RESTART SERVER to confirm server restart:') !== 'RESTART SERVER'");
    expect(source).toContain('restartServerAvailable');
    expect(source).not.toMatch(/pauseRuntime|resumeRuntime|freezeRuntime|resumeRuntimeFromFreeze/);
  });

  it('renders the child-of-goal panel from the dashboard read-model composable without mutating arms', () => {
    expect(source).toContain('data-testid="dashboard-child-of-goal-panel"');
    expect(source).toContain('data-testid="child-of-goal-list"');
    expect(source).toContain('useDashboardReadModel');
    expect(source).toContain('goalChildren');
    expect(source).not.toContain('cardsStore.childrenOf(displayedGoalId.value)');

    const panelSource = source.slice(source.indexOf('data-testid="dashboard-child-of-goal-panel"'));
    expect(panelSource).not.toMatch(/@click|@submit|@drag|createCard|updateCard|deleteCard/);
  });

  it('projects dashboard goal children in committed parent order', () => {
    setActivePinia(createPinia());
    const cardsStore = useCardStore();
    const goalId = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const firstId = `${goalId}-bbbbbbbbbbbbbbbbbbbbbbbbbbbb`;
    const secondId = `${goalId}-cccccccccccccccccccccccccccc`;
    const goal = cardView(goalId, { type: 'goal', children: [secondId, firstId] });
    cardsStore.hierarchySlicesByParentId = { [goalId]: { parent: goal, children: [cardView(secondId), cardView(firstId)] } };

    const model = useDashboardReadModel({
      cardsStore,
      runtimeRefs: {
        statusLabel: ref('running'),
        isStale: ref(false),
        unauthorized: ref(false),
        currentCardId: ref(goalId),
      },
    });

    expect(model.goalChildren.value.map((card) => card.id)).toEqual([secondId, firstId]);
  });
});
