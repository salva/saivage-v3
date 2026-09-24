import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { CardDetail } from '../api/types';
import { OperatorApiError, getCard } from '../api/client';

interface SessionCardContext {
  detail: ComputedRef<CardDetail | null>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  unavailable: Ref<boolean>;
}

/**
 * Independent admitted card context for a direct session entry. This never
 * claims the card-store selection and never searches for a replacement card:
 * an exact 404 leaves the exact card identity with honest unavailability.
 */
export function useSessionCardContext(cardId: () => string | null): SessionCardContext {
  const detail = ref<CardDetail | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const unavailable = ref(false);
  const observedIdentity = ref<string | null>(null);
  let generation = 0;

  watch(cardId, (id) => {
    const token = ++generation;
    detail.value = null;
    error.value = null;
    unavailable.value = false;
    loading.value = id !== null;
    if (id === null) return;
    observedIdentity.value = id;
    getCard(id)
      .then((response) => {
        if (token !== generation) return;
        detail.value = response.card;
      })
      .catch((cause: unknown) => {
        if (token !== generation) return;
        if (cause instanceof OperatorApiError && cause.isNotFound) {
          unavailable.value = true;
          return;
        }
        error.value = cause instanceof Error ? cause.message : String(cause);
      })
      .finally(() => {
        if (token === generation) loading.value = false;
      });
  }, { immediate: true });

  return { detail: computed(() => detail.value), loading, error, unavailable };
}
