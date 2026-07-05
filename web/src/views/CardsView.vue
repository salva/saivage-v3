<template>
  <div class="cards-md" :class="{ 'has-selection': !!currentCardId }">
    <aside class="cards-md__list">
      <div class="cards-filters">
        <input class="filter-search" :value="searchQuery" placeholder="Search…" aria-label="Search cards" @input="searchQuery = ($event.target as HTMLInputElement).value" />
        <select :value="filterStatus" aria-label="Filter by status" @change="filterStatus = ($event.target as HTMLSelectElement).value as CardStatus | ''">
          <option value="">Any status</option>
          <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
        </select>
        <select :value="filterType" aria-label="Filter by type" @change="filterType = ($event.target as HTMLSelectElement).value as CardType | ''">
          <option value="">Any type</option>
          <option v-for="t in TYPES" :key="t" :value="t">{{ shortLabelForCardType(t) }}</option>
        </select>
        <button v-if="hasFilters" type="button" class="filter-clear" @click="clearFilters">Clear</button>
      </div>
      <div class="cards-md__tree">
        <ViewState v-if="loading" state="loading" title="Loading cards" />
        <ViewState v-else-if="errorMsg" state="error" title="Could not load cards" :message="errorMsg" />
        <CardsTreeView
          v-else
          :cards="orderedCards"
          :tree="orderedCardTree"
          :expanded-ids="expandedTreeIds"
          @toggle="toggleTreeNode"
          @select="selectCard"
        />
      </div>
    </aside>

    <section class="cards-md__detail">
      <CardDetailView v-if="currentCardId" :card-id="currentCardId" @navigate="handleNavigate" />
      <ViewState v-else class="cards-md__empty" state="empty" title="Select a card to inspect" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useCardStore } from '../stores/cards';
import type { CardStatus, CardType } from '../types/view-models';
import { shortLabelForCardType } from '../utils/status';
import CardsTreeView from '../components/cards/CardsTreeView.vue';
import CardDetailView from '../components/cards/CardDetailView.vue';
import ViewState from '../components/ui/ViewState.vue';
import { useCardBrowserReadModel } from '../composables/useCardBrowserReadModel';

const STATUSES: CardStatus[] = ['backlog', 'running', 'blocked', 'changed', 'done', 'failed', 'cancelled', 'needs_verification'];
const TYPES: CardType[] = ['project', 'goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'];

const route = useRoute();
const router = useRouter();

const cardStore = useCardStore();
const {
  orderedCards,
  orderedCardTree,
  loading,
  errorMsg,
  filterStatus,
  filterType,
  searchQuery,
  expandedTreeIds,
  toggleTreeNode,
  expandProjectByDefault,
} = useCardBrowserReadModel(cardStore);

const currentCardId = computed<string | null>(() => {
  const id = route.params.id as string;
  return id || null;
});

const hasFilters = computed(() => !!filterStatus.value || !!filterType.value || !!searchQuery.value);

function selectCard(id: string): void {
  router.push({ name: 'card-detail', params: { id } });
}

function handleNavigate(id: string): void {
  router.push({ name: 'card-detail', params: { id } });
}

function clearFilters(): void {
  cardStore.clearFilters();
}

onMounted(async () => {
  try {
    await cardStore.fetchCards();
  } catch {
    // Error surfaced via store state.
  }
  expandProjectByDefault();
});
</script>

<style scoped>
.cards-md { display: grid; grid-template-columns: minmax(280px, 36%) 1fr; height: 100%; min-height: 0; }

.cards-md__list { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--bg); }
.cards-filters { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border); background: var(--surface-1); flex-wrap: wrap; }
.filter-search { flex: 1; min-width: 120px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text); font: inherit; font-size: 12px; }
.filter-search:focus { outline: none; border-color: var(--accent-2); }
.cards-filters select { padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-1); color: var(--text); font: inherit; font-size: 12px; }
.filter-clear { padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; background: transparent; color: var(--text-muted); font: inherit; font-size: 11px; cursor: pointer; }
.filter-clear:hover { color: var(--text); border-color: var(--border-strong); }

.cards-md__tree { flex: 1; overflow: auto; min-height: 0; }
.cards-md__tree > :deep(.view-state) { padding: 24px; justify-content: center; text-align: center; }

.cards-md__detail { min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.cards-md__empty { display: flex; align-items: center; justify-content: center; height: 100%; }

@media (max-width: 880px) {
  .cards-md { grid-template-columns: 1fr; }
  .cards-md.has-selection .cards-md__list { display: none; }
}
</style>
