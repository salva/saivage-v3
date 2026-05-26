<template>
  <div class="cards-layout">
    <!-- When viewing card detail, show back button -->
    <div v-if="currentCardId" class="detail-view">
      <div class="detail-header-bar">
        <button class="back-btn" @click="goBack">
          ← Back to Cards
        </button>
        <span class="card-id-path">{{ currentCardId }}</span>
      </div>
      <CardDetailView
        :card-id="currentCardId"
        @navigate="handleNavigate"
      />
    </div>

    <!-- Otherwise show list/board/timeline view -->
    <template v-else>
      <!-- Toolbar -->
      <div class="cards-toolbar">
        <div class="toolbar-left">
          <div class="view-tabs">
            <button
              v-for="tab in viewTabs"
              :key="tab.id"
              class="view-tab"
              :class="{ active: activeView === tab.id }"
              @click="activeView = tab.id"
            >
              {{ tab.label }}
            </button>
          </div>
        </div>
        <div class="toolbar-right">
          <div class="filter-group">
            <input
              v-model="searchQuery"
              class="search-input"
              placeholder="Search cards..."
              @input="onSearchChange"
            />
            <select v-model="filterStatus" class="filter-select" @change="applyFilters">
              <option value="">All Statuses</option>
              <option v-for="st in statuses" :key="st" :value="st">{{ st }}</option>
            </select>
            <select v-model="filterType" class="filter-select" @change="applyFilters">
              <option value="">All Types</option>
              <option v-for="tp in cardTypes" :key="tp" :value="tp">{{ tp }}</option>
            </select>
            <select v-model="filterTag" class="filter-select" @change="applyFilters">
              <option value="">All Tags</option>
              <option v-for="tag in allTags" :key="tag" :value="tag">{{ tag }}</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Content area -->
      <div class="cards-content">
        <!-- Loading -->
        <div v-if="loading" class="cards-loading">Loading cards...</div>

        <!-- Error -->
        <div v-else-if="errorMsg" class="cards-error">{{ errorMsg }}</div>

        <!-- Tree View -->
        <CardsTreeView
          v-else-if="activeView === 'tree'"
          :cards="orderedFilteredCards"
          :tree="orderedCardTree"
          :expanded-ids="expandedTreeIds"
          @toggle="toggleTreeNode"
          @select="selectCard"
        />

        <!-- Board View -->
        <CardsBoardView
          v-else-if="activeView === 'board'"
          :board="board"
          :filtered-cards="filteredCards"
          @select="selectCard"
        />

        <!-- Leaderboard View -->
        <CardsLeaderboardView
          v-else-if="activeView === 'leaderboard'"
          :cards="filteredCards"
          @select="selectCard"
        />

        <!-- Timeline View -->
        <CardsTimelineView
          v-else-if="activeView === 'timeline'"
          :cards="filteredCards"
          @select="selectCard"
        />
      </div>

    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useCardStore } from '../stores/cards';
import type { CardType, CardStatus } from '../api/types';
import CardsTreeView from '../components/cards/CardsTreeView.vue';
import CardsBoardView from '../components/cards/CardsBoardView.vue';
import CardsLeaderboardView from '../components/cards/CardsLeaderboardView.vue';
import CardsTimelineView from '../components/cards/CardsTimelineView.vue';
import CardDetailView from '../components/cards/CardDetailView.vue';


// ── Router ────────────────────────────────────────────────

const route = useRoute();
const router = useRouter();

const currentCardId = computed<string | null>(() => {
  const id = route.params.id as string;
  return id || null;
});

// ── Store ─────────────────────────────────────────────────

const cardStore = useCardStore();
const {
  cards,
  orderedFilteredCards,
  orderedCardTree,
  board,
  loading,
  error,
  filteredCards,
  total,
  filterStatus: storeFilterStatus,
  filterType: storeFilterType,
  filterTag: storeFilterTag,
  searchQuery: storeSearchQuery,
} = storeToRefs(cardStore);

const errorMsg = computed(() => error.value);

// ── View State ────────────────────────────────────────────

