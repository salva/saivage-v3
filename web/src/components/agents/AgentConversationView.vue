<template>
  <div class="conversation-container">
    <div v-if="loading" class="conv-loading">Loading conversation...</div>
    <div v-else-if="errorMsg" class="conv-error">{{ errorMsg }}</div>
    <div v-else-if="!currentSession" class="conv-empty">
      Select a session to view its conversation.
    </div>
    <template v-else>
      <div class="conv-header">
        <div class="conv-info">
          <span class="conv-role">{{ currentSession.role }}</span>
          <span class="conv-model">{{ currentSession.model || 'default' }}</span>
          <span class="conv-status-badge" :class="'s-' + currentSession.status">{{ currentSession.status }}</span>
        </div>
        <div class="conv-toolbar">
          <button class="conv-tb-btn" @click="agentStore.expandAll()" title="Expand all">Expand all</button>
          <button class="conv-tb-btn" @click="agentStore.collapseAll()" title="Collapse all">Collapse all</button>
        </div>
      </div>

      <div v-if="conversationWarning" class="conv-warning">
        {{ conversationWarning }}
      </div>

      <div class="conv-messages">
        <div v-for="(step, idx) in steps" :key="idx" class="conv-step">
          <div
            v-if="step.reasoning"
            class="conv-message"
            :class="['role-' + step.reasoning.role, 'kind-' + step.reasoning.kind]"
          >
            <div class="msg-meta">
              <span class="msg-role">{{ step.reasoning.role }}</span>
              <span class="msg-time" :title="timestampTitle(step.reasoning.timestamp)">{{ fmtTime(step.reasoning.timestamp) }}</span>
            </div>
            <div class="msg-content" v-html="renderContent(step.reasoning)"></div>
            <div v-if="step.reasoning.links?.length" class="msg-links">
              <button
                v-for="link in step.reasoning.links"
                :key="`${link.entity_type}:${link.entity_id}`"
                type="button"
                class="msg-link"
                :class="`msg-link-${link.entity_type}`"
                @click="navigateToLink(link)"
              >
                {{ linkLabel(link) }}
              </button>
            </div>
          </div>

          <div
            v-if="step.toolCall"
            class="conv-message tool-call"
            :class="{ expanded: expandedToolCalls.has(step.toolCall.id) }"
          >
            <div class="tc-header" @click="agentStore.toggleToolCall(step.toolCall.id)">
              <span class="tc-toggle">{{ expandedToolCalls.has(step.toolCall.id) ? '-' : '+' }}</span>
              <span class="tc-tool">
                <span class="tc-icon" aria-hidden="true">{{ toolCallView(step.toolCall).icon }}</span>
                <span class="tc-name">{{ toolCallView(step.toolCall).name }}</span>
                <span v-if="toolCallView(step.toolCall).headline" class="tc-headline">{{ toolCallView(step.toolCall).headline }}</span>
                <span v-if="toolCallView(step.toolCall).detail" class="tc-detail">{{ toolCallView(step.toolCall).detail }}</span>
              </span>
              <span class="tc-time" :title="timestampTitle(step.toolCall.timestamp)">{{ fmtTime(step.toolCall.timestamp) }}</span>
            </div>
            <pre v-if="expandedToolCalls.has(step.toolCall.id)" class="tc-body">{{ expandedDetail(step.toolCall) }}</pre>
          </div>

          <div
            v-if="step.toolResult"
            class="conv-message tool-result"
            :class="{ expanded: expandedToolCalls.has(step.toolResult.id), 'is-error': toolResultView(step.toolResult).status === 'error' }"
          >
            <div class="tr-header" @click="agentStore.toggleToolCall(step.toolResult.id)">
              <span class="tr-toggle">{{ expandedToolCalls.has(step.toolResult.id) ? '-' : '+' }}</span>
              <span class="tr-label">
                <span class="tr-icon" aria-hidden="true">{{ toolResultView(step.toolResult).icon }}</span>
                <span class="tr-name">{{ toolResultView(step.toolResult).name }}</span>
                <span v-if="toolResultView(step.toolResult).headline" class="tr-headline">{{ toolResultView(step.toolResult).headline }}</span>
                <span v-if="toolResultView(step.toolResult).detail" class="tr-detail">{{ toolResultView(step.toolResult).detail }}</span>
              </span>
              <span class="tr-time" :title="timestampTitle(step.toolResult.timestamp)">{{ fmtTime(step.toolResult.timestamp) }}</span>
            </div>
            <pre v-if="expandedToolCalls.has(step.toolResult.id)" class="tr-body" :class="{ 'tr-error': step.toolResult.kind === 'tool_error' }">{{ expandedDetail(step.toolResult) }}</pre>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useAgentStore } from '../../stores/agents';
