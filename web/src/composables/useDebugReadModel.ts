import { computed, ref } from 'vue';
import type { DebugError, RuntimeState } from '../api/types';
import type { useCardStore } from '../stores/cards';
import type { useDebugStore } from '../stores/debug';
import {
  filterTimelineByKinds,
  selectCardStatusEntries,
  selectDebugCardChildren,
  selectMaxStatusCount,
  selectRuntimeDispatchLabel,
  selectRuntimeStatusLabel,
  selectRuntimeStatusTone,
  selectSortedProcesses,
  selectTimelineKindOptions,
} from '../stores/debug-read-model';
import { selectCurrentAgentSessionId, selectCurrentCardId } from '../stores/runtime-read-model';

export interface ErrorSourceEntry { source: string; errors: DebugError[] }
export type DebugTabId = 'state' | 'operator' | 'errors' | 'timeline' | 'agents' | 'mcp' | 'processes' | 'supervision';

export function useDebugReadModel(debugStore: ReturnType<typeof useDebugStore>, cardsStore: ReturnType<typeof useCardStore>) {
  const localActiveTab = ref<DebugTabId>('state');
  const selectedTimelineKinds = ref<string[]>([]);
  const tabs = [
    { id: 'state' as const, label: 'State' },
    { id: 'operator' as const, label: 'Operator Control' },
    { id: 'errors' as const, label: 'Errors' },
    { id: 'timeline' as const, label: 'Timeline' },
    { id: 'agents' as const, label: 'Agents' },
    { id: 'processes' as const, label: 'Processes' },
    { id: 'supervision' as const, label: 'Supervision' },
    { id: 'mcp' as const, label: 'MCP' },
  ];

  const runtimeStatusLabel = computed(() => selectRuntimeStatusLabel(debugStore.debugRuntime as RuntimeState | null));
  const runtimeStatusTone = computed(() => selectRuntimeStatusTone(debugStore.debugRuntime as RuntimeState | null));
  const currentCardId = computed(() => selectCurrentCardId(debugStore.debugRuntime as RuntimeState | null));
  const currentAgentSessionId = computed(() => selectCurrentAgentSessionId(debugStore.debugRuntime as RuntimeState | null));
  const runtimeDispatchLabel = computed(() => selectRuntimeDispatchLabel(debugStore.debugRuntime as RuntimeState | null));
  const operatorPanelBusy = computed(() => debugStore.loading);
  const operatorWarningBannerMessage = computed<string | null>(() => null);
  const sortedProcesses = computed(() => selectSortedProcesses(debugStore.processes));
  const timelineKindOptions = computed(() => selectTimelineKindOptions(debugStore.sortedTimeline));
  const filteredTimeline = computed(() => filterTimelineByKinds(debugStore.sortedTimeline, selectedTimelineKinds.value));
  const cardStatusEntries = computed(() => selectCardStatusEntries(debugStore.debugCards));
  const maxStatusCount = computed(() => selectMaxStatusCount(cardStatusEntries.value));
  const debugCardChildren = computed(() => selectDebugCardChildren([...cardsStore.cards], debugStore.debugCards.map((card) => card.id)));
  const childCardsByCardId = computed(() => new Map(debugCardChildren.value.map((entry) => [entry.cardId, entry.children])));
  const errorSourceEntries = computed<ErrorSourceEntry[]>(() => {
    const entries: ErrorSourceEntry[] = [];
    for (const [source, errors] of debugStore.errorsBySource) entries.push({ source, errors });
    return entries;
  });

  function childrenForCard(cardId: string) {
    return childCardsByCardId.value.get(cardId) ?? [];
  }

  return {
    tabs,
    localActiveTab,
    selectedTimelineKinds,
    runtimeStatusLabel,
    runtimeStatusTone,
    currentCardId,
    currentAgentSessionId,
    runtimeDispatchLabel,
    operatorPanelBusy,
    operatorWarningBannerMessage,
    sortedProcesses,
    timelineKindOptions,
    filteredTimeline,
    cardStatusEntries,
    maxStatusCount,
    errorSourceEntries,
    childrenForCard,
  };
}
