import { computed, ref, watch, onScopeDispose, type ComputedRef } from 'vue';
import { createOwnedFetch } from '../stores/owned-fetch';
import type { CardDetail } from '../api/types';
import { OperatorApiError, getCard } from '../api/client';

export type CurrentCardOutcome = 'idle' | 'loading' | 'observed' | 'not-found' | 'failed' | 'unauthorized';

interface CurrentCardOrientation {
  detail: ComputedRef<CardDetail | null>;
  outcome: ComputedRef<CurrentCardOutcome>;
}

/**
 * Orientation-owned exact current-card problem detail. This resource never
 * claims the card-store selection: it observes only the current card identity
 * and retains its last accepted detail when a refresh fails.
 */
export function useCurrentCardOrientation(
  currentCardId: () => string | null,
  observationAccepted: () => boolean,
): CurrentCardOrientation {
  const detail = ref<CardDetail | null>(null);
  const outcome = ref<CurrentCardOutcome>('idle');
  const request = createOwnedFetch();
  onScopeDispose(request.cancel);

  async function observe(cardId: string): Promise<void> {
    await request.run((signal) => getCard(cardId, signal), (response) => {
      detail.value = response.card;
      outcome.value = 'observed';
    }, (error) => {
      if (error instanceof OperatorApiError && error.isNotFound) {
        outcome.value = 'not-found';
      } else if (error instanceof OperatorApiError && error.isUnauthorized) {
        outcome.value = 'unauthorized';
      } else {
        outcome.value = 'failed';
      }
    });
  }

  watch(
    () => [currentCardId(), observationAccepted()] as const,
    ([cardId, accepted]) => {
      request.cancel();
      outcome.value = 'idle';
      if (!accepted || cardId === null) return;
      outcome.value = 'loading';
      void observe(cardId);
    },
    { immediate: true },
  );

  return { detail: computed(() => detail.value), outcome: computed(() => outcome.value) };
}