import type { AgentMessage, EntityLink } from '../../api/types';
import { createLogger } from '../../utils/logger';
import { formatTimestamp, timestampTitle } from '../../utils/timestamp';
import { presentToolCall, presentToolResult, formatExpandedDetail } from '../../utils/tool-presenters';

const log = createLogger('comp:agent-conv');

const props = defineProps<{ sessionId: string }>();

const router = useRouter();
const agentStore = useAgentStore();
const { currentSession, steps, expandedToolCalls, loading, error, conversationWarning } = storeToRefs(agentStore);
const errorMsg = computed(() => error.value);

function fmtTime(ts: string): string {
  return formatTimestamp(ts, 'timeOnly');
}

function esc(text: string): string {
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderContent(msg: AgentMessage): string {
  if (msg.kind === 'text' && (msg.role === 'assistant' || msg.role === 'system')) {
    let out = esc(msg.content);
    out = out.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="code-block"><code>$2</code></pre>');
    out = out.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\n/g, '<br>');
    return out;
  }
  return esc(msg.content);
}

function toolCallView(msg: AgentMessage) {
  return presentToolCall(msg.content, msg.tool);
}

function toolResultView(msg: AgentMessage) {
  return presentToolResult(msg.content, { tool: msg.tool, kind: msg.kind });
}

function expandedDetail(msg: AgentMessage): string {
  return formatExpandedDetail(msg.content);
}

function linkLabel(link: EntityLink): string {
  return link.label || `${link.entity_type}: ${link.entity_id}`;
}

function navigateToLink(link: EntityLink): void {
  if (link.entity_type === 'card') {
    router.push({ name: 'card-detail', params: { id: link.entity_id } });
    return;
  }

  if (link.entity_type === 'process') {
    router.push({ name: 'debug', query: { tab: 'processes', process: link.entity_id } });
    return;
  }

  if (link.entity_type === 'artifact' || link.entity_type === 'attachment') {
    router.push({ name: 'files', query: { path: link.entity_id } });
    return;
  }

  if (link.entity_type === 'quarantine') {
    router.push({ name: 'files', query: { path: link.entity_id } });
  }
}

onMounted(async () => {
  try { await agentStore.fetchConversation(props.sessionId); } catch (err) { log.error('fetch', err); }
});
watch(() => props.sessionId, async (nid) => {
  if (nid) { try { await agentStore.fetchConversation(nid); } catch (err) { log.error('fetch', err); } }
});
</script>

