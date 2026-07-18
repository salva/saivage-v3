import { computed, ref } from 'vue';
import type { DebugError } from '../api/types';
import type { useDebugStore } from '../stores/debug';
import type { useRuntimeStore } from '../stores/runtime';
import {
  filterTimelineByKinds,
  selectRuntimeStatusLabel,
  selectRuntimeStatusTone,
  selectSortedProcesses,
  selectTimelineKindOptions,
} from '../stores/debug-read-model';
import { selectCurrentCardId } from '../stores/runtime-read-model';

export interface ErrorSourceEntry { source: string; errors: DebugError[] }
export type DebugTabId = 'state' | 'operator' | 'errors' | 'timeline' | 'agents' | 'mcp' | 'processes' | 'supervision';

export function useDebugReadModel(debugStore: ReturnType<typeof useDebugStore>, runtimeStore: ReturnType<typeof useRuntimeStore>) {
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

  const runtimeStatusLabel = computed(() => selectRuntimeStatusLabel(runtimeStore.runtime));
  const runtimeStatusTone = computed(() => selectRuntimeStatusTone(runtimeStore.runtime));
  const currentCardId = computed(() => selectCurrentCardId(runtimeStore.runtime));
  const operatorPanelBusy = computed(() => runtimeStore.loading || runtimeStore.refreshing);
  const sortedProcesses = computed(() => selectSortedProcesses(debugStore.processes));
  const timelineKindOptions = computed(() => selectTimelineKindOptions(debugStore.sortedTimeline));
  const filteredTimeline = computed(() => filterTimelineByKinds(debugStore.sortedTimeline, selectedTimelineKinds.value));
  const errorSourceEntries = computed<ErrorSourceEntry[]>(() => {
    const entries: ErrorSourceEntry[] = [];
    for (const [source, errors] of debugStore.errorsBySource) entries.push({ source, errors });
    return entries;
  });

  return {
    tabs,
    localActiveTab,
    selectedTimelineKinds,
    runtimeStatusLabel,
    runtimeStatusTone,
    currentCardId,
    operatorPanelBusy,
    sortedProcesses,
    timelineKindOptions,
    filteredTimeline,
    errorSourceEntries,
  };
}
