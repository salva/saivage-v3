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
          <button class="new-card-btn" @click="showNewCardForm = true" title="Create new card">
            + New Card
          </button>
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
          :cards="filteredCards"
          :tree="cardTree"
          :expanded-ids="expandedTreeIds"
          @toggle="toggleTreeNode"
          @select="selectCard"
          @action="handleTreeAction"
        />

        <!-- Board View -->
        <CardsBoardView
          v-else-if="activeView === 'board'"
          :board="board"
          :filtered-cards="filteredCards"
          @select="selectCard"
          @move="handleBoardMove"
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

      <!-- New Card Form Overlay -->
      <div v-if="showNewCardForm" class="modal-overlay" @click.self="showNewCardForm = false">
        <div class="modal-content">
          <h3>New Card</h3>
          <form @submit.prevent="createNewCard">
            <label>
              Title
              <input v-model="newCard.title" class="form-input" required />
            </label>
            <label>
              Type
              <select v-model="newCard.type" class="form-select" required>
                <option v-for="tp in cardTypes" :key="tp" :value="tp">{{ tp }}</option>
              </select>
            </label>
            <label>
              Parent (optional)
              <input v-model="newCard.parent" class="form-input" placeholder="parent card ID" />
            </label>
            <label>
              Description
              <textarea v-model="newCard.description" class="form-textarea" rows="3"></textarea>
            </label>
            <label>
              Priority (1-10)
              <input v-model.number="newCard.priority" type="number" min="1" max="10" class="form-input" />
            </label>
            <label>
              Tags (comma-separated)
              <input v-model="newCard.tagsStr" class="form-input" placeholder="tag1, tag2" />
            </label>
            <div class="form-actions">
              <button type="button" class="cancel-btn" @click="showNewCardForm = false">Cancel</button>
              <button type="submit" class="submit-btn">Create</button>
            </div>
          </form>
        </div>
      </div>

      <!-- Card Action Menu -->
      <div v-if="actionMenuTarget" class="modal-overlay" @click.self="actionMenuTarget = null">
        <div class="action-menu" :style="actionMenuStyle">
          <div class="action-menu-header">{{ actionMenuTarget.title }}</div>
          <button @click="doAction('edit')">✏️ Edit</button>
          <button @click="doAction('note')">📝 Add Note</button>
          <button @click="doAction('move')">📁 Move</button>
          <button class="danger-action" @click="doAction('abort')">🛑 Abort</button>
          <button class="danger-action" @click="doAction('restart')">🔄 Restart</button>
          <button class="danger-action" @click="doAction('delete')">🗑️ Delete</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, reactive } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useCardStore } from '../stores/cards';
import type {
  CardRecord,
  CardType,
  CardStatus,
  CreateCardPayload,
} from '../api/types';
import { createLogger } from '../utils/logger';
import CardsTreeView from '../components/cards/CardsTreeView.vue';
import CardsBoardView from '../components/cards/CardsBoardView.vue';
import CardsLeaderboardView from '../components/cards/CardsLeaderboardView.vue';
import CardsTimelineView from '../components/cards/CardsTimelineView.vue';
import CardDetailView from '../components/cards/CardDetailView.vue';

const log = createLogger('view:cards');

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
  cardTree,
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

