import { computed, type ComputedRef, type Ref } from 'vue';
import type { CardHierarchyRecord } from '../api/types';
import type { useCardStore } from '../stores/cards';

export interface DashboardReadModel {
  goalChildren: ComputedRef<readonly CardHierarchyRecord[]>;
  runtimeBannerMessage: ComputedRef<string | null>;
  runtimeBannerClass: ComputedRef<string>;
}

export function useDashboardReadModel(options: {
  runtimeRefs: { statusLabel: Ref<string>; isStale: Ref<boolean>; unauthorized: Ref<boolean>; currentCardId: Ref<string | null> };
  cardsStore: Pick<ReturnType<typeof useCardStore>, 'loadedChildrenFor'>;
}): DashboardReadModel {
  const displayedGoalId = computed(() => options.runtimeRefs.currentCardId.value);
  const goalChildren = computed(() => displayedGoalId.value ? options.cardsStore.loadedChildrenFor(displayedGoalId.value) ?? [] : []);
  const runtimeBannerMessage = computed(() => {
    if (options.runtimeRefs.unauthorized.value) return 'Runtime snapshot is unavailable because the API token was rejected.';
    if (options.runtimeRefs.statusLabel.value === 'error') return 'Runtime is degraded. Inspect Debug and current evidence before treating work as healthy.';
    if (options.runtimeRefs.isStale.value) return 'Runtime snapshot is stale. Refresh to confirm the current REST state.';
    return null;
  });
  const runtimeBannerClass = computed(() => options.runtimeRefs.unauthorized.value || options.runtimeRefs.statusLabel.value === 'error'
    ? 'runtime-status-banner-error'
    : 'runtime-status-banner-warning');
  return { goalChildren, runtimeBannerMessage, runtimeBannerClass };
}
