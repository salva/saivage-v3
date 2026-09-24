<template>
  <div class="cockpit-route" data-testid="route-cockpit">
    <aside class="cockpit-tree" aria-label="Card tree">
      <div class="cockpit-tree-filter">
        <label class="tree-filter-label" for="cockpit-tree-filter">Loaded branches</label>
        <input id="cockpit-tree-filter" v-model="treeFilter" type="search" class="tree-filter-input" placeholder="Filter loaded branches" />
      </div>
      <ViewState v-if="rootLoadState.status === 'loading' || rootLoadState.status === 'undiscovered'" state="loading" title="Loading cards" />
      <ViewState v-else-if="rootLoadState.status === 'error'" state="error" title="Could not load cards" :message="rootLoadState.error ?? undefined">
        <template #action><button type="button" @click="retryRoot">Retry</button></template>
      </ViewState>
      <div v-else class="cockpit-tree-scroll">
        <CardsTreeView
          :tree="filteredTree"
          :expanded-ids="effectiveExpandedTreeIds"
          :forced-expanded-ids="representedSelectedAncestorIds"
          :selected-card-id="subjectCardId"
          :load-state-for="cardStore.childrenLoadState"
          @toggle="toggleTreeNode"
          @retry="retryChildren"
          @select="selectCard"
        />
      </div>
    </aside>

    <section class="cockpit-center" aria-label="Card cockpit">
      <div v-if="subjectCardId" class="cockpit-subject-bar" data-testid="cockpit-subject-bar">
        <span data-testid="cockpit-inspecting">Inspecting {{ subjectTitle }}</span>
        <span v-if="runtimeLoaded && currentCardId && currentCardId !== subjectCardId" class="cockpit-current-note">
          Current work: <router-link :to="{ name: 'card-detail', params: { id: currentCardId } }">{{ currentWorkTitle }}</router-link>
          <button type="button" class="cockpit-goto-current" data-testid="go-to-current-work" @click="goToCurrentWork">Go to current work</button>
        </span>
        <span v-else-if="runtimeLoaded && !currentCardId" class="cockpit-current-note">No current work.</span>
      </div>

      <nav v-if="subjectCardId && subjectDetail" class="cockpit-facet-nav" aria-label="Card facets" data-testid="cockpit-facet-nav">
        <router-link class="cockpit-facet-link" :class="{ active: facet === 'overview' }" :to="facetLink('overview')">Overview</router-link>
        <router-link class="cockpit-facet-link" :class="{ active: facet === 'conversations' }" :to="facetLink('conversations')">Conversations</router-link>
        <router-link class="cockpit-facet-link" :class="{ active: facet === 'records' }" :to="facetLink('records')">Records &amp; History</router-link>
      </nav>

      <template v-if="routeMode === 'home'">
        <ViewState v-if="!runtimeLoaded && runtimeLoading" state="loading" title="Observing runtime" message="The current work selection appears once the runtime observation is accepted." />
        <ViewState v-else-if="!runtimeLoaded && runtimeError" state="error" title="Runtime observation failed" :message="runtimeError">
          <template #action><button type="button" @click="retryRuntime">Retry</button></template>
        </ViewState>
        <ViewState v-else-if="runtimeUnauthorized" state="unauthorized" title="Runtime observation unauthorized" message="The operator API rejected this browser. Runtime-controlled selection is unavailable." />
        <ViewState v-else-if="!runtimeLoaded" state="loading" title="Runtime observation not yet accepted" message="Current work is unknown until the runtime observation is accepted; absence is not guessed." />
        <ViewState v-else-if="!currentCardId" state="empty" title="No current work" message="The project is not executing a current card. This is accepted absence, not an executing root." data-testid="home-no-current" />
        <template v-else-if="homeSubject">
          <CardFlowHeader :card-id="homeSubject" :detail="subjectDetail" :position="subjectPosition" />
          <CardOverviewFacet v-if="facet === 'overview'" :card-id="homeSubject" :detail="subjectDetail" />
          <CardConversationsFacet v-else-if="facet === 'conversations'" :card-id="homeSubject" :detail="subjectDetail" :selected-session-id="null" />
          <CardRecordsFacet v-else :card-id="homeSubject" />
        </template>
      </template>

      <template v-else-if="routeMode === 'cards' && !subjectCardId">
        <ViewState state="empty" title="Select a card to inspect" message="The tree is the cockpit's structural spine. Exact card URLs always take precedence over automatic selection." />
      </template>

      <template v-else-if="subjectCardId">
        <ViewState v-if="routeLoading" state="loading" title="Loading card" />
        <ViewState v-else-if="showNotFound" state="error" title="Card not found" message="This card is not available in the current hierarchy. This link may be obsolete after a reset." />
        <StatusBanner v-else-if="detailError && !subjectDetail" tone="danger" :title="detailErrorTitle" :message="detailError.message">
          <template #action><button type="button" @click="reloadDetail">Retry</button></template>
        </StatusBanner>
        <template v-else-if="subjectDetail">
          <StatusBanner v-if="selectedDetailFreshness.stale" tone="warning" title="Card detail is stale" :message="selectedDetailFreshness.refreshError ?? 'Refreshing card detail.'">
            <template #action><button v-if="selectedDetailFreshness.staleReason === 'refresh-failed'" type="button" @click="retryDetail">Retry</button></template>
          </StatusBanner>
          <CardFlowHeader :card-id="subjectCardId" :detail="subjectDetail" :position="subjectPosition" />
          <CardOverviewFacet v-if="facet === 'overview'" :card-id="subjectCardId" :detail="subjectDetail" />
          <CardConversationsFacet v-else-if="facet === 'conversations'" :card-id="subjectCardId" :detail="subjectDetail" :selected-session-id="null" />
          <CardRecordsFacet v-else :card-id="subjectCardId" />
        </template>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { cardRouteChain, useCardStore } from '../stores/cards';
