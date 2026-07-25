import { computed, nextTick, ref, watch, type Ref } from 'vue';
import type { AgentConversationEntry } from '../api/types';
import { entriesToTimeline } from '../utils/agent-timeline';
import { isToolGroup } from '../utils/tool-friendly';

export function useAgentTimeline(entries: Ref<readonly AgentConversationEntry[]>) {
  const expandedIds = ref(new Set<string>());
  const scrollAreaRef = ref<HTMLElement | null>(null);
  const pinnedToLatest = ref(true);
  const unseenCount = ref(0);
  const autoScrollPaused = ref(false);
  const timeline = computed(() => entriesToTimeline(entries.value));
  const STICK_TO_LATEST_THRESHOLD_PX = 64;

  function isNearLatest(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_LATEST_THRESHOLD_PX;
  }

  function scrollToLatest(): void {
    const el = scrollAreaRef.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function handleTimelineScroll(): void {
    const el = scrollAreaRef.value;
    if (!el) return;
    pinnedToLatest.value = isNearLatest(el);
    if (pinnedToLatest.value) unseenCount.value = 0;
  }

  async function jumpToLatest(): Promise<void> {
    pinnedToLatest.value = true;
    unseenCount.value = 0;
    await nextTick();
    scrollToLatest();
  }

  function resetScrollState(): void {
    pinnedToLatest.value = true;
    unseenCount.value = 0;
    void nextTick(() => scrollToLatest());
  }

  function toggleAutoScrollPause(): void {
    autoScrollPaused.value = !autoScrollPaused.value;
    if (!autoScrollPaused.value && pinnedToLatest.value) {
      unseenCount.value = 0;
      void nextTick(() => scrollToLatest());
    }
  }

  function toggleExpanded(id: string): void {
    const next = new Set(expandedIds.value);
    next.has(id) ? next.delete(id) : next.add(id);
    expandedIds.value = next;
  }
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
  function collapseAll(): void {
    expandedIds.value = new Set();
  }

  watch(
    () => entries.value.length,
    (volume, previousVolume) => {
      if (volume <= previousVolume) return;
      const delta = volume - previousVolume;
      if (pinnedToLatest.value && !autoScrollPaused.value) void nextTick(() => scrollToLatest());
      else unseenCount.value += delta;
    },
  );

  return {
    timeline,
    expandedIds,
    scrollAreaRef,
    pinnedToLatest,
    unseenCount,
    autoScrollPaused,
    toggleExpanded,
    expandAll,
    collapseAll,
    handleTimelineScroll,
    jumpToLatest,
    resetScrollState,
    scrollToLatest,
    toggleAutoScrollPause,
  };
}
