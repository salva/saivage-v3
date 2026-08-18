import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';

import { buildRuntimeToolCatalog, resolveRuntimeTool, surfaceToolContracts } from '../../src/tools/runtime-tool-catalog.js';
import { cardInspectionToolBinders } from '../../src/tools/card-inspection-provider.js';
import { bindToolProvider, CANONICAL_LOCATOR_RESULT_POLICY_TEMPLATE, EMIT_RESULT_POLICY_TEMPLATE, llmToolDefinition, MCP_RESULT_POLICY_TEMPLATE, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, OPERATIONAL_RESULT_POLICY_TEMPLATE, UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';
import { DEFAULT_AGENTS } from '../../src/agents/default-workflow-config.js';
import { canonicalJson } from '../../src/schemas/index.js';

const OBSERVATIONAL_READERS = new Set([
  'get_card', 'list_cards', 'get_tree', 'read', 'glob', 'grep', 'skill', 'get_status', 'show_config',
  'read_runtime_events', 'read_runtime_errors', 'read_control_actions', 'list_processes_tool', 'list_agent_sessions', 'read_agent_session',
  'list_card_versions', 'diff_card_versions',
]);
const CANONICAL_READERS = new Set(['get_card_version', 'read_record_version']);

const templateFor = (name: string) => {
  const card = (() => { try { return resolveRuntimeTool('card', name).resultPolicyTemplate; } catch { return null; } })();
  const global = (() => { try { return resolveRuntimeTool('global', name).resultPolicyTemplate; } catch { return null; } })();
  if (card && global && JSON.stringify(card) !== JSON.stringify(global))
    throw new Error(`Tool '${name}' declares different templates per scope.`);
  if (!card && !global) throw new Error(`unknown tool '${name}' in both scopes`);
  return (card ?? global)!;
};

describe('runtime tool result policy catalog', () => {
  it('declares exactly one fixed result policy template per catalog entry', () => {
    const catalog = buildRuntimeToolCatalog();
    expect(catalog.size).toBeGreaterThan(30);
    for (const entry of catalog.values()) {
      expect(entry.binder.resultPolicyTemplate).toBeDefined();
      expect(() => resolveRuntimeTool(entry.group.scope, entry.binder.name)).not.toThrow();
    }
  });

  it('classifies read/list/get/search surfaces as observational summarizer_only results', () => {
    for (const name of ['get_card', 'list_cards', 'get_tree', 'read', 'glob', 'grep', 'list_card_versions', 'diff_card_versions']) {
      expect(templateFor(name)).toEqual({ storage: 'durable', replacement: { kind: 'retain' }, settledAudience: 'summarizer_only', evidenceMode: 'observational_query' });
    }
  });

  it('classifies the dedicated immutable card and record version readers as canonical locator summarizer_only results', () => {
    for (const name of CANONICAL_READERS) {
      expect(templateFor(name)).toEqual(CANONICAL_LOCATOR_RESULT_POLICY_TEMPLATE);
      expect(templateFor(name)).toEqual({ storage: 'durable', replacement: { kind: 'retain' }, settledAudience: 'summarizer_only', evidenceMode: 'canonical_locator' });
    }
  });

  it('classifies mutation and settlement surfaces as durable primary_and_summarizer with none evidence', () => {
    for (const name of ['create_card', 'edit_card', 'activate_card', 'cancel_card', 'delete_card', 'reorder_child', 'reopen_card', 'write', 'edit', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'queue_notification', 'websearch', 'webfetch']) {
      expect(templateFor(name)).toEqual(OPERATIONAL_RESULT_POLICY_TEMPLATE);
    }
  });

  it('keeps MCP conservative because arbitrary MCP output has no exact-recall guarantee', () => {
    expect(templateFor('mcp_tool_call')).toEqual(MCP_RESULT_POLICY_TEMPLATE);
    expect(MCP_RESULT_POLICY_TEMPLATE).toEqual({ storage: 'durable', replacement: { kind: 'retain' }, settledAudience: 'primary_and_summarizer', evidenceMode: 'none' });
  });

  it('fixes emit_result and unsupported tools to the directly constructed conservative templates', () => {
    expect(EMIT_RESULT_POLICY_TEMPLATE).toEqual(OPERATIONAL_RESULT_POLICY_TEMPLATE);
    expect(UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE).toEqual({ storage: 'durable', replacement: { kind: 'retain' }, settledAudience: 'primary_and_summarizer', evidenceMode: 'none' });
  });

  it('copies the frozen template into compiled references without a second declaration', () => {
    const reference = resolveRuntimeTool('card', 'get_card');
    expect(reference.resultPolicyTemplate).toBe(OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE);
    expect(reference.resultPolicyTemplate.evidenceMode).toBe('observational_query');
  });

  it('keeps every surface in the default inventories classified and provider definitions policy-free', () => {
    const allNames = new Set<string>(Object.values(DEFAULT_AGENTS).flatMap((agent) => agent.tools));
    for (const name of allNames) {
      const template = templateFor(name);
      if (name === 'mcp_tool_call') continue;
      expect(template.settledAudience === 'primary_and_summarizer' || OBSERVATIONAL_READERS.has(name) || CANONICAL_READERS.has(name)).toBe(true);
      expect(template.evidenceMode === 'none' || template.evidenceMode === 'observational_query' || template.evidenceMode === 'canonical_locator').toBe(true);
      expect(template.evidenceMode === 'observational_query').toBe(OBSERVATIONAL_READERS.has(name) && template.settledAudience !== 'primary_and_summarizer');
      expect(template.evidenceMode === 'canonical_locator').toBe(CANONICAL_READERS.has(name));
    }
    const provider = bindToolProvider('card-inspection', cardInspectionToolBinders, { store: { read: () => null, list: () => [], listChildren: () => [] } as never, cardTypeVocabulary: ['project'] });
    for (const definition of provider.tools) {
      const wire = llmToolDefinition(definition);
      expect(Object.hasOwn(wire, 'resultPolicyTemplate')).toBe(false);
      expect(JSON.stringify(wire)).not.toContain('evidenceMode');
      expect(JSON.stringify(wire)).not.toContain('settledAudience');
    }
  });

  it('compiles surface tool contracts that bind provider bytes to the frozen policy template', () => {
    const provider = bindToolProvider('card-inspection', cardInspectionToolBinders, { store: { read: () => null, list: () => [], listChildren: () => [] } as never, cardTypeVocabulary: ['project'] });
    const surface = { agentName: 'reviewer' as const, tools: new Map(provider.tools.map((tool) => [tool.name, tool])), providers: [provider] };
    const contracts = surfaceToolContracts(surface as never);
    expect(contracts.map((contract) => contract.providerDefinition.function.name)).toEqual(['list_cards', 'get_card', 'get_tree']);
    for (const contract of contracts) {
      expect(contract.resultPolicyTemplateBytes).toBe(canonicalJson(contract.resultPolicyTemplate));
      expect(contract.resultPolicyTemplateSha256).toBe(createHash('sha256').update(contract.resultPolicyTemplateBytes, 'utf8').digest('hex'));
      expect(Object.hasOwn(contract.providerDefinition, 'resultPolicyTemplate')).toBe(false);
    }
  });
});
