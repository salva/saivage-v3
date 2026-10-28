import { describe, expect, test } from '@jest/globals';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { prepareInitialProjectDirectories, publishInitialProjectCard, publishInitialChildCard, publishDiscardedCard } from '../../../src/persistence/card-files.js';
import { initializeAndValidateCurrentGeneratedState } from '../../../src/persistence/current-generated-graph.js';
import { initializeConversation, readConversationCatalog, appendConversationBatch, readCurrentConversationSegment } from '../../../src/persistence/conversation-file.js';
import { inspectRepairTarget } from '../../../src/persistence/repair-target.js';
import { agentMessageSchema } from '../../../src/schemas/validators.js';
import { projectCanonicalConversationRow } from '../../../src/application/read-models/canonical-conversation-outbound.js';
import { cardConversationVersionIndexFile, cardNamespace } from '../../../src/persistence/layout.js';
import { cardAgentSessionId, globalAgentSessionId } from '../../../src/schemas/conversation-session-id.js';
import { parseActivationOpenPayload } from '../../../src/schemas/activation-instructions.js';
import { projectWorkflowPresentation } from '../../../src/runtime/card-process/workflow-presentation-projection.js';
import { AgentOperatorReadModelService } from '../../../src/application/read-models/agent-operator-read-model.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../../src/config/system-templates/registry.js';
import { projectEffectiveConfigForOutbound } from '../../../src/config/effective-config-outbound.js';
import {
  gitWorkflowSchema,
  effectiveSaivageConfigSchema,
  saivageConfigSchema,
  type SaivageConfig,
} from '../../../src/schemas/saivage-config.js';
import {
  compileGitWorkflowPolicy,
  compileProjectWorkflows,
  compileProjectWorkflowDeclarations,
  processNodeOutcomes, nodeResultSchema, nodeResultToolDefinition, describeNodeResultContract,
} from '../../../src/runtime/card-process/card-process-config.js';
import { BoundAgentToolSet } from '../../../src/tools/runtime-tool-catalog.js';
import { createAnalystOperationSurface } from '../../../src/application/analyst-operation-surface.js';
import { gitRefNameSchema } from '../../../src/schemas/git-source.js';
import { gitProvisioningSchema } from '../../../src/schemas/saivage-config.js';

test('native ref and source path admission preserves exact control and punctuation rejection', () => {
  for (let code = 0; code < 128; code += 1) {
    const char = String.fromCharCode(code);
    expect(gitRefNameSchema.safeParse(`refs/heads/a${char}b`).success)
      .toBe(code > 32 && code !== 127 && !'~^:?*[\\'.includes(char));
    expect(gitProvisioningSchema.safeParse({
      delivery_branch: 'main', private_ref_namespace: 'refs/saivage/test',
      source_roots: [`a${char}b`], excluded_paths: ['.git', '.saivage'],
    }).success).toBe(code >= 32 && code !== 127 && !'\\:*?[]'.includes(char));
  }
});

function configured(): SaivageConfig {
  const config = structuredClone(DEFAULT_SAIVAGE_CONFIG);
  config.agents[config.analyst_agent]!.tools = config.agents[config.analyst_agent]!.tools.filter(
    (name) => name !== 'run_command' && !name.startsWith('mcp_'),
  );
  config.agents.executor!.record_writes.push('git-correction.md');
  for (const definition of Object.values(config.card_types))
    definition.records['git-correction.md'] = {
      format: 'markdown',
      schema: 'git-correction.v1',
      bootstrap: false,
    };
  config.git_workflow = {
    format_version: 1,
    enabled: true,
    delivery_branch: 'main',
    private_ref_namespace: 'refs/saivage/engineering',
    source_roots: ['.'],
    excluded_paths: ['.git', '.saivage'],
    integration: 'squash',
    preservation: {
      source_checkpoint: 'eligible-worktree',
      interrupted_rebase: 'preserve-source-before-abort',
    },
    correction: {
      agent: 'executor',
      prompt: { reference: 'git-rebase-correction', compactable: true },
      correction_prompt: { reference: 'correct-git-rebase-result', compactable: true },
    },
    review_bindings: Object.fromEntries(
      Object.entries(config.card_types).map(([type, definition]) => [
        type,
        definition.workflow.nodes.review ? { node: 'review', approved_outcome: 'approved' } : null,
      ]),
    ),
  };
  return config;
}

