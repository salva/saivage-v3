import { computed, type ComputedRef, type Ref } from 'vue';
import type { CardIndex, CardRecord } from '../api/types';
import type { useCardStore } from '../stores/cards';
import { selectChildrenOf } from '../stores/card-presentation';

export interface DashboardReadModel {
  goalChildren: ComputedRef<CardRecord[]>;
  runtimeBannerMessage: ComputedRef<string | null>;
  runtimeBannerClass: ComputedRef<string>;
  barWidth: (count: number) => string;
}

export function useDashboardReadModel(options: {
  runtimeRefs: {
    statusLabel: Ref<string>;
    isStale: Ref<boolean>;
    unauthorized: Ref<boolean>;
    cardIndex: Ref<CardIndex>;
  };
  cardsStore: Pick<ReturnType<typeof useCardStore>, 'cards' | 'currentCard'>;
}): DashboardReadModel {
  const displayedGoalId = computed<string | null>(() => options.cardsStore.currentCard?.id ?? null);
  const goalChildren = computed<CardRecord[]>(() => displayedGoalId.value ? selectChildrenOf([...options.cardsStore.cards], displayedGoalId.value) : []);

  const runtimeBannerMessage = computed(() => {
    if (options.runtimeRefs.unauthorized.value) return 'Runtime snapshot is unavailable because the API token was rejected.';
    if (options.runtimeRefs.statusLabel.value === 'error') return 'Runtime is degraded. Inspect Debug and current evidence before treating work as healthy.';
    if (options.runtimeRefs.isStale.value) return 'Runtime snapshot is stale. Refresh to confirm the current REST state.';
    return null;
  });

  const runtimeBannerClass = computed(() => {
    if (options.runtimeRefs.unauthorized.value || options.runtimeRefs.statusLabel.value === 'error') return 'runtime-status-banner-error';
    return 'runtime-status-banner-warning';
  });

  function barWidth(count: number): string {
    const cardIndex = options.runtimeRefs.cardIndex.value as CardIndex;
    const max = Math.max(...Object.values(cardIndex.byType), 1);
    return `${Math.round((count / max) * 100)}%`;
  }

  return {
    goalChildren,
    runtimeBannerMessage,
    runtimeBannerClass,
    barWidth,
  };
}
