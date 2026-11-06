import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { cardRecordHeadFile } from '../../src/persistence/layout.js';
import { BoundAgentToolSet, resolveRuntimeTool } from '../../src/tools/runtime-tool-catalog.js';
import { readProject, globProject, grepProject, writeProject, editProject, applyProjectPatch, readWorkspaceImageSource, type WorkspaceContext } from '../../src/tools/project-file-tools.js';
import type { DirectObjectAuthority } from '../../src/tools/direct-object-authority.js';
import { testWorkspaceAuthority } from '../helpers/capability-grants.js';
import { webToolBinders } from '../../src/tools/web-tools.js';
import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { invokeTestTool } from '../helpers/invoke-test-tool.js';
import { readAppLogEntries } from '../../src/persistence/app-log.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-authority-')); roots.push(root);
  initProjectTree(root); const cards = new CardService(root);
  const child = cards.create({ parent: 'project', type: 'goal', title: 'child', bootstrap_content: 'child needle', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
  return { root, cards, child };
}
function recordAuthority(): DirectObjectAuthority {
  return { anchorCardId: 'project', tools: ['read', 'glob', 'grep'].map(name => resolveRuntimeTool('card', name, [
    { kind: 'record', scopes: ['self'], patterns: ['status.md'] },
    { kind: 'record', scopes: ['children'], patterns: ['brief.md'] },
  ])) };
}

describe('workspace direct-object consumption and effects', () => {
  it('carries the actual bound global policy into observations and audited Analyst file writes/edits/patches', async () => {
    const { root, cards } = fixture(); writeFileSync(join(root, 'ordinary.txt'), 'old\n');
    const analyst = { projectRoot: root, policyAgentName: 'analyst', actor: 'analyst', surface: 'web-chat', store: cards,
      runtime: { notifyCard() { throw new Error('Unexpected notification.'); } }, analystMutations: {},
    };
    const bind = (references: DirectObjectAuthority['tools'], useAnalyst: boolean) => new BoundAgentToolSet(references).bind({
      scope: 'global', projectRoot: root, agentName: useAnalyst ? 'analyst' : 'oversight', store: cards,
      ...(useAnalyst ? { analystToolContext: analyst } : { observationToolContext: { projectRoot: root, agentName: 'oversight', store: cards } }),
    } as never);
    const recordOnly = [resolveRuntimeTool('global', 'read', [{ kind: 'record', scopes: ['all'], patterns: ['brief.md'] }])];
    for (const useAnalyst of [false, true]) {
      const surface = bind(recordOnly, useAnalyst);
      expect(await invokeTestTool(surface, 'read', { path: 'ordinary.txt' })).toMatchObject({ success: false });
      expect(await invokeTestTool(surface, 'read', { path: 'record:///brief.md?card=project' })).toMatchObject({ success: true });
    }
    const files = ['write', 'edit', 'apply_patch'].map(name => resolveRuntimeTool('global', name, [{ kind: 'workspace' }]));
    const surface = bind(files, true);
    expect(await invokeTestTool(surface, 'write', { path: 'ordinary.txt', content: 'new\n' })).toMatchObject({ success: true });
    expect(await invokeTestTool(surface, 'edit', { path: 'ordinary.txt', old_string: 'new', new_string: 'edited' })).toMatchObject({ success: true });
    expect(await invokeTestTool(surface, 'apply_patch', { patch: '--- a/ordinary.txt\n+++ b/ordinary.txt\n@@ -1 +1 @@\n-edited\n+patched\n' })).toMatchObject({ success: true });
    expect(readFileSync(join(root, 'ordinary.txt'), 'utf8')).toBe('patched\n');
    const actions = readAppLogEntries(root).filter(entry => entry.type === 'control_action');
    expect(JSON.stringify(actions)).toContain('workspace.write'); expect(JSON.stringify(actions)).toContain('workspace.edit');
    const denied = bind([resolveRuntimeTool('global', 'write', [{ kind: 'record', scopes: ['all'], patterns: ['brief.md'] }])], true);
    expect(await invokeTestTool(denied, 'write', { path: 'ordinary.txt', content: 'denied' })).toMatchObject({ success: false });
    expect(readFileSync(join(root, 'ordinary.txt'), 'utf8')).toBe('patched\n');
  });
  it('filters declaration names and canonical scopes before selected record access, totals and pages', async () => {
    const { root, cards, child } = fixture();
    cards.acceptRecord('project', 'status.md', 'root needle', { kind: 'agent', agent: 'planner' });
    // A denied current head is malformed: even metadata-only access would fail if eagerly consumed.
    writeFileSync(cardRecordHeadFile(root, 'project', { filename: 'brief.md' }), 'not json');
    writeFileSync(cardRecordHeadFile(root, child.id, { filename: 'status.md' }), 'not json');
    const ctx: WorkspaceContext = { projectRoot: root, cardId: 'project', agentName: 'planner', store: cards, authority: recordAuthority() };
    const listing = (await readProject(ctx, { path: 'record:///project' })).data as any;
    expect(listing.total_entries).toBe(1); expect(listing.records.total).toBe(1);
    expect(listing.records.items.map((row: any) => row.name)).toEqual(['status.md']);
    expect((await readProject(ctx, { path: 'record:///project', position: { kind: 'collection', item_index: 1, item_byte_offset: 0 } })).data)
      .toMatchObject({ records: { total: 1, items: [], next: null } });
    expect((await readProject(ctx, { path: 'record:///project', metadata_only: true })).data).toMatchObject({ entries_count: 1 });
    const childListing = (await readProject(ctx, { path: `record:///${child.id}` })).data as any;
    expect(childListing.records.items.map((row: any) => row.name)).toEqual(['brief.md']);
    expect(await globProject(ctx, { directory: 'record:///project', pattern: '*' })).toMatchObject({ matches: { total: 1, items: ['record:///status.md?card=project'], next: null } });
    expect(await grepProject(ctx, { path: `record:///${child.id}`, pattern: 'needle' })).toMatchObject({ matches: { total: 1, items: [{ path: `record:///brief.md?card=${child.id}` }] } });
    await expect(readProject(ctx, { path: `record:///status.md?card=${child.id}` })).rejects.toThrow('not authorized');
    await expect(readProject(ctx, { path: 'record:///brief.md?card=project&v=1' })).rejects.toThrow('not authorized');
    const unavailable = { ...ctx, authority: { ...ctx.authority!, tools: [] } };
    await expect(readProject(unavailable, { path: 'record:///project' })).rejects.toThrow('not selected');
    await expect(readProject({ ...ctx, authority: testWorkspaceAuthority() }, { path: 'record:///project' })).rejects.toThrow();
  });

  it('distinguishes workspace from records and refuses missing tools before file content/effects', async () => {
    const { root, cards } = fixture(); writeFileSync(join(root, 'file.txt'), 'original');
    const ctx: WorkspaceContext = { projectRoot: root, agentName: 'planner', store: cards, authority: recordAuthority() };
    await expect(readProject(ctx, { path: 'file.txt' })).rejects.toThrow('not authorized');
    await expect(globProject(ctx, { directory: '.', pattern: '*' })).rejects.toThrow('not authorized');
    await expect(grepProject(ctx, { path: 'file.txt', pattern: '.' })).rejects.toThrow('not authorized');
    await expect(writeProject(ctx, { path: 'file.txt', content: 'changed' })).rejects.toThrow('not authorized');
    await expect(editProject(ctx, { path: 'file.txt', old_string: 'original', new_string: 'changed' })).rejects.toThrow('not authorized');
    expect(() => readWorkspaceImageSource(ctx, 'file.txt', 100)).toThrow('not authorized');
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('original');
    const permitted = { ...ctx, authority: testWorkspaceAuthority() };
    await writeProject(permitted, { path: 'file.txt', content: 'allowed' });
    await editProject(permitted, { path: 'file.txt', old_string: 'allowed', new_string: 'updated' });
    expect((await readProject(permitted, { path: 'file.txt' })).data).toMatchObject({ content: { content: 'updated' } });
    expect(readWorkspaceImageSource(permitted, 'file.txt', 100).bytes.toString()).toBe('updated');
  });

  it('checks every patch destination/source guard before any file is changed', async () => {
    const { root } = fixture(); writeFileSync(join(root, 'one.txt'), 'old\n'); writeFileSync(join(root, 'two.txt'), 'old\n');
    const patch = ['diff --git a/one.txt b/one.txt', '--- a/one.txt', '+++ b/one.txt', '@@ -1 +1 @@', '-old', '+new', 'diff --git a/two.txt b/two.txt', '--- a/two.txt', '+++ b/two.txt', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
    const checked: string[] = [];
    const ctx: WorkspaceContext = { projectRoot: root, authority: testWorkspaceAuthority(), assertGlobalSourceWrite(path) { checked.push(path); if (path.endsWith('two.txt')) throw new Error('source owner refuses'); } };
    await expect(applyProjectPatch(ctx, { patch })).rejects.toThrow('source owner refuses');
    expect(checked).toEqual([join(root, 'one.txt'), join(root, 'two.txt')]);
    expect(readFileSync(join(root, 'one.txt'), 'utf8')).toBe('old\n');
    await expect(applyProjectPatch({ ...ctx, authority: recordAuthority() }, { patch })).rejects.toThrow('not authorized');
    await expect(applyProjectPatch({ projectRoot: root, authority: testWorkspaceAuthority() }, { patch })).resolves.toMatchObject({ applied: true });
  });

  it('requires both Webfetch and write workspace destinations before network, and freshly at final save', async () => {
    const { root } = fixture();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('fetched', { headers: { 'content-type': 'text/plain' } }));
    const authority = (web: boolean, write: boolean): DirectObjectAuthority => ({ anchorCardId: null, tools: [
      resolveRuntimeTool('global', 'webfetch', web ? [{ kind: 'workspace' }] : undefined),
      ...(write ? [resolveRuntimeTool('global', 'write', [{ kind: 'workspace' }])] : []),
    ] });
    const invoke = (bound: DirectObjectAuthority, save_as?: string) => {
      const surface = buildInvocationSurfaceFixture('analyst', [bindToolProvider('web', webToolBinders, { projectRoot: root, agentName: 'analyst', authority: bound })]);
      return invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/', ...(save_as ? { save_as } : {}) });
    };
    for (const [web, write] of [[false, true], [true, false]]) {
      const result = await invoke(authority(web!, write!), 'saved.txt'); expect(result.success).toBe(false);
    }
    for (const deniedTool of ['write', 'webfetch']) {
      const mismatched: DirectObjectAuthority = { anchorCardId: null, tools: ['webfetch', 'write'].map(name =>
        resolveRuntimeTool('global', name, name === deniedTool
          ? [{ kind: 'record', scopes: ['all'], patterns: ['brief.md'] }]
          : [{ kind: 'workspace' }])) };
      expect((await invoke(mismatched, 'saved.txt')).success).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await invoke(authority(false, false))).success).toBe(true);
    const selected = authority(true, true);
    fetchSpy.mockImplementationOnce(async () => {
      (selected.tools as any[]).splice(1, 1);
      return new Response('late', { headers: { 'content-type': 'text/plain' } });
    });
    expect((await invoke(selected, 'saved.txt')).success).toBe(false); expect(existsSync(join(root, 'saved.txt'))).toBe(false);
    expect((await invoke(authority(true, true), 'saved.txt')).success).toBe(true);
    expect(readFileSync(join(root, 'saved.txt'), 'utf8')).toBe('fetched');
  });
});
