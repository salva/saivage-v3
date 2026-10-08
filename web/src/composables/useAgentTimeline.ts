import { computed, nextTick, ref, watch, type Ref, type InjectionKey } from 'vue';
import type { AgentConversationEntry } from '../api/types';
import { entriesToTimeline } from '../utils/agent-timeline';
export const revealConversationEntry: InjectionKey<(id: string, scroll?: boolean) => Promise<boolean>> = Symbol('revealConversationEntry');

export function useAgentTimeline(entries: Ref<readonly AgentConversationEntry[]>) {
  const expandedIds = ref(new Set<string>());
  const scrollAreaRef = ref<HTMLElement | null>(null);
  const pinnedToLatest = ref(true);
  const unseenCount = ref(0);
  const autoScrollPaused = ref(false);
  const inspectingImage = ref(false);
  const timeline = computed(() => entriesToTimeline(entries.value));
  const STICK_TO_LATEST_THRESHOLD_PX = 64;

  function isNearLatest(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_LATEST_THRESHOLD_PX;
  }

  function scrollToLatest(): void {
    if (inspectingImage.value) return;
    const el = scrollAreaRef.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function handleTimelineScroll(): void {
    if (inspectingImage.value) return;
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
      for (const { entry } of round.rows) {
        if (entry.kind === 'tool_call' || entry.kind === 'tool_result') ids.add(entry.id);
      }
    }
    expandedIds.value = ids;
  }
  function collapseAll(): void {
    expandedIds.value = new Set();
  }

  async function revealEntry(id: string, scroll = true): Promise<boolean> {
    if (!entries.value.some(entry => entry.id === id)) return false;
    for (const round of timeline.value.rounds) {
      const row = round.rows.find(row => row.entry.id === id || row.mate?.id === id);
      if (row && (row.entry.kind === 'tool_call' || row.entry.kind === 'tool_result')) {
        expandedIds.value = new Set([...expandedIds.value, row.entry.id]);
        break;
      }
    }
    await nextTick();
    const owner = scrollAreaRef.value;
    const element = [...(owner?.querySelectorAll<HTMLElement>('[data-entry-id]') ?? [])].find(element => element.dataset.entryId === id);
    if (!owner || !element) return false;
    if (element instanceof HTMLDetailsElement) element.open = true;
    element.querySelectorAll<HTMLDetailsElement>(':scope > .diagnostic-row, .recorded-system-context').forEach(details => { details.open = true; });
    await nextTick();
    owner.querySelectorAll('.targeted-conversation-entry').forEach(row => row.classList.remove('targeted-conversation-entry'));
    element.classList.add('targeted-conversation-entry');
    if (scroll) {
      owner.scrollTop += element.getBoundingClientRect().top - owner.getBoundingClientRect().top - owner.clientHeight / 3;
      element.tabIndex = -1;
      element.focus({ preventScroll: true });
    }
    return true;
  }

  watch(
    () => entries.value.length,
    (volume, previousVolume) => {
      if (volume <= previousVolume) return;
      const delta = volume - previousVolume;
      if (pinnedToLatest.value && !autoScrollPaused.value && !inspectingImage.value) scrollToLatest();
      else unseenCount.value += delta;
    },
    { flush: 'post' },
  );

  return {
    timeline,
    expandedIds,
    scrollAreaRef,
    pinnedToLatest,
    unseenCount,
    autoScrollPaused,
    inspectingImage,
    toggleExpanded,
    expandAll,
    collapseAll,
    handleTimelineScroll,
    jumpToLatest,
    resetScrollState,
    scrollToLatest,
    toggleAutoScrollPause,
    revealEntry,
  };
}