import { useRuntimeStore } from '../stores/runtime';
import { useCardBrowserReadModel } from '../composables/useCardBrowserReadModel';
import CardsTreeView from '../components/cards/CardsTreeView.vue';
import CardFlowHeader from '../components/cockpit/CardFlowHeader.vue';
import CardOverviewFacet from '../components/cockpit/CardOverviewFacet.vue';
import CardConversationsFacet from '../components/cockpit/CardConversationsFacet.vue';
import CardRecordsFacet from '../components/cockpit/CardRecordsFacet.vue';
import ViewState from '../components/ui/ViewState.vue';
import StatusBanner from '../components/ui/StatusBanner.vue';
import type { DetailErrorState } from '../api/types';

const route = useRoute();
const router = useRouter();
const cardStore = useCardStore();
const runtimeStore = useRuntimeStore();
const {
  selectedDetail,
  selectedDetailError,
  selectedDetailLoading,
  selectedDetailFreshness,
} = storeToRefs(cardStore);
const {
  loaded: runtimeLoaded,
  loading: runtimeLoading,
  error: runtimeError,
  unauthorized: runtimeUnauthorized,
  currentCardId,
} = storeToRefs(runtimeStore);

const routeMode = computed<'home' | 'cards'>(() => (route.name === 'home' ? 'home' : 'cards'));
const subjectCardId = computed<string | null>(() => {
  if (routeMode.value === 'home') return runtimeLoaded.value ? currentCardId.value : null;
  const id = route.params.id as string;
  return id || null;
});
const homeSubject = computed(() => (routeMode.value === 'home' ? subjectCardId.value : null));

const facet = computed<'overview' | 'conversations' | 'records'>(() => {
  const value = route.query.facet;
  return value === 'conversations' || value === 'records' ? value : 'overview';
});

const treeFilter = ref('');
const { orderedCardTree, rootLoadState, effectiveExpandedTreeIds, representedSelectedAncestorIds, toggleTreeNode } =
  useCardBrowserReadModel(cardStore, () => subjectCardId.value);

const filteredTree = computed(() => {
  const needle = treeFilter.value.trim().toLowerCase();
  if (!needle) return orderedCardTree.value;
  const filterNodes = (nodes: typeof orderedCardTree.value): typeof orderedCardTree.value =>
    nodes
      .map((node) => {
        const children = filterNodes(node.childNodes);
        if (node.card.title.toLowerCase().includes(needle) || children.length > 0) return { ...node, childNodes: children };
        return null;
      })
      .filter((node): node is NonNullable<typeof node> => node !== null);
  return filterNodes(orderedCardTree.value);
});

const ownsRoute = computed(() => cardStore.selectedCardId === subjectCardId.value);
const subjectDetail = computed(() => ownsRoute.value && selectedDetail.value?.cardId === subjectCardId.value ? selectedDetail.value.card : null);
const detailError = computed<DetailErrorState | null>(() => ownsRoute.value ? selectedDetailError.value : null);
const validRoute = computed(() => !subjectCardId.value || cardRouteChain(subjectCardId.value).length > 0);
const routeLoading = computed(() => validRoute.value && !subjectDetail.value && (!ownsRoute.value || selectedDetailLoading.value));
const showNotFound = computed(() => !validRoute.value || detailError.value?.kind === 'not-found');
const detailErrorTitle = computed(() => {
  switch (detailError.value?.kind) {
    case 'unauthorized': return 'Unauthorized';
    case 'not-found': return 'Card not found';
    case 'server': return 'Card detail unavailable';
    case 'network': return 'Network error';
    default: return 'Card detail error';
  }
});

