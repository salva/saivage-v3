import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { CardDetail } from '../api/types';
import { OperatorApiError, getCard } from '../api/client';
import { createLogger } from '../utils/logger';

const log = createLogger('orientation:current-card');

interface CurrentCardOrientation {
  detail: ComputedRef<CardDetail | null>;
  unavailable: Ref<boolean>;
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
  const unavailable = ref(false);
  const observedIdentity = ref<string | null>(null);
  let generation = 0;

  async function observe(cardId: string): Promise<void> {
    const token = ++generation;
    try {
      const response = await getCard(cardId);
      if (token !== generation) return;
      detail.value = response.card;
      unavailable.value = false;
      observedIdentity.value = cardId;
    } catch (error) {
      if (token !== generation) return;
      if (error instanceof OperatorApiError && error.isNotFound) {
        unavailable.value = true;
        return;
      }
      log.error('current-card orientation read failed', error);
    }
  }

  watch(
    () => [currentCardId(), observationAccepted()] as const,
    ([cardId, accepted]) => {
      if (!accepted || cardId === null) return;
      if (cardId === observedIdentity.value && detail.value) return;
      void observe(cardId);
    },
    { immediate: true },
  );

  return { detail: computed(() => detail.value), unavailable };
}
