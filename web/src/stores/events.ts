import { defineStore } from 'pinia';
import { readonly, reactive } from 'vue';
import type { LoggedEventView } from '../api/types';
import { listEvents } from '../api/client';

const TAIL_LIMIT = 50;

export type EventsScope = { cardId: string } | { cardId: null };

interface EventsObservation {
  events: LoggedEventView[];
  total: number | null;
  loading: boolean;
  error: string | null;
  refreshError: string | null;
  loaded: boolean;
  mode: 'newest_tail' | 'oldest_page';
  offset: number;
}

function emptyObservation(): EventsObservation {
  return { events: [], total: null, loading: false, error: null, refreshError: null, loaded: false, mode: 'newest_tail', offset: 0 };
}

/**
 * Bounded retained-events reader. Each read is a fresh bounded observation
 * (newest tail or an explicit oldest page); events never move underneath
 * reading and no polling or invalidation is introduced.
 */
export const useEventsStore = defineStore('events', () => {
  const scopes = new Map<string, EventsObservation>();
  const controllers = new Map<string, AbortController>();
  const generations = new Map<string, number>();

  function scopeKey(scope: EventsScope): string {
    return scope.cardId ?? '*';
  }

  function scope(scope: EventsScope): EventsObservation {
    const key = scopeKey(scope);
    let state = scopes.get(key);
    if (!state) {
      state = reactive(emptyObservation());
      scopes.set(key, state);
    }
    return state;
  }

  async function read(cardScope: EventsScope, options: { mode: 'newest_tail' | 'oldest_page'; offset?: number }): Promise<void> {
    const key = scopeKey(cardScope);
    const state = scope(cardScope);
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    controllers.get(key)?.abort();
    const controller = new AbortController();
    controllers.set(key, controller);
    const refresh = state.loaded;
    state.loading = true;
    if (!refresh) state.error = null;
    state.refreshError = null;
    try {
      const mode = options.mode;
      const offset = mode === 'newest_tail' ? 0 : options.offset ?? 0;
      const response = await listEvents({
        cardId: cardScope.cardId ?? undefined,
        selection: mode,
        limit: TAIL_LIMIT,
        offset,
        signal: controller.signal,
      });
      if (generations.get(key) !== generation) return;
      state.events = [...response.events];
      state.total = response.total;
      state.loaded = true;
      state.mode = mode;
      state.offset = offset;
      state.error = null;
      state.refreshError = null;
    } catch (error) {
      if (generations.get(key) !== generation || (error instanceof DOMException && error.name === 'AbortError')) return;
      const message = error instanceof Error ? error.message : String(error);
      if (refresh) state.refreshError = message;
      else state.error = message;
    } finally {
      if (generations.get(key) === generation) {
        state.loading = false;
        controllers.delete(key);
      }
    }
  }

  function refresh(cardScope: EventsScope): Promise<void> {
    const state = scope(cardScope);
    return read(cardScope, { mode: state.mode, offset: state.offset });
  }

  function retry(cardScope: EventsScope): Promise<void> {
    const state = scope(cardScope);
    if (state.error === null && state.refreshError === null) return Promise.resolve();
    return read(cardScope, { mode: state.mode, offset: state.offset });
  }

  function browseOldest(cardScope: EventsScope, offset: number): Promise<void> {
    return read(cardScope, { mode: 'oldest_page', offset });
  }

  function release(cardScope: EventsScope): void {
    const key = scopeKey(cardScope);
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    controllers.get(key)?.abort();
    controllers.delete(key);
    scopes.delete(key);
  }

  return {
    scope: (cardScope: EventsScope) => readonly(scope(cardScope)),
    tailLimit: TAIL_LIMIT,
    read,
    refresh,
    retry,
    browseOldest,
    release,
  };
});