const subjectPosition = computed(() => (subjectCardId.value ? runtimeStore.cardWorkflowPosition(subjectCardId.value) : null));
const subjectTitle = computed(() => subjectDetail.value?.title ?? subjectCardId.value ?? '');
const currentWorkTitle = computed(() => {
  const id = currentCardId.value;
  if (!id) return '';
  const card = cardStore.hierarchyCardById(id);
  return card?.title ?? id;
});

watch(subjectCardId, (id) => {
  if (id && cardRouteChain(id).length > 0) {
    void cardStore.ensureRouteVisible(id);
    if (cardStore.selectedCardId !== id) void cardStore.fetchCardDetail(id).catch(() => {});
  } else if (!id) {
    cardStore.clearCardSelection();
  }
}, { immediate: true });

watch(() => cardStore.hierarchySlicesByParentId, (current, previous) => {
  const id = subjectCardId.value;
  if (!id) return;
  const ancestors = new Set(cardRouteChain(id).slice(0, -1));
  if (Object.keys(current).some((parentId) => ancestors.has(parentId) && current[parentId] !== previous?.[parentId] && !cardStore.childrenLoadState(parentId).stale)) {
    void cardStore.ensureRouteVisible(id);
  }
}, { deep: false });

function retryRoot(): void { void cardStore.retryChildren('project').catch(() => {}); }
function retryChildren(id: string): void { void cardStore.retryChildren(id).catch(() => {}); }
function selectCard(id: string): void { router.push({ name: 'card-detail', params: { id } }); }
function facetLink(facetName: 'overview' | 'conversations' | 'records'): { name: string; params: { id: string }; query: Record<string, string> } {
  return { name: 'card-detail', params: { id: subjectCardId.value ?? '' }, query: facetName === 'overview' ? {} : { facet: facetName } };
}
function goToCurrentWork(): void {
  if (currentCardId.value) router.push({ name: 'card-detail', params: { id: currentCardId.value } });
}
function retryRuntime(): void { void runtimeStore.fetchState().catch(() => {}); }
async function reloadDetail(): Promise<void> {
  if (subjectCardId.value) await cardStore.fetchCardDetail(subjectCardId.value).catch(() => {});
}
async function retryDetail(): Promise<void> { await cardStore.retryCardDetail(); }
</script>

<style scoped>
.cockpit-route { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(0, 5fr); height: 100%; min-height: 0; overflow: hidden; }
.cockpit-tree { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--bg); }
.cockpit-tree-filter { padding: 8px; border-bottom: 1px solid var(--surface-3); display: flex; flex-direction: column; gap: 4px; }
.tree-filter-label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.tree-filter-input { padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); color: var(--text); font: inherit; font-size: 12px; }
.cockpit-tree-scroll { flex: 1; overflow-y: auto; min-height: 0; }
.cockpit-tree > :deep(.view-state) { padding: 24px 12px; justify-content: center; text-align: center; }
.cockpit-center { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.cockpit-subject-bar {
  display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
  padding: 6px 16px; border-bottom: 1px solid var(--surface-3); background: var(--surface-2);
  font-size: 12px; color: var(--text-muted); flex-shrink: 0;
}
.cockpit-subject-bar[data-inspecting] { font-weight: 600; }
.cockpit-current-note a { color: var(--accent-2); text-decoration: underline; }
.cockpit-goto-current {
  margin-left: 8px; padding: 2px 10px; border: 1px solid var(--border-strong); border-radius: 6px;
  background: var(--surface-2); color: var(--text); font: inherit; font-size: 11px; cursor: pointer;
}
.cockpit-facet-nav {
  display: flex; gap: 2px; padding: 4px 16px; border-bottom: 1px solid var(--border);
  background: var(--surface-1); flex-shrink: 0;
}
.cockpit-facet-link {
  padding: 4px 12px; border-radius: 6px 6px 0 0; font-size: 12px; font-weight: 600;
  color: var(--text-muted); text-decoration: none;
}
.cockpit-facet-link:hover { color: var(--text); background: var(--surface-3); }
.cockpit-facet-link.active { color: var(--accent-2); background: var(--entry-user-bg); }
.cockpit-center > :deep(.view-state) { padding: 32px; justify-content: center; text-align: center; }
.cockpit-center > :deep(.status-banner) { margin: 8px 16px; }
.cockpit-center > :deep(.overview-facet) { flex: 1; min-height: 0; overflow-y: auto; }
.cockpit-center > :deep(.conversations-facet) { flex: 1; min-height: 0; }
.cockpit-center > :deep(.records-facet) { flex: 1; min-height: 0; }
</style>
