<template>
  <div class="conversations-facet" data-testid="facet-conversations">
    <ParticipantRail :card-id="cardId" :detail="detail" :selected-session-id="selectedSessionId" @select="selectSession" />
    <section class="focused-reader" aria-label="Focused conversation reader">
      <ViewState
        v-if="!selectedSessionId"
        state="empty"
        title="Select a participant session"
        message="Choosing a rail session opens the exact session reader for this card; the card header and rail remain visible as context."
        class="reader-empty"
      />
    </section>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import type { CardDetail } from '../../api/types';
import type { ConversationSessionId } from '../../api/contracts';
import ParticipantRail from './ParticipantRail.vue';

defineProps<{ cardId: string; detail: CardDetail | null; selectedSessionId: ConversationSessionId | null }>();

const router = useRouter();

function selectSession(id: ConversationSessionId): void {
  void router.push({ name: 'agent-detail', params: { id } });
}
</script>

<style scoped>
.conversations-facet { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(0, 2.2fr); height: 100%; min-height: 0; }
.conversations-facet > :deep(.participant-rail) { border-right: 1px solid var(--border); }
.focused-reader { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.reader-empty { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; }
</style>
