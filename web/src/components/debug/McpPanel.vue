<template>
  <div class="debug-tab-content">
    <ViewState v-if="loading" state="loading" title="Loading MCP tools..." />
    <ViewState v-else-if="error" state="error" title="Failed to load" :message="error" />
    <ViewState v-else-if="serverCount === 0" state="empty" title="No MCP servers configured or running." />
    <div v-else class="mcp-content">
      <section class="debug-section">
        <h4 class="debug-section-title">Summary</h4>
        <div class="debug-grid">
          <div class="debug-grid-item"><span class="dg-key">Servers:</span><span class="dg-value">{{ serverCount }}</span></div>
          <div class="debug-grid-item"><span class="dg-key">Tools:</span><span class="dg-value">{{ toolCount }}</span></div>
          <div class="debug-grid-item">
            <span class="dg-key">Invocations:</span>
            <span class="dg-value">{{ totalInvocations }} ({{ totalErrors }} errors)</span>
          </div>
          <div v-if="lastRefreshed" class="debug-grid-item">
            <span class="dg-key">Last Refreshed:</span><span class="dg-value">{{ fmtDate(lastRefreshed) }}</span>
          </div>
        </div>
      </section>
      <section v-for="server in servers" :key="server.name" class="debug-section">
        <h4 class="debug-section-title mcp-server-title">
          <span class="mcp-server-name">{{ server.name }}</span>
          <span class="mcp-server-badge" :class="'mcp-status-' + server.status">{{ server.status }}</span>
          <span class="mcp-sep" aria-hidden="true">·</span>
          <span class="mcp-server-transport">{{ server.transport }}</span>
          <span class="mcp-sep" aria-hidden="true">·</span>
          <span class="mcp-tool-count">{{ server.toolCount }} tools</span>
        </h4>
        <ViewState v-if="server.tools.length === 0" state="empty" title="No tools discovered." />
        <div v-for="tool in server.tools" :key="tool.name" class="mcp-tool-card">
          <div class="mcp-tool-name-row"><span class="mcp-tool-name">{{ tool.name }}</span></div>
          <div class="mcp-tool-stats">
            <span class="mcp-stat-item" title="Total invocations">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1" />
                <line x1="6" y1="3" x2="6" y2="7" stroke="currentColor" stroke-width="1" />
                <line x1="4" y1="9" x2="8" y2="9" stroke="currentColor" stroke-width="1" />
              </svg>
              {{ tool.stats.total }}
            </span>
            <span class="mcp-stat-item mcp-stat-success" title="Successful invocations">✓ {{ tool.stats.success }}</span>
            <span class="mcp-stat-item mcp-stat-error" title="Failed invocations">✗ {{ tool.stats.error }}</span>
            <span v-if="tool.stats.lastInvokedAt" class="mcp-stat-item mcp-stat-time" title="Last invoked">
              {{ fmtDate(tool.stats.lastInvokedAt) }}
            </span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { DeepReadonly } from 'vue';
import type { McpServerWithTools } from '../../api/types';
import { formatRecentTimestamp } from '../../utils/timestamp';
import ViewState from '../ui/ViewState.vue';

defineProps<{
  servers: readonly DeepReadonly<McpServerWithTools>[];
  loading: boolean;
  error: string | null;
  serverCount: number;
  toolCount: number;
  totalInvocations: number;
  totalErrors: number;
  lastRefreshed: string | null;
}>();

function fmtDate(timestamp: string): string {
  return formatRecentTimestamp(timestamp);
}
</script>

<style scoped>
.mcp-server-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 4px;
  text-transform: uppercase;
  margin-left: 8px;
}
.mcp-server-badge.mcp-status-running { background: var(--entry-accent-bg); color: var(--accent); }
.mcp-server-badge.mcp-status-stopped { background: var(--surface-3); color: var(--text-muted); }
.mcp-server-badge.mcp-status-error { background: var(--entry-danger-bg); color: var(--danger); }
.mcp-server-transport {
  font-size: 10px;
  color: var(--border-strong);
  margin-left: 6px;
  font-family: 'SF Mono', monospace;
}
.mcp-tool-count { font-size: 10px; color: var(--text-muted); margin-left: 6px; }
.mcp-tool-card {
  padding: 8px 12px;
  background: var(--surface-1);
  border: 1px solid var(--surface-3);
  border-radius: 6px;
  margin-bottom: 6px;
}
.mcp-server-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.mcp-server-name { text-transform: none; color: var(--text); }
.mcp-sep {
  color: var(--text-muted);
  font-weight: 400;
  margin: 0 6px;
}
.mcp-tool-name-row { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
.mcp-tool-name {
  font-family: 'SF Mono', monospace;
  font-size: 12px;
  color: var(--accent-2);
  font-weight: 600;
}
.mcp-tool-stats { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: var(--text-muted); }
.mcp-stat-item { display: inline-flex; align-items: center; gap: 4px; }
.mcp-stat-success { color: var(--accent); }
.mcp-stat-error { color: var(--danger); }
</style>