<style scoped>
.conversation-container { flex:1; display:flex; flex-direction:column; overflow:hidden; }
.conv-loading,.conv-error,.conv-empty { padding:32px; text-align:center; color:#8b949e; font-size:13px; }
.conv-error { color:#f85149; }
.conv-warning { margin: 12px 16px 0; padding: 10px 12px; border: 1px solid #9e6a03; background: #241f18; color: #d29922; border-radius: 6px; font-size: 12px; }
.conv-header { display:flex; align-items:center; justify-content:space-between; padding:8px 16px; background:#161b22; border-bottom:1px solid #30363d; flex-shrink:0; }
.conv-info { display:flex; align-items:center; gap:8px; }
.conv-role { font-size:12px; font-weight:600; color:#f0f6fc; text-transform:capitalize; }
.conv-model { font-size:11px; color:#8b949e; font-family:'SF Mono',monospace; }
.conv-status-badge { font-size:10px; font-weight:600; padding:1px 6px; border-radius:8px; }
.conv-status-badge.s-active { background:#1c2738; color:#58a6ff; }
.conv-status-badge.s-waiting { background:#241f18; color:#d29922; }
.conv-status-badge.s-done { background:#1a2418; color:#7ee787; }
.conv-status-badge.s-blocked { background:#241f18; color:#d29922; }
.conv-status-badge.s-failed { background:#241818; color:#f85149; }
.conv-toolbar { display:flex; gap:4px; }
.conv-tb-btn { padding:3px 8px; background:#21262d; border:1px solid #30363d; border-radius:4px; color:#c9d1d9; font-size:11px; cursor:pointer; font-family:inherit; }
.conv-tb-btn:hover { background:#30363d; }
.conv-messages { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:8px; }
.conv-step { display:flex; flex-direction:column; gap:6px; }
.conv-message { padding:10px 14px; background:#161b22; border:1px solid #21262d; border-radius:6px; }
.conv-message.role-assistant { border-left:3px solid #58a6ff; }
.conv-message.role-user { border-left:3px solid #7ee787; }
.conv-message.role-system { border-left:3px solid #8b949e; opacity:.85; }
.msg-meta { display:flex; justify-content:space-between; margin-bottom:4px; }
.msg-role { font-size:11px; font-weight:600; color:#58a6ff; text-transform:uppercase; }
.role-user .msg-role { color:#7ee787; }
.role-system .msg-role { color:#8b949e; }
.msg-time { font-size:10px; color:#484f58; }
.msg-content { font-size:13px; line-height:1.6; color:#c9d1d9; }
.msg-content :deep(.code-block) { background:#0d1117; border:1px solid #30363d; border-radius:4px; padding:10px 12px; margin:8px 0; overflow-x:auto; font-size:12px; font-family:'SF Mono',monospace; }
.msg-content :deep(.inline-code) { background:#21262d; padding:1px 5px; border-radius:3px; font-size:12px; font-family:'SF Mono',monospace; color:#d2a8ff; }
.msg-content :deep(strong) { color:#f0f6fc; }
.msg-links { display:flex; gap:4px; margin-top:6px; flex-wrap: wrap; }
.msg-link { font-size:11px; padding:2px 6px; background:#1c2738; color:#58a6ff; border-radius:4px; border: 1px solid #30363d; cursor: pointer; }
.msg-link:hover { filter: brightness(1.15); }
.tool-call,.tool-result { padding:0; overflow:hidden; border:1px solid #21262d; border-radius:6px; }
.tc-header,.tr-header { display:flex; align-items:center; gap:8px; padding:8px 12px; cursor:pointer; user-select:none; transition:background .1s; }
.tc-header:hover,.tr-header:hover { background:#21262d; }
.tc-toggle,.tr-toggle { width:14px; font-size:12px; font-weight:600; color:#8b949e; font-family:'SF Mono',monospace; }
.tc-tool,.tr-label { display:flex; align-items:baseline; gap:6px; flex:1; min-width:0; font-size:12px; }
.tc-icon,.tr-icon { font-size:13px; }
.tc-name { font-weight:600; color:#d2a8ff; }
.tr-name { font-weight:600; color:#7ee787; }
.tool-result.is-error .tr-name { color:#f85149; }
.tc-headline,.tr-headline { color:#c9d1d9; font-family:'SF Mono',monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:1; }
.tool-result.is-error .tr-headline { color:#f85149; }
.tc-detail,.tr-detail { color:#8b949e; font-size:11px; font-family:'SF Mono',monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:240px; }
.tc-time,.tr-time { font-size:10px; color:#484f58; margin-left:auto; }
.tc-body,.tr-body { margin:0; padding:8px 12px 12px; font-size:12px; font-family:'SF Mono',monospace; line-height:1.5; white-space:pre-wrap; word-break:break-word; background:#0d1117; border-top:1px solid #21262d; color:#c9d1d9; overflow-x:auto; }
.tr-body.tr-error { background:#241818; color:#f85149; }
</style>
