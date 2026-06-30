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

    <!-- Otherwise show tree view -->
    <template v-else>
      <div class="cards-toolbar">
        <div class="toolbar-title">Card Tree</div>
        <router-link class="timeline-link" :to="{ name: 'timeline' }">Open Timeline</router-link>
      </div>

      <!-- Content area -->
      <div class="cards-content">
        <!-- Loading -->
        <div v-if="loading" class="cards-loading">Loading cards...</div>

        <!-- Error -->
        <div v-else-if="errorMsg" class="cards-error">{{ errorMsg }}</div>

        <CardsTreeView
          v-else
          :cards="orderedCards"
          :tree="orderedCardTree"
          :expanded-ids="expandedTreeIds"
          @toggle="toggleTreeNode"
          @select="selectCard"
        />
      </div>

    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useCardStore } from '../stores/cards';
import CardsTreeView from '../components/cards/CardsTreeView.vue';
import CardDetailView from '../components/cards/CardDetailView.vue';
import { useCardBrowserReadModel } from '../composables/useCardBrowserReadModel';


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
  orderedCards,
  orderedCardTree,
  loading,
  errorMsg,
  expandedTreeIds,
  toggleTreeNode,
  expandProjectByDefault,
} = useCardBrowserReadModel(cardStore);

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
  try {
    await cardStore.fetchCards();
  } catch {
    // Error in store
  }
  expandProjectByDefault();
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

.toolbar-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.timeline-link {
  color: var(--accent-2);
  font-size: 12px;
  text-decoration: none;
}

.timeline-link:hover { text-decoration: underline; }

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
