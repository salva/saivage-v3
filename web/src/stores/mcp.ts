/**
 * Pinia store for MCP tool data.
 *
 * Provides the displayed server/tool hierarchy and loading state.
 */

import { defineStore } from 'pinia';
import { ref, computed, readonly } from 'vue';
import type { McpToolsResponse, McpServerWithTools } from '../api/types';
import { getMcpTools, ApiError } from '../api/client';
import { createLogger } from '../utils/logger';

const log = createLogger('store:mcp');

export const useMcpStore = defineStore('mcp', () => {
  // ── State ──────────────────────────────────────────────────

  const servers = ref<McpServerWithTools[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastRefreshed = ref<string | null>(null);

  // ── Getters ────────────────────────────────────────────────

  const toolCount = computed(() => servers.value.reduce((count, server) => count + server.tools.length, 0));
  const serverCount = computed(() => servers.value.length);
  const totalInvocations = computed(() => {
    let total = 0;
    for (const server of servers.value) for (const tool of server.tools) total += tool.stats.total;
    return total;
  });
  const totalErrors = computed(() => {
    let total = 0;
    for (const server of servers.value) for (const tool of server.tools) total += tool.stats.error;
    return total;
  });

  // ── Actions ────────────────────────────────────────────────

  async function fetchMcpData(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: McpToolsResponse = await getMcpTools();
      servers.value = response.servers;
      lastRefreshed.value = new Date().toISOString();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch MCP tools';
      error.value = msg;
      log.error('fetchMcpData', msg);
    } finally {
      loading.value = false;
    }
  }

  return {
    servers: readonly(servers),
    loading: readonly(loading),
    error: readonly(error),
    lastRefreshed: readonly(lastRefreshed),
    toolCount,
    serverCount,
    totalInvocations,
    totalErrors,
    fetchMcpData,
  };
});
