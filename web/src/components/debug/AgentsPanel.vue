<template>
  <div class="debug-tab-content">
    <section class="debug-section">
      <div class="debug-section-header operator-header">
        <div>
          <h4 class="debug-section-title">Agent Conversations</h4>
          <p class="operator-subtitle">
            Segment-backed conversations from the operator API, with raw tool-delivery and LLM
            exchange ledgers where available.
          </p>
        </div>
        <div class="operator-actions-inline">
          <button
            class="sv-fetch-btn"
            :disabled="sessionsLoading || sessionsRefreshing"
            @click="emit('refresh')"
          >
            Refresh
          </button>
        </div>
      </div>

      <StatusBanner v-if="sessionsRefreshError" tone="warning" :message="sessionsRefreshError" />
      <StatusBanner v-if="sessionsRefreshing" tone="stale" message="Refreshing agent sessions…" />
      <ViewState v-if="sessionsLoading" state="loading" title="Loading agent conversations..." />
      <ViewState
        v-else-if="sessionsUnauthorized"
        state="unauthorized"
        title="Agent sessions unavailable"
        message="Provide a valid API token to load agent sessions."
      />
      <ViewState
        v-else-if="sessionsError"
        state="error"
        title="Failed to load agent conversations"
        :message="sessionsError"
      />
      <ViewState
        v-else-if="sessionsLoaded && sessions.length === 0"
        state="empty"
        title="No agent sessions"
      />
      <div v-else class="agent-debug-layout">
        <aside class="agent-debug-sidebar" aria-label="Persisted agent sessions">
          <button
            v-for="session in sessions"
            :key="session.id"
            type="button"
            class="agent-debug-session"
            :class="{ selected: effectiveAgentSessionId === session.id }"
            @click="emit('select-session', session.id)"
          >
            <span class="agent-debug-session-id mono">{{ session.id }}</span>
            <span class="agent-debug-session-meta">{{ session.agent_name }} · {{ session.session_scope }}</span>
          </button>
        </aside>
        <div>
          <div class="agent-debug-toolbar">
            <button
              v-for="kind in agentDebugKinds"
              :key="kind.id"
              type="button"
              class="pill debug-tab-button"
              :aria-pressed="selectedAgentDebugKind === kind.id"
              @click="emit('select-kind', kind.id)"
            >
              {{ kind.label }}
            </button>
          </div>
          <DebugAgentDetail
            v-if="effectiveAgentSessionId"
            :key="`${effectiveAgentSessionId}:${selectedAgentDebugKind}`"
            :session-id="effectiveAgentSessionId"
            :kind="selectedAgentDebugKind"
          />
        </div>
      </div>
    </section>
  </div>
</template>

<script lang="ts">
export type AgentDebugKind = 'conversation' | 'llmExchange';
</script>

<script setup lang="ts">
import type { ConversationSessionId } from '../../api/contracts';
import type { AgentSession } from '../../api/types';
import DebugAgentDetail from '../agents/DebugAgentDetail.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import ViewState from '../ui/ViewState.vue';

defineProps<{
  sessions: readonly AgentSession[];
  sessionsLoaded: boolean;
  sessionsLoading: boolean;
  sessionsRefreshing: boolean;
  sessionsError: string | null;
  sessionsRefreshError: string | null;
  sessionsUnauthorized: boolean;
  effectiveAgentSessionId: ConversationSessionId | null;
  selectedAgentDebugKind: AgentDebugKind;
  agentDebugKinds: readonly { id: AgentDebugKind; label: string }[];
}>();

const emit = defineEmits<{
  refresh: [];
  'select-session': [sessionId: ConversationSessionId];
  'select-kind': [kind: AgentDebugKind];
}>();
</script>

<style scoped>
.mono {
  font-family: 'SF Mono', monospace;
  font-size: 11px;
  color: var(--accent-2);
}
.agent-debug-layout {
  display: grid;
  grid-template-columns: minmax(220px, 280px) 1fr;
  gap: 16px;
  align-items: start;
}
.agent-debug-sidebar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 70vh;
  overflow: auto;
}
.agent-debug-session {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 9px 10px;
  background: var(--surface-1);
  border: 1px solid var(--surface-3);
  border-radius: 6px;
  color: var(--text);
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}
.agent-debug-session:hover,
.agent-debug-session.selected {
  border-color: var(--accent-2);
  background: var(--entry-user-bg);
}
.agent-debug-session-id { color: var(--accent-2); }
.agent-debug-session-meta { font-size: 11px; color: var(--text-muted); }
.agent-debug-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.agent-debug-toolbar .debug-tab-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
