import { computed, ref, type Ref } from 'vue';
import type { ActivityStatus, AgentConversationEntry } from '../api/types';
import { entriesToTimeline } from '../utils/agent-timeline';
import { isToolGroup } from '../utils/tool-friendly';

export function useAgentTimeline(entries: Ref<readonly AgentConversationEntry[]>, activityStatus: Ref<ActivityStatus | null>) {
  const expandedIds = ref(new Set<string>());
  const timeline = computed(() => entriesToTimeline(entries.value, activityStatus.value));
  function toggleExpanded(id: string): void { const next = new Set(expandedIds.value); next.has(id) ? next.delete(id) : next.add(id); expandedIds.value = next; }
  function expandAll(): void {
    const ids = new Set<string>();
    for (const round of timeline.value.rounds) {
      for (const item of round.items) {
        if (isToolGroup(item)) ids.add(item.id);
        else ids.add(item.call.id);
      }
    }
    expandedIds.value = ids;
  }
  function collapseAll(): void { expandedIds.value = new Set(); }
  return { timeline, expandedIds, toggleExpanded, expandAll, collapseAll };
}
