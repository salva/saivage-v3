import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { ApiError, getCardAgentSessions } from '../api/client';
import type { AgentSession } from '../api/types';
export interface CardAgentSessionsState {
  sessions: AgentSession[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  generation: number;
  controller: AbortController | null;
}
export const useCardAgentSessionsStore = defineStore('card-agent-sessions', () => {
  const scopes = new Map<string, CardAgentSessionsState>();
  function scope(cardId: string) {
    let state = scopes.get(cardId);
    if (!state) {
      state = reactive({
        sessions: [],
        loading: false,
        refreshing: false,
        error: null,
        generation: 0,
        controller: null,
      });
      scopes.set(cardId, state);
    }
    return state;
  }
  async function fetchScope(cardId: string) {
    const state = scope(cardId);
    const generation = ++state.generation;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.sessions.length ? (state.refreshing = true) : (state.loading = true);
    try {
      const response = await getCardAgentSessions(cardId, controller.signal);
      if (generation !== state.generation) return;
      state.sessions = response.sessions;
      state.error = null;
    } catch (error) {
      if (
        generation !== state.generation ||
        (error instanceof DOMException && error.name === 'AbortError')
      )
        return;
      if (error instanceof ApiError && error.isNotFound) {
        state.sessions = [];
        state.error = null;
        return;
      }
      state.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (generation === state.generation) {
        state.loading = false;
        state.refreshing = false;
      }
    }
  }
  function release(cardId: string) {
    const state = scopes.get(cardId);
    if (!state) return;
    ++state.generation;
    state.controller?.abort();
    scopes.delete(cardId);
  }
  return { scope, fetchScope, release };
});
