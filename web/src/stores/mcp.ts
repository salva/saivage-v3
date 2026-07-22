/**
 * Pinia store for MCP tool data.
 *
 * Provides connected servers, tool lists, invocation stats,
 * loading/error state, and optional auto-refresh polling.
 */

import { defineStore } from 'pinia';
import { ref, computed, readonly } from 'vue';
import type {
  McpToolsResponse,
  McpServerWithTools,
  McpInvocationStat,
  McpToolDefinition,
} from '../api/types';
import { getMcpTools, ApiError } from '../api/client';
import { createLogger } from '../utils/logger';

const log = createLogger('store:mcp');

export const useMcpStore = defineStore('mcp', () => {
  // ── State ──────────────────────────────────────────────────

  const servers = ref<McpServerWithTools[]>([]);
  const allTools = ref<McpToolDefinition[]>([]);
  const serverNames = ref<string[]>([]);
  const invocationStats = ref<Record<string, McpInvocationStat>>({});
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastRefreshed = ref<string | null>(null);
  let refreshInterval: ReturnType<typeof setInterval> | null = null;

  // ── Getters ────────────────────────────────────────────────

  const toolCount = computed(() => allTools.value.length);
  const serverCount = computed(() => servers.value.length);
  const totalInvocations = computed(() => {
    let total = 0;
    for (const stats of Object.values(invocationStats.value)) {
      total += stats.total;
    }
    return total;
  });
  const totalErrors = computed(() => {
    let total = 0;
    for (const stats of Object.values(invocationStats.value)) {
      total += stats.error;
    }
    return total;
  });

  // ── Actions ────────────────────────────────────────────────

  async function fetchMcpData(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: McpToolsResponse = await getMcpTools();
      servers.value = response.serverDetails;
      allTools.value = response.tools;
      serverNames.value = response.servers;
      invocationStats.value = response.invocationStats;
      lastRefreshed.value = new Date().toISOString();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch MCP tools';
      error.value = msg;
      log.error('fetchMcpData', msg);
    } finally {
      loading.value = false;
    }
  }

  function startPolling(intervalMs: number = 10000): void {
    stopPolling();
    refreshInterval = setInterval(() => {
      fetchMcpData().catch(() => {});
    }, intervalMs);
  }

  function stopPolling(): void {
    if (refreshInterval !== null) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
  }

  return {
    servers: readonly(servers),
    allTools: readonly(allTools),
    serverNames: readonly(serverNames),
    invocationStats: readonly(invocationStats),
    loading: readonly(loading),
    error: readonly(error),
    lastRefreshed: readonly(lastRefreshed),
    toolCount,
    serverCount,
    totalInvocations,
    totalErrors,
    fetchMcpData,
    startPolling,
    stopPolling,
  };
});
