import type { AgentCapabilities, CapabilityResource } from '../../src/schemas/index.js';
import type { CompiledToolReference } from '../../src/tools/tool-api.js';
import { resolveRuntimeTool } from '../../src/tools/runtime-tool-catalog.js';
import type { DirectObjectAuthority } from '../../src/tools/direct-object-authority.js';

export const UNUSED_CARD_RECORD_MUTATIONS: import('../../src/application/record-mutation-service.js').CardAgentRecordMutationPort = {
  admit() { throw new Error('Unexpected record admission in non-record fixture.'); },
  mutate() { throw new Error('Unexpected record mutation in non-record fixture.'); },
};

export function broadInspectionAuthority(): DirectObjectAuthority {
  return { anchorCardId: null, tools: [
    ...['list_cards', 'get_card', 'get_tree', 'list_card_versions', 'get_card_version', 'diff_card_versions']
      .map((name) => resolveRuntimeTool('global', name, [{ kind: 'card', scopes: ['all'] }])),
    resolveRuntimeTool('global', 'read_record_version', [{ kind: 'record', scopes: ['all'], patterns: ['*'] }]),
  ] };
}

export function testWorkspaceAuthority(anchorCardId: string | null = null): DirectObjectAuthority {
  const scope = anchorCardId === null ? 'global' : 'card';
  return { anchorCardId, tools: [
    ...['read', 'glob', 'grep', 'write', 'edit', 'webfetch'].map((name) => resolveRuntimeTool(scope, name, [
      { kind: 'workspace' }, { kind: 'record', scopes: ['all'], patterns: ['*'] },
    ])),
    ...['apply_patch', 'view_image'].map((name) => resolveRuntimeTool(scope, name, [{ kind: 'workspace' }])),
  ] };
}

export function testNotificationAuthority(): DirectObjectAuthority {
  return { anchorCardId: null, tools: [resolveRuntimeTool('global', 'queue_notification', [{ kind: 'card', scopes: ['all'] }])] };
}

export function testPlannerAuthority(anchorCardId = 'project'): DirectObjectAuthority {
  return { anchorCardId, tools: [
    ...['create_card', 'reorder_child', 'checkpoint_source'].map((name) => resolveRuntimeTool('card', name, [{ kind: 'card', scopes: ['self'] }])),
    ...['activate_card', 'reopen_card', 'cancel_card', 'edit_card'].map((name) => resolveRuntimeTool('card', name, [{ kind: 'card', scopes: ['children'] }])),
  ] };
}

/** Edit actual test-config destinations, keeping unrelated read and file clauses. */
export function setRecordWriteGrants(agent: { capabilities: AgentCapabilities }, resources: CapabilityResource[]): void {
  agent.capabilities.grants = agent.capabilities.grants.map((grant) =>
    grant.tools.some((tool) => ['write', 'edit', 'webfetch'].includes(tool))
      ? { ...grant, resources: [...(grant.resources ?? []).filter((resource) => resource.kind !== 'record'), ...resources] }
      : grant);
}

export function writeRecordPatterns(agent: { tools: readonly CompiledToolReference[] }) {
  return agent.tools.filter((tool) => tool.name === 'write').flatMap((tool) =>
    tool.resources.flatMap((resource) => resource.kind === 'record' ? resource.patterns : []));
}