const activeView = ref<'tree' | 'board' | 'leaderboard' | 'timeline'>('tree');
const viewTabs = [
  { id: 'tree' as const, label: 'Tree' },
  { id: 'board' as const, label: 'Board' },
  { id: 'leaderboard' as const, label: 'Leaderboard' },
  { id: 'timeline' as const, label: 'Timeline' },
];

const statuses: CardStatus[] = ['drafting', 'backlog', 'active', 'running', 'blocked', 'changed', 'done', 'failed', 'cancelled', 'needs_verification'];
const cardTypes: CardType[] = ['project', 'goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'];

// ── Filter State (local, synced to store) ─────────────────

const filterStatus = ref('');
const filterType = ref('');
const filterTag = ref('');
const searchQuery = ref('');

const allTags = computed<string[]>(() => {
  const set = new Set<string>();
  for (const card of cards.value) {
    for (const tag of card.tags) {
      if (tag) set.add(tag);
    }
  }
  return [...set].sort();
});

function applyFilters(): void {
  cardStore.filterStatus = filterStatus.value as CardStatus | '';
  cardStore.filterType = filterType.value as CardType | '';
  cardStore.filterTag = filterTag.value;
  cardStore.searchQuery = searchQuery.value;
  cardStore.applyFilters().catch(() => {});
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;
function onSearchChange(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    cardStore.searchQuery = searchQuery.value;
    applyFilters();
  }, 300);
}

// ── Tree State ────────────────────────────────────────────

const expandedTreeIds = ref<Set<string>>(new Set());

function toggleTreeNode(id: string): void {
  const set = new Set(expandedTreeIds.value);
  if (set.has(id)) {
    set.delete(id);
  } else {
    set.add(id);
  }
  expandedTreeIds.value = set;
}

function selectCard(id: string): void {
  router.push({ name: 'card-detail', params: { id } });
}


// ── Navigation ────────────────────────────────────────────

function goBack(): void {
  router.push({ name: 'cards' });
}

function handleNavigate(id: string): void {
  router.push({ name: 'card-detail', params: { id } });
}

// ── Lifecycle ─────────────────────────────────────────────

onMounted(async () => {
  cardStore.setupWsListener();
  try {
    await cardStore.fetchCards();
  } catch {
    // Error in store
  }
  // Expand project card by default
  if (cards.value.length > 0) {
    const projectCard = cards.value.find(c => c.type === 'project');
    if (projectCard) {
      expandedTreeIds.value = new Set([projectCard.id]);
    }
  }
});

// Watch for route changes back to /cards
watch(() => route.params.id, (newId) => {
  if (!newId) {
    // Returned to list view
  }
});
</script>

<style scoped>
.cards-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ── Detail View ────────────────────────────────────────── */

.detail-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.detail-header-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.back-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 10px;
  color: var(--accent-2);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.back-btn:hover {
  background: var(--surface-3);
}

.card-id-path {
  font-size: 11px;
  color: var(--border-strong);
  font-family: 'SF Mono', monospace;
}

/* ── Toolbar ────────────────────────────────────────────── */

.cards-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  gap: 12px;
  flex-wrap: wrap;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.view-tabs {
  display: flex;
  gap: 2px;
  background: var(--surface-3);
  border-radius: 6px;
  padding: 2px;
}

.view-tab {
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
}

.view-tab:hover {
  color: var(--text);
}

.view-tab.active {
  background: var(--border);
  color: var(--text);
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-group {
  display: flex;
  gap: 4px;
}

.search-input {
  width: 180px;
  padding: 5px 10px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
}

.search-input:focus {
  outline: none;
  border-color: var(--accent-2);
}

.search-input::placeholder {
  color: var(--border-strong);
}

.filter-select {
  padding: 5px 8px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.filter-select:focus {
  outline: none;
  border-color: var(--accent-2);
}


/* ── Content ────────────────────────────────────────────── */

.cards-content {
  flex: 1;
  overflow: auto;
}

.cards-loading,
.cards-error {
  padding: 32px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.cards-error {
  color: var(--danger);
}

</style>
