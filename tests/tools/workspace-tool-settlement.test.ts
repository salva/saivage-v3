import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';
import { analystWorkspaceToolBinders, workspaceToolBinders } from '../../src/tools/workspace-provider.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { invokeToolForLlm, llmToolDefinition } from '../../src/tools/invocation.js';
import { compileInvocationToolContract } from '../../src/runtime/actors/context/context-blocks.js';
import { settleToolResultForConversation } from '../../src/runtime/actors/llm-delivery-log.js';
import { canonicalJson } from '../../src/schemas/index.js';
import { projectDynamicForOutbound } from '../../src/redaction/dynamic.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('workspace tool settlement', () => {
  it('settles the exact work root directory and metadata locators with observational evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-work-root-')); roots.push(root); initProjectTree(root);
    const surface = buildInvocationSurfaceFixture('reviewer', [bindToolProvider('workspace', workspaceToolBinders, { projectRoot: root, cardId: 'project', agentName: 'reviewer', store: new CardService(root) })]);
    const definition = surface.tools.get('read')!;
    const contract = compileInvocationToolContract(llmToolDefinition(definition), definition.resultPolicyTemplate);
    for (const args of [{ path: 'work:///' }, { path: 'work:///', metadata_only: true }]) {
      const settlement = await invokeToolForLlm(surface, 'read', args, testLlmToolInvocationContext({ toolName: 'read' }));
      const facts = settleToolResultForConversation('read', contract, settlement);
      expect(facts.providerResult).toMatchObject({
        success: true,
        data: {
          path: 'metadata_only' in args
            ? { content: 'work:///', offset_bytes: 0, next_offset_bytes: 8, utf8_bytes: 8 }
            : 'work:///',
          is_directory: true,
        },
      });
      expect(facts.evidence).toMatchObject({ kind: 'observational_query', observedSha256: facts.resultContentSha256 });
    }
  });

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

  it.each(['glob', 'grep'] as const)('settles invalid %s collection positions as bounded failures for autonomous and Analyst binders', async (name) => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-settlement-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const analystContext = { projectRoot: root, cardId: 'project', actor: 'analyst', store: cards, runtime: { notifyCard: () => ({ ok: true, notificationId: 'n' }) } } as unknown as ToolContext;
    const providers = [
      bindToolProvider('workspace', workspaceToolBinders, { projectRoot: root, cardId: 'project', agentName: 'planner', store: cards }),
      bindToolProvider('workspace', analystWorkspaceToolBinders, analystContext),
    ];
    const args = name === 'glob'
      ? { directory: '.', pattern: '**/*', position: { item_index: 0, item_byte_offset: 1 } }
      : { path: '.', pattern: 'needle', position: { item_index: 0, item_byte_offset: 1 } };

    for (const [index, provider] of providers.entries()) {
      const surface = buildInvocationSurfaceFixture(index === 0 ? 'planner' : 'analyst', [provider]);
      const settlement = await invokeToolForLlm(surface, name, args, testLlmToolInvocationContext({ toolName: name }));
      const definition = surface.tools.get(name)!;
      const facts = settleToolResultForConversation(name, compileInvocationToolContract(llmToolDefinition(definition), definition.resultPolicyTemplate), settlement);
      expect(facts.providerResult).toEqual({ success: false, error: expect.stringContaining('Collection position must identify') });
      expect(Buffer.byteLength(facts.settledResultBytes, 'utf8')).toBeLessThan(600);
    }
  });

  it.each(['glob', 'grep'] as const)('enforces consumed-item byte boundaries for real %s workspace binding', async (name) => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-search-boundary-')); roots.push(root); initProjectTree(root);
    writeFileSync(join(root, 'match🚀.txt'), 'needle preview', 'utf8');
    const surface = buildInvocationSurfaceFixture('planner', [bindToolProvider('workspace', workspaceToolBinders, { projectRoot: root, cardId: 'project', agentName: 'planner', store: new CardService(root) })]);
    const item = name === 'glob' ? 'match🚀.txt' : { path: 'match🚀.txt', line: 1, preview: 'needle preview' };
    const bytes = Buffer.from(canonicalJson(projectDynamicForOutbound(item)), 'utf8');
    const astral = bytes.indexOf(Buffer.from('🚀', 'utf8'));
    const args = (offset: number) => name === 'glob'
      ? { directory: '.', pattern: '**/*.txt', response_bytes: 512, position: { item_index: 0, item_byte_offset: offset } }
      : { path: '.', pattern: 'needle', response_bytes: 512, position: { item_index: 0, item_byte_offset: offset } };
    const invoke = (offset: number) => invokeToolForLlm(surface, name, args(offset), testLlmToolInvocationContext({ toolName: name }));

    for (const offset of [bytes.length, bytes.length + 1, astral + 1]) {
      const settlement = await invoke(offset);
      expect(settlement.kind).toBe('executed');
      if (settlement.kind !== 'executed') throw new Error('Expected executed bounded workspace failure.');
      expect(settlement.execution.providerOutcome).toEqual({ kind: 'failed', error: expect.stringContaining('Collection position must identify') });
    }
    for (const offset of [0, 1, astral, astral + Buffer.byteLength('🚀'), bytes.length - 1]) {
      const settlement = await invoke(offset);
      expect(settlement.kind).toBe('executed');
      if (settlement.kind !== 'executed') throw new Error('Expected executed workspace result.');
      expect(settlement.execution.providerOutcome.kind).toBe('succeeded');
    }
  });
});
