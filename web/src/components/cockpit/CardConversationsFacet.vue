<template>
  <div class="conversations-facet" :class="{ 'with-rail': railAdmitted }" data-testid="facet-conversations">
    <ParticipantRail
      v-if="railAdmitted"
      :card-id="cardId"
      :detail="detail"
      :selected-session-id="selectedSessionId"
      @select="selectSession"
      @auto-select="selectAutomaticSession"
    />
    <section class="focused-reader" aria-label="Focused conversation reader">
      <ViewState
        v-if="!selectedSessionId"
        state="empty"
        title="Select a participant session"
        message="Choosing a rail session opens the exact session reader for this card; the card header and rail remain visible as context."
        class="reader-empty"
      />
      <AgentConversationView
        v-else
        :key="selectedSessionId"
        :session-id="selectedSessionId"
        :entry-id="entryId"
      />
    </section>
  </div>
</template>

<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import type { CardDetail } from '../../api/types';
import type { ConversationSessionId } from '../../api/contracts';
import ParticipantRail from './ParticipantRail.vue';
import AgentConversationView from '../agents/AgentConversationView.vue';
import ViewState from '../ui/ViewState.vue';
import { useWorkspaceRouteStore } from '../../stores/workspaceRoute';

defineProps<{
  cardId: string;
  detail: CardDetail | null;
  selectedSessionId: ConversationSessionId | null;
  entryId: string | null;
  railAdmitted: boolean;
}>();

const route = useRoute();
const router = useRouter();
const workspaceRoute = useWorkspaceRouteStore();

function selectSession(id: ConversationSessionId): void {
  void router.push({ name: 'agent-detail', params: { id } });
}

function selectAutomaticSession(id: ConversationSessionId): void {
  void workspaceRoute.replaceWithAutomaticSession(route, id);
}
</script>

<style scoped>
.conversations-facet { display: grid; grid-template-columns: minmax(0, 1fr); height: 100%; min-height: 0; min-width: 0; overflow: hidden; }
.conversations-facet > :deep(.participant-rail) { border-right: 1px solid var(--border); }
.focused-reader { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.reader-empty { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; }
@media (min-width: 700px) {
  .conversations-facet.with-rail { grid-template-columns: minmax(190px, 1fr) minmax(0, 2.2fr); }
}
</style>