describe('Git workflow policy input and declaration compilation', () => {
  test('checks selected global declarations and actual bound capabilities, not only tool names', () => {
    const config = configured();
    config.agents.extra = { ...structuredClone(config.agents.analyst!), skills: false, tools: ['run_command'] };
    expect(compileGitWorkflowPolicy(config)).not.toBeNull();
    config.agents[config.analyst_agent]!.tools.push('run_command');
    expect(() => compileGitWorkflowPolicy(config)).toThrow(/unsupported source writer/);
    const declarations = { ...compileProjectWorkflows(DEFAULT_SAIVAGE_CONFIG), gitPolicy: compileGitWorkflowPolicy(configured()) };
    const tools = declarations.analyst.tools;
    const read = tools.find(tool => tool.name === 'read')!;
    expect(() => new BoundAgentToolSet([{ ...read, providerGroupId: 'global:process' }]).assertNativeGitGlobalEligibility()).toThrow(/exact canonical/);
    expect(() => new BoundAgentToolSet([read]).bind({ scope: 'global', nativeGit: true } as never)).toThrow(/final source-file admission/);
    expect(() => new BoundAgentToolSet([read]).bind({ scope: 'global', nativeGit: true, assertGlobalSourceWrite() {}, quality: {} } as never)).toThrow(/quality/);
    for (const author of [{ kind: 'agent', agent: 'analyst' }, { kind: 'external-agent', principal: 'fixture' }])
      expect(() => createAnalystOperationSurface({ workflows: declarations, author, allowedTools: ['read'], context: {} } as never)).toThrow(/final source-file admission/);
  });
  test('absence and strict explicit OFF retain OFF semantics', () => {
    const config = structuredClone(DEFAULT_SAIVAGE_CONFIG);
    expect(compileGitWorkflowPolicy(config)).toBeNull();
    config.git_workflow = { format_version: 1, enabled: false };
    expect(compileGitWorkflowPolicy(config)).toBeNull();
    expect(
      gitWorkflowSchema.safeParse({ ...config.git_workflow, delivery_branch: 'main' }).success,
    ).toBe(false);
    expect(gitWorkflowSchema.safeParse({ enabled: false }).success).toBe(false);
    expect(gitWorkflowSchema.safeParse({ format_version: 2, enabled: false }).success).toBe(false);
  });

  test('ON requires explicit commissioning, preservation and bindings in both config forms', () => {
    const config = configured();
    expect(saivageConfigSchema.parse(config).git_workflow).toEqual(config.git_workflow);
    expect(effectiveSaivageConfigSchema.parse(config).git_workflow).toEqual(config.git_workflow);
    for (const key of [
      'delivery_branch',
      'private_ref_namespace',
      'source_roots',
      'excluded_paths',
      'integration',
      'preservation',
      'correction',
      'review_bindings',
    ]) {
      const value = { ...config.git_workflow } as Record<string, unknown>;
      delete value[key];
      expect(gitWorkflowSchema.safeParse(value).success).toBe(false);
    }
    for (const delivery_branch of [
      'refs/heads/main',
      '../main',
      'main.lock',
      'main@{1}',
      '-bad',
      'HEAD',
    ])
      expect(gitWorkflowSchema.safeParse({ ...config.git_workflow, delivery_branch }).success).toBe(
        false,
      );
    for (const root of ['../source', '/source', 'project:///source', 'src/**'])
      expect(
        gitWorkflowSchema.safeParse({ ...config.git_workflow, source_roots: [root] }).success,
      ).toBe(false);
  });

  test('policy is detached and frozen; outbound projection does not disclose provisioning', () => {
    const config = configured();
    const policy = compileGitWorkflowPolicy(config)!;
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.source_roots)).toBe(true);
    expect(Object.isFrozen(policy.correction.prompt)).toBe(true);
    expect(Object.isFrozen(policy.review_bindings.project)).toBe(true);
    if (!config.git_workflow?.enabled) throw new Error('Test needs ON input.');
    config.git_workflow.source_roots.push('other');
    expect(policy.source_roots).toEqual(['.']);
    expect(projectEffectiveConfigForOutbound(config).git_workflow).toEqual({
      format_version: 1,
      enabled: true,
    });
    expect(compileProjectWorkflows(config).gitPolicy?.enabled).toBe(true);
  });

  test('rejects hooks, global writers, wrong correction participant and incomplete review binding', () => {
    const globalWriter = configured();
    globalWriter.agents[globalWriter.analyst_agent]!.tools.push('run_command');
    expect(() => compileGitWorkflowPolicy(globalWriter)).toThrow('unsupported source writer');
    const wrongAgent = configured();
    if (!wrongAgent.git_workflow?.enabled) throw new Error('Test needs ON input.');
    wrongAgent.git_workflow.correction.agent = 'planner';
    expect(() => compileGitWorkflowPolicy(wrongAgent)).toThrow('without child authority');
    const missingBinding = configured();
    if (!missingBinding.git_workflow?.enabled) throw new Error('Test needs ON input.');
    delete missingBinding.git_workflow.review_bindings.project;
    expect(() => compileGitWorkflowPolicy(missingBinding)).toThrow('every card type');
    const wrongOutcome = configured();
    if (!wrongOutcome.git_workflow?.enabled) throw new Error('Test needs ON input.');
    wrongOutcome.git_workflow.review_bindings.project = {
      node: 'review',
      approved_outcome: 'absent',
    };
    expect(() => compileGitWorkflowPolicy(wrongOutcome)).toThrow('invalid review');
    wrongOutcome.git_workflow.review_bindings.project = {
      node: 'review',
      approved_outcome: 'blocked',
    };
    expect(() => compileGitWorkflowPolicy(wrongOutcome)).toThrow('approved review must route');
    const hook = configured();
    hook.card_types.project!.workflow.after_activation_commit = {
      statuses: ['done'],
      execution: {
        kind: 'action',
        action: 'shell.run',
        contract_version: 1,
        inputs: {},
        config: { script: 'true', timeout_ms: 1000 },
      },
    };
    expect(() => compileGitWorkflowPolicy(hook)).toThrow('after_activation_commit');
  });

  test('rejects authored reserved-node collisions and references without reserving OFF names', () => {
    const collision = configured();
    collision.card_types.project!.workflow.nodes['git-rebase-correction'] =
      collision.card_types.project!.workflow.nodes.plan!;
    expect(() => compileGitWorkflowPolicy(collision)).toThrow('reserved correction node');
    collision.git_workflow = { format_version: 1, enabled: false };
    expect(compileGitWorkflowPolicy(collision)).toBeNull();
    const reference = configured();
    reference.card_types.project!.workflow.entries.BACKLOG.node = 'git-rebase-correction';
    expect(() => compileGitWorkflowPolicy(reference)).toThrow('correction entry');
  });
});