const statuses: CardStatus[] = ['drafting', 'backlog', 'active', 'running', 'blocked', 'done', 'failed', 'cancelled'];
const cardTypes: CardType[] = ['project', 'goal', 'plan', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'];

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

// ── Action Menu ───────────────────────────────────────────

const actionMenuTarget = ref<CardRecord | null>(null);
const actionMenuStyle = ref({ top: '0px', left: '0px' });
const showNewCardForm = ref(false);
const newCard = reactive({
  title: '',
  type: 'code' as CardType,
  parent: '',
  description: '',
  priority: 5,
  tagsStr: '',
});

function handleTreeAction(card: CardRecord, event: MouseEvent): void {
  actionMenuTarget.value = card;
  actionMenuStyle.value = {
    top: `${event.clientY}px`,
    left: `${event.clientX}px`,
  };
}

function handleBoardMove(cardId: string, newStatus: CardStatus): void {
  cardStore.editCard(cardId, { status: newStatus }).catch((err) => {
    const msg = err instanceof Error ? err.message : 'Failed';
    log.error('board move', msg);
  });
}

async function createNewCard(): Promise<void> {
  const payload: CreateCardPayload = {
    title: newCard.title,
    type: newCard.type,
    parent: newCard.parent || null,
    description: newCard.description,
    priority: newCard.priority,
    tags: newCard.tagsStr.split(',').map(t => t.trim()).filter(Boolean),
    status: 'drafting',
    created_by: 'user',
  };

  try {
    await cardStore.addCard(payload);
    showNewCardForm.value = false;
    // Reset form
    newCard.title = '';
    newCard.type = 'code';
    newCard.parent = '';
    newCard.description = '';
    newCard.priority = 5;
    newCard.tagsStr = '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed';
    log.error('create card', msg);
  }
}

async function doAction(action: string): Promise<void> {
  const card = actionMenuTarget.value;
  if (!card) return;
  actionMenuTarget.value = null;

  switch (action) {
    case 'edit':
      // Go to detail view for editing
      selectCard(card.id);
      break;
    case 'note':
      // TODO: Open note dialog
      selectCard(card.id);
      break;
    case 'move':
      // TODO: Open move dialog
      break;
    case 'abort':
      if (confirm(`Abort "${card.title}" (${card.id})?`)) {
        await cardStore.editCard(card.id, { status: 'cancelled' });
      }
      break;
    case 'restart':
      if (confirm(`Restart "${card.title}" (${card.id})?`)) {
        await cardStore.editCard(card.id, { status: 'backlog', error: null });
      }
      break;
    case 'delete':
      if (confirm(`Delete "${card.title}" (${card.id})? This cannot be undone.`)) {
        await cardStore.removeCard(card.id);
      }
      break;
  }
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
  background: #161b22;
  border-bottom: 1px solid #30363d;
  flex-shrink: 0;
}

.back-btn {
  background: none;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 4px 10px;
  color: #58a6ff;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.back-btn:hover {
  background: #21262d;
}

.card-id-path {
  font-size: 11px;
  color: #484f58;
  font-family: 'SF Mono', monospace;
}

/* ── Toolbar ────────────────────────────────────────────── */

.cards-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: #161b22;
  border-bottom: 1px solid #30363d;
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
  background: #21262d;
  border-radius: 6px;
  padding: 2px;
}

.view-tab {
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 500;
  color: #8b949e;
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
}

.view-tab:hover {
  color: #c9d1d9;
}

.view-tab.active {
  background: #30363d;
  color: #f0f6fc;
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
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #c9d1d9;
  font-size: 12px;
  font-family: inherit;
}

.search-input:focus {
  outline: none;
  border-color: #58a6ff;
}

.search-input::placeholder {
  color: #484f58;
}

.filter-select {
  padding: 5px 8px;
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #c9d1d9;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.filter-select:focus {
  outline: none;
  border-color: #58a6ff;
}

.new-card-btn {
  padding: 5px 12px;
  background: #238636;
  border: 1px solid #2ea043;
  border-radius: 4px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
  font-family: inherit;
  white-space: nowrap;
}

.new-card-btn:hover {
  background: #2ea043;
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
  color: #8b949e;
  font-size: 13px;
}

.cards-error {
  color: #f85149;
}

/* ── Modal ──────────────────────────────────────────────── */

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal-content {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 20px;
  min-width: 400px;
  max-width: 500px;
}

.modal-content h3 {
  margin: 0 0 16px 0;
  font-size: 16px;
  color: #f0f6fc;
}

.modal-content label {
  display: block;
  margin-bottom: 10px;
  font-size: 12px;
  color: #8b949e;
}

.form-input,
.form-select,
.form-textarea {
  display: block;
  width: 100%;
  margin-top: 4px;
  padding: 6px 10px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #c9d1d9;
  font-size: 13px;
  font-family: inherit;
  box-sizing: border-box;
}

.form-textarea {
  resize: vertical;
}

.form-input:focus,
.form-select:focus,
.form-textarea:focus {
  outline: none;
  border-color: #58a6ff;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.cancel-btn {
  padding: 6px 14px;
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #c9d1d9;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}

.submit-btn {
  padding: 6px 14px;
  background: #238636;
  border: 1px solid #2ea043;
  border-radius: 4px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}

/* ── Action Menu ────────────────────────────────────────── */

.action-menu {
  position: fixed;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  min-width: 160px;
  padding: 4px 0;
  z-index: 200;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}

.action-menu-header {
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  color: #8b949e;
  border-bottom: 1px solid #21262d;
  margin-bottom: 4px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action-menu button {
  display: block;
  width: 100%;
  padding: 6px 12px;
  background: none;
  border: none;
  color: #c9d1d9;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.1s;
}

.action-menu button:hover {
  background: #21262d;
}

.action-menu button.danger-action {
  color: #f85149;
}

.action-menu button.danger-action:hover {
  background: #241818;
}
</style>
