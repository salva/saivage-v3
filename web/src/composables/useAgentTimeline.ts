import { computed, ref, type Ref } from 'vue';
import type { ActivityStatus, AgentConversationEntry } from '../api/types';
import { entriesToTimeline } from '../utils/agent-timeline';

export function useAgentTimeline(entries: Ref<AgentConversationEntry[]>, activityStatus: Ref<ActivityStatus | null>, currentSessionId: () => string | null) {
  const expandedIds = ref(new Set<string>());
  const timeline = computed(() => entriesToTimeline(entries.value, activityStatus.value));
  function toggleExpanded(id: string): void { const next = new Set(expandedIds.value); next.has(id) ? next.delete(id) : next.add(id); expandedIds.value = next; }
  function expandAll(): void { expandedIds.value = new Set(entries.value.filter((entry) => entry.kind === 'tool_call' || entry.kind === 'tool_result' || entry.kind === 'tool_error').map((entry) => entry.id)); }
  function collapseAll(): void { expandedIds.value = new Set(); }
  return { timeline, expandedIds, currentSessionId, toggleExpanded, expandAll, collapseAll };
}