describe('workflow5 correction participant structural closure', () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'native-policy-'));
    const directory = join(root, '.saivage/config/prompts/process/_shared');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'git-rebase-correction.md'), 'Reconstruct the full original work plus useful later corrections on the selected parent. Keep the partial snapshot distinct from original history. Report readiness for native verification, not product completion.');
    writeFileSync(join(directory, 'correct-git-rebase-result.md'), 'Address the reported verification mismatch; report blocked or failed if correction cannot be completed.');
    const config = configured();
    const workflows = compileProjectWorkflowDeclarations(config, { projectRoot: root });
    return { root, config, workflows };
  }
  test('compiles one real Executor in each same state table with non-product outcomes and projections', () => {
    const { config, workflows } = fixture();
    for (const workflow of workflows.cardTypes.values()) {
      const node = workflow.states.get('node:git-rebase-correction');
      if (node?.kind !== 'node' || node.purpose !== 'git-correction') throw new Error('Missing correction node');
      expect(node.execution.agent.name).toBe('executor');
      expect(node.execution.agent.session).toBe('card');
      expect(node.requirements).toEqual([]);
      expect(node.childCreationTypes.size).toBe(0);
      expect(node.childActivationTypes.size).toBe(0);
      expect(workflow.processPrompts.get(node.execution.prompt.promptId)!.text).toContain('full original work');
      expect(processNodeOutcomes(workflow, 'node:git-rebase-correction')).toEqual(['source_ready', 'blocked', 'failed']);
      const schema = nodeResultSchema(workflow, 'node:git-rebase-correction');
      expect(schema.parse({ outcome: 'source_ready', summary: 'Ready for verification.' }).outcome).toBe('source_ready');
      expect(schema.safeParse({ outcome: 'done', summary: 'done' }).success).toBe(false);
      expect(schema.safeParse({ outcome: 'source_ready', summary: 'ready', approved: true }).success).toBe(false);
      expect(nodeResultToolDefinition(workflow, 'node:git-rebase-correction').function.parameters).toBeDefined();
      expect(describeNodeResultContract(workflow, 'node:git-rebase-correction')).toContain('native verification');
      expect(node.on.has('result:source_ready')).toBe(false);
      expect(node.on.get('native:verified:STOPPED')!.semantic).toEqual({ kind: 'native-correction-return', entry: 'STOPPED' });
      expect([...node.on.values()].some(t => t.targetStateId === 'terminal:DONE')).toBe(false);
      const graph = projectWorkflowPresentation(workflow);
      expect(graph.nodes.find(n => n.node_id === node.nodeId)!.purpose).toBe('git-correction');
      expect(graph.edges.some(e => e.source_node_id === node.nodeId && e.outcome === 'native:verified:STOPPED')).toBe(true);
    }
    expect(compileProjectWorkflows(config).gitPolicy).not.toBeNull();
  });
  test('initializes and strictly admits aggregate Executor sessions without per-node identities', () => {
    const { root, workflows } = fixture();
    mkdirSync(join(root, '.saivage/cards'), { recursive: true });
    prepareInitialProjectDirectories(root, workflows.cardTypes.get('project')!);
    initializeConversation(root, globalAgentSessionId(workflows.analyst.name));
    publishInitialProjectCard(root, { title: 'Synthetic workflow qualification', bootstrap_content: 'Requirements' }, workflows.cardTypes.get('project')!, null);
    const session = cardAgentSessionId('executor', 'project');
    expect(readConversationCatalog(root, session)).toBeDefined();
    initializeAndValidateCurrentGeneratedState(root, workflows);
    const views = new AgentOperatorReadModelService(root, workflows, () => new Map());
    // Empty established indexes intentionally have no visible conversation yet.
    const timestamp = new Date().toISOString();
    const content = JSON.stringify({ event: 'activation_open', agent_name: 'executor', card_id: 'project', input_id: randomUUID(), timestamp,
      instructions: { kind: 'prepared', role_text: 'Executor', activation_id: randomUUID(), caller: { kind: 'root' },
        card: { cardId: 'project', cardType: 'project', title: 'Qualification' }, parent_direction: null,
        node: { node_id: 'git-rebase-correction', text: 'Correct source; not product acceptance.' } } });
    appendConversationBatch({ projectRoot: root }, [agentMessageSchema.parse({ id: randomUUID(), session_id: session,
      role: 'system', kind: 'activity', content, context_policy: { kind: 'structural', behavior: 'activation_boundary' },
      round_id: `r-user-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp })]);
    expect(views.listCardSessions('project').sessions.filter(s => s.id === session)).toHaveLength(1);
    expect(views.getSession(session).session.id).toBe(session);
    expect(inspectRepairTarget(root, workflows, { kind: 'conversation', sessionId: session }).steps).toEqual([]);
    mkdirSync(cardNamespace(root, 'card-z'), { recursive: true });
    // Separate synthetic discard owner, not a repair of any retained project.
    const repaired = publishDiscardedCard(root, 'card-z', workflows.cardTypes.get('code')!);
    expect(repaired.git).toBeNull();
    expect(readConversationCatalog(root, cardAgentSessionId('executor', repaired.id))).toBeDefined();
    const leaf = publishInitialChildCard(root, { parent: 'project', type: 'code', title: 'leaf', bootstrap_content: 'Work', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }, workflows.cardTypes.get('code')!);
    expect(readConversationCatalog(root, cardAgentSessionId('executor', leaf.id))).toBeDefined();
    // This isolated child is not linked into the project; admission follows canonical root only.
    unlinkSync(cardConversationVersionIndexFile(root, 'project', 'executor'));
    expect(() => initializeAndValidateCurrentGeneratedState(root, workflows)).toThrow('Required conversation index');
  });
  test('conversation12 grammar retains named executor identity and treats correction name as data', () => {
    const timestamp = new Date().toISOString();
    const payload = { event: 'activation_open', agent_name: 'executor', card_id: 'project', input_id: randomUUID(), timestamp,
      instructions: { kind: 'prepared', role_text: 'Executor', activation_id: randomUUID(), caller: { kind: 'root' },
        card: { cardId: 'project', cardType: 'project', title: 'Qualification' }, parent_direction: null,
        node: { node_id: 'git-rebase-correction', text: 'Correct source; not product acceptance.' } } };
    expect(parseActivationOpenPayload(JSON.stringify(payload), cardAgentSessionId('executor', 'project'), timestamp)).toEqual(payload);
    const { root, workflows } = fixture();
    mkdirSync(join(root, '.saivage/cards'), { recursive: true });
    prepareInitialProjectDirectories(root, workflows.cardTypes.get('project')!);
    publishInitialProjectCard(root, { title: 'Grammar', bootstrap_content: 'Requirements' }, workflows.cardTypes.get('project')!, null);
    const session = cardAgentSessionId('executor', 'project');
    const row = agentMessageSchema.parse({ id: randomUUID(), session_id: session, role: 'system', kind: 'activity',
      content: JSON.stringify(payload), context_policy: { kind: 'structural', behavior: 'activation_boundary' },
      round_id: `r-user-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp });
    appendConversationBatch({ projectRoot: root }, [row]);
    const segment = readCurrentConversationSegment(root, session)!;
    expect(segment.genesis.format_version).toBe(12);
    expect(segment.rows[0]!.content).toBe(row.content);
    const outbound = projectCanonicalConversationRow(segment.rows[0], () => { throw new Error('No tool invocation in activation marker'); });
    expect(JSON.parse(outbound.content)).toEqual(payload);
    expect(() => parseActivationOpenPayload(JSON.stringify(payload), cardAgentSessionId('planner', 'project'), timestamp)).toThrow();
    payload.instructions.node.node_id = 'runtime:git-rebase-correction';
    expect(() => parseActivationOpenPayload(JSON.stringify(payload), cardAgentSessionId('executor', 'project'), timestamp)).toThrow();
  });
  test('OFF same-name node is ordinary product topology; workflow4 is strictly rejected', () => {
    const config = structuredClone(DEFAULT_SAIVAGE_CONFIG);
    const workflow = config.card_types.code!.workflow;
    workflow.nodes['git-rebase-correction'] = workflow.nodes.execute!;
    delete workflow.nodes.execute;
    for (const entry of Object.values(workflow.entries)) entry.node = 'git-rebase-correction';
    const compiled = compileProjectWorkflows(config).cardTypes.get('code')!;
    expect(compiled.states.get('node:git-rebase-correction')).toMatchObject({ kind: 'node', purpose: 'product' });
    expect(processNodeOutcomes(compiled, 'node:git-rebase-correction')).toContain('done');
    expect(effectiveSaivageConfigSchema.safeParse({ ...config, card_types: { ...config.card_types, code: { ...config.card_types.code, workflow: { ...workflow, format_version: 4 } } } }).success).toBe(false);
  });
  test.each(['edge', 'pending', 'promotion', 'review'] as const)('rejects exact authored %s references under ON', (reference) => {
    const config = configured();
    const workflow = config.card_types.project!.workflow;
    if (reference === 'edge') workflow.nodes.plan!.edges.again = { target: { node: 'git-rebase-correction' } };
    if (reference === 'pending') {
      const edge = workflow.nodes.review!.edges.approved!;
      if ('cases' in edge) throw new Error('Expected direct review edge');
      edge.pending_notifications = { node: 'git-rebase-correction', prompt: { reference: 'review-to-plan', compactable: true } };
    }
    if (reference === 'promotion') workflow.nodes.plan!.edges.complete_direct = {
      target: { terminal: 'DONE', export_records: [], promote: { latest_node: 'git-rebase-correction' } },
    };
    if (reference === 'review') {
      if (!config.git_workflow?.enabled) throw new Error('ON fixture');
      config.git_workflow.review_bindings.project = { node: 'git-rebase-correction', approved_outcome: 'source_ready' };
    }
    expect(() => compileProjectWorkflowDeclarations(config)).toThrow(reference === 'review' ? 'invalid review' : 'correction edge or promotion');
  });
});
