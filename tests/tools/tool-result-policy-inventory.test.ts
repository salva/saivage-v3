import { describe, expect, it } from '@jest/globals';

import { runtimeToolPolicyInventory } from '../../src/tools/runtime-tool-catalog.js';
import { KNOWN_TOOL_INVOCATION_NAMES } from '../../src/tools/tool-invocation-outbound.js';
import { EVIDENCE_ONLY_TOOL_RESULT_POLICY_TEMPLATE, MCP_TOOL_RESULT_POLICY_TEMPLATE, PRIMARY_TOOL_RESULT_POLICY_TEMPLATE, UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE } from '../../src/runtime/actors/llm-invocation.js';

const OBSERVATIONAL = new Set(['get_status', 'show_config', 'read_runtime_events', 'read_runtime_errors', 'read_control_actions', 'list_processes_tool', 'list_agent_sessions', 'read_agent_session', 'list_cards', 'get_card', 'get_tree', 'list_card_versions', 'diff_card_versions', 'read', 'glob', 'grep', 'wait_process', 'websearch', 'webfetch', 'skill']);
const CANONICAL = new Set(['get_card_version']);
const EVIDENCE_ONLY = new Set(['navigate_workspace', 'navigate_back']);

describe('fixed tool result policy inventory', () => {
  it('enumerates every built-in catalog identity with one fixed surface policy', () => {
    const inventory = runtimeToolPolicyInventory();
    const byName = new Map<string, string>();
    for (const row of inventory) {
      const serialized = JSON.stringify(row.resultPolicyTemplate);
      const prior = byName.get(row.name);
      if (prior !== undefined) expect(serialized).toBe(prior);
      byName.set(row.name, serialized);
      if (CANONICAL.has(row.name)) expect(row.resultPolicyTemplate).toMatchObject({ settledAudience: 'summarizer_only', evidenceMode: 'canonical_locator' });
      else if (OBSERVATIONAL.has(row.name)) expect(row.resultPolicyTemplate).toMatchObject({ settledAudience: 'summarizer_only', evidenceMode: 'observational_query' });
      else if (EVIDENCE_ONLY.has(row.name)) expect(row.resultPolicyTemplate).toEqual(EVIDENCE_ONLY_TOOL_RESULT_POLICY_TEMPLATE);
      else expect(row.resultPolicyTemplate).toEqual(PRIMARY_TOOL_RESULT_POLICY_TEMPLATE);
    }
    expect([...byName.keys()].sort()).toEqual(KNOWN_TOOL_INVOCATION_NAMES.filter((name) => name !== 'emit_result').sort());
  });

  it('fixes generated, MCP, and unsupported policies without provider-name fallback', () => {
    expect(PRIMARY_TOOL_RESULT_POLICY_TEMPLATE).toMatchObject({ settledAudience: 'primary_and_summarizer', evidenceMode: 'none' });
    expect(MCP_TOOL_RESULT_POLICY_TEMPLATE).toBe(PRIMARY_TOOL_RESULT_POLICY_TEMPLATE);
    expect(UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE).toBe(PRIMARY_TOOL_RESULT_POLICY_TEMPLATE);
    const mcp = runtimeToolPolicyInventory().filter(({ name }) => name === 'mcp_tool_call');
    expect(mcp).toHaveLength(2);
    expect(mcp.every(({ resultPolicyTemplate }) => JSON.stringify(resultPolicyTemplate) === JSON.stringify(MCP_TOOL_RESULT_POLICY_TEMPLATE))).toBe(true);
  });
});
