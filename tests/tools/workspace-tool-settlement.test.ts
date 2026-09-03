import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';
import { workspaceToolBinders } from '../../src/tools/workspace-provider.js';
import { invokeToolForLlm, llmToolDefinition } from '../../src/tools/invocation.js';
import { compileInvocationToolContract } from '../../src/runtime/actors/context/context-blocks.js';
import { settleToolResultForConversation } from '../../src/runtime/actors/llm-delivery-log.js';
import { canonicalJson } from '../../src/schemas/index.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('workspace tool settlement', () => {
  it.each([
    ['write', { path: 'record:///brief.md?card=project', content: 'denied' }],
    ['edit', { path: 'record:///brief.md?card=project', old_string: 'x', new_string: 'y' }],
  ])('settles denied record %s as one top-level failure', async (name, args) => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-settlement-')); roots.push(root); initProjectTree(root);
    const provider = bindToolProvider('workspace', workspaceToolBinders, { projectRoot: root, cardId: 'project', agentName: 'reviewer', store: new CardService(root) });
    const surface = buildInvocationSurfaceFixture('reviewer', [provider]);
    const settlement = await invokeToolForLlm(surface, name, args, testLlmToolInvocationContext({ toolName: name }));
    const definition = surface.tools.get(name)!;
    const contract = compileInvocationToolContract(llmToolDefinition(definition), definition.resultPolicyTemplate);
    const facts = settleToolResultForConversation(name, contract, settlement);
    expect(facts.providerResult).toMatchObject({ success: false, data: { code: 'record_mutation_denied' } });
    expect(facts.providerResult.data).not.toHaveProperty('success');
    expect(facts.evidence).toEqual({ kind: 'none' });
    expect(facts.settledResultBytes).toBe(canonicalJson(facts.providerResult));
  });

  it('settles filesystem write and edit as singular successes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-settlement-')); roots.push(root); initProjectTree(root);
    const provider = bindToolProvider('workspace', workspaceToolBinders, { projectRoot: root, cardId: 'project', agentName: 'planner', store: new CardService(root) });
    const surface = buildInvocationSurfaceFixture('planner', [provider]);
    for (const [name, args] of [['write', { path: 'sample.txt', content: 'before' }], ['edit', { path: 'sample.txt', old_string: 'before', new_string: 'after' }]] as const) {
      const settlement = await invokeToolForLlm(surface, name, args, testLlmToolInvocationContext({ toolName: name }));
      const definition = surface.tools.get(name)!;
      const facts = settleToolResultForConversation(name, compileInvocationToolContract(llmToolDefinition(definition), definition.resultPolicyTemplate), settlement);
      expect(facts.providerResult.success).toBe(true);
      expect(facts.providerResult.data).not.toHaveProperty('success');
    }
  });

  it('settles a successful record write as one top-level success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-settlement-')); roots.push(root); initProjectTree(root);
    const provider = bindToolProvider('workspace', workspaceToolBinders, { projectRoot: root, cardId: 'project', agentName: 'planner', store: new CardService(root) });
    const surface = buildInvocationSurfaceFixture('planner', [provider]);
    const definition = surface.tools.get('write')!;
    const settlement = await invokeToolForLlm(
      surface,
      'write',
      { path: 'record:///brief.md?card=project', content: 'updated brief' },
      testLlmToolInvocationContext({ toolName: 'write' }),
    );
    const facts = settleToolResultForConversation(
      'write',
      compileInvocationToolContract(llmToolDefinition(definition), definition.resultPolicyTemplate),
      settlement,
    );

    expect(facts.providerResult).toMatchObject({
      success: true,
      data: {
        card_id: 'project',
        name: 'brief.md',
        current_url: 'record:///brief.md?card=project',
        written: true,
      },
    });
    expect(facts.providerResult.data).not.toHaveProperty('success');
    expect(facts.evidence).toEqual({ kind: 'none' });
    expect(facts.settledResultBytes).toBe(canonicalJson(facts.providerResult));
  });
});
