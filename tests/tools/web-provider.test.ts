import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';


import { invokeTestTool } from '../helpers/invoke-test-tool.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { webToolBinders, type WebProviderContext } from '../../src/tools/web-tools.js';
import { workspaceToolBinders, type WorkspaceProviderContext } from '../../src/tools/workspace-provider.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';
import { WebfetchDataSchema, WebfetchTextDataSchema } from '../../src/contracts/webfetch.js';
import { projectHistoricalToolResultForOutbound } from '../../src/tools/tool-result-settlement.js';

const bindWeb = (context: WebProviderContext) => bindToolProvider('web', webToolBinders, context);
const bindWorkspace = (context: WorkspaceProviderContext) => bindToolProvider('workspace', workspaceToolBinders, context);

describe('WebProvider', () => {
  it('waits only around public fetch and resumes before result publication/finalization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    let release!: (response: Response) => void;
    const fetched = new Promise<Response>((resolve) => { release = resolve; });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockReturnValue(fetched);
    const events: string[] = [];
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      const context = {
        ...testLlmToolInvocationContext({ toolCallId: 'call-web', toolName: 'webfetch' }),
        waits: {
          waitExternal: async <T>(promise: Promise<T>) => { events.push('wait-enter'); const value = await promise; events.push('wait-exit'); return value; },
          waitProcess: async <T>(_id: string, _promise: Promise<T>) => { throw new Error('unexpected process wait'); },
        },
      };
      const pending = invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34', metadata_only: true }, new AbortController().signal, context);
      for (let attempt = 0; attempt < 200 && fetchSpy.mock.calls.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(fetchSpy).toHaveBeenCalled();
      expect(events).toEqual(['wait-enter']);
      release(new Response('', { status: 200, headers: { 'content-type': 'text/plain' } }));
      const result = await pending;
      if (!result.success) throw new Error(result.error);
      expect(result).toMatchObject({ success: true });
      expect(events).toEqual(['wait-enter', 'wait-exit']);
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exposes websearch and webfetch through an invocation surface', () => {
    const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: '/project', agentName: 'executor' })]);
    expect([...surface.tools.keys()]).toEqual(['websearch', 'webfetch']);
  });

  it('validates webfetch arguments before execution', async () => {
    const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: '/project', agentName: 'executor' })]);
    await expect(invokeTestTool(surface, 'webfetch', { url: 123 })).rejects.toThrow(/url/);
  });

  it('rejects multimodal webfetch before fetch while accepting auto and text modes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34', read_mode: 'multimodal' })).rejects.toThrow(/multimodal/);
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy
        .mockResolvedValueOnce(new Response('automatic', { status: 200, headers: { 'content-type': 'text/plain' } }))
        .mockResolvedValueOnce(new Response('forced', { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/auto', read_mode: 'auto' })).resolves.toMatchObject({ success: true, data: { kind: 'text', head: 'automatic', head_complete: true, fetch_truncated: false } });
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/text', read_mode: 'text' })).resolves.toMatchObject({ success: true, data: { kind: 'text', head: 'forced', head_complete: true, fetch_truncated: false } });
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns final metadata without acquiring or reading a body reader and cancels a body larger than one byte', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const response = new Response('body larger than one byte', { status: 404, headers: { 'content-type': 'text/plain', etag: 'final' } });
    const body = response.body!;
    const getReaderSpy = jest.spyOn(body, 'getReader');
    const cancelSpy = jest.spyOn(body, 'cancel');
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      const result = await invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/final', metadata_only: true });

      expect(result).toMatchObject({ success: true, data: { redacted_url: 'https://93.184.216.34/final', status: 404, headers: { 'content-type': 'text/plain', etag: 'final' }, metadata_only: true } });
      expect(result).not.toHaveProperty('data.url');
      expect(getReaderSpy).not.toHaveBeenCalled();
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('awaits metadata redirect and final body cancellation without acquiring readers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const redirect = new Response('redirect body', { status: 302, headers: { location: '/final?raw-final-query-marker=yes' } });
    const final = new Response('final body larger than one byte', { status: 207, headers: { 'content-type': 'text/plain', etag: 'redirect-final' } });
    const redirectReader = jest.spyOn(redirect.body!, 'getReader');
    const finalReader = jest.spyOn(final.body!, 'getReader');
    let releaseRedirect!: () => void;
    let releaseFinal!: () => void;
    const redirectCancellation = new Promise<void>((resolve) => { releaseRedirect = resolve; });
    const finalCancellation = new Promise<void>((resolve) => { releaseFinal = resolve; });
    const redirectCancel = jest.spyOn(redirect.body!, 'cancel').mockImplementation(() => redirectCancellation);
    const finalCancel = jest.spyOn(final.body!, 'cancel').mockImplementation(() => finalCancellation);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(redirect).mockResolvedValueOnce(final);
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      let settled = false;
      const pending = invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/start?raw-query-marker=yes', metadata_only: true }).finally(() => { settled = true; });
      for (let attempt = 0; attempt < 200 && redirectCancel.mock.calls.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(redirectCancel).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      releaseRedirect();
      for (let attempt = 0; attempt < 200 && finalCancel.mock.calls.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(finalCancel).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      releaseFinal();
      await expect(pending).resolves.toMatchObject({
        success: true,
        data: { redacted_url: 'https://93.184.216.34/final?[REDACTED]', status: 207, headers: { 'content-type': 'text/plain', etag: 'redirect-final' }, metadata_only: true },
      });
      expect(JSON.stringify(await pending)).not.toContain('raw-final-query-marker');
      expect(redirectReader).not.toHaveBeenCalled();
      expect(finalReader).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns model-visible provider errors for blocked private targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      const result = await invokeTestTool(surface, 'webfetch', { url: 'http://127.0.0.1:1', metadata_only: true });
      expect(result).toEqual(expect.objectContaining({ success: false }));
      if (!result.success) expect(result.error).toContain('private/internal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes prepared record fetch content through the same brief write operation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const content = '# Goal\nFetched\n# Instructions\nUse it\n# Acceptance Criteria\nSaved';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(content, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const mutationPath = 'record:///brief.md?card=project';
    const write = jest.fn(() => ({ kind: 'returned' as const, success: true as const, data: { card_id: 'project', name: 'brief.md', state: 'closed', head_version: 4, head_entry_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', current_url: 'record:///brief.md?card=project', version_url: 'record:///brief.md?card=project&v=4', bytes: Buffer.byteLength(content), written: true, surface: 'analyst', propagation: { ok: true } } }));
    const admitWrite = jest.fn(() => ({ ok: true as const }));
    const readiness = Object.freeze({ assertInterventionReady() {} });
    try {
      const analystToolContext = { projectRoot: root, actor: 'analyst', surface: 'web-chat', interventionReadiness: readiness, analystMutations: { recordMutations: { admitWrite, write } } } as never;
      const surface = buildInvocationSurfaceFixture('analyst', [bindWeb({ projectRoot: root, agentName: 'analyst', analystToolContext })]);
      const result = await invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/path?raw-query-marker=yes', save_as: mutationPath });
      expect(result).toMatchObject({ success: true, data: { redacted_url: 'https://93.184.216.34/path?[REDACTED]', saved_as: 'record:///brief.md?card=project', write: { kind: 'record', data: { current_url: 'record:///brief.md?card=project' } } } });
      expect(JSON.stringify(result)).not.toContain('raw-query-marker');
      expect(result).not.toHaveProperty('data.url');
      expect(write).toHaveBeenCalledTimes(1);
      expect(admitWrite).toHaveBeenCalledWith(mutationPath);
      expect(write).toHaveBeenCalledWith(mutationPath, content, ['write', 'webfetch']);
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('orders audited record save preflight and readiness around the sole fetch before fresh mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-order-'));
    const events: string[] = [];
    const content = 'ordered content';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { events.push('fetch'); return new Response(content, { status: 200, headers: { 'content-type': 'text/plain' } }); });
    let readinessCount = 0;
    const mutationPath = 'record:///brief.md?card=project';
    const admitWrite = jest.fn(() => { events.push('preflight'); return { ok: true as const }; });
    const write = jest.fn(() => { events.push('mutate'); return { kind: 'returned' as const, success: true as const, data: { card_id: 'project', name: 'brief.md', state: 'closed', head_version: 4, head_entry_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', current_url: 'record:///brief.md?card=project', version_url: 'record:///brief.md?card=project&v=4', bytes: Buffer.byteLength(content), written: true, surface: 'analyst', propagation: { ok: true } } }; });
    try {
      const analystToolContext = { projectRoot: root, actor: 'analyst', surface: 'web-chat', interventionReadiness: { assertInterventionReady() { readinessCount += 1; events.push(`readiness-${readinessCount}`); } }, analystMutations: { recordMutations: { admitWrite, write } } } as never;
      const surface = buildInvocationSurfaceFixture('analyst', [bindWeb({ projectRoot: root, agentName: 'analyst', analystToolContext })]);
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34', save_as: mutationPath })).resolves.toMatchObject({ success: true });
      expect(events).toEqual(['readiness-1', 'preflight', 'fetch', 'readiness-2', 'mutate']);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns the exact record preflight failure without fetching or mutating', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-denied-'));
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const write = jest.fn();
    const conflict = { success: false as const, error: 'Record already has an open workflow draft.' as const, data: { code: 'record_open_conflict' as const, card_id: 'project', name: 'brief.md', operation: 'write' as const, current_head: 2 } };
    try {
      const analystToolContext = { projectRoot: root, actor: 'analyst', surface: 'web-chat', interventionReadiness: { assertInterventionReady() {} }, analystMutations: { recordMutations: { admitWrite: () => ({ ok: false as const, result: conflict, audit_outcome: 'error' as const }), write } } } as never;
      const surface = buildInvocationSurfaceFixture('analyst', [bindWeb({ projectRoot: root, agentName: 'analyst', analystToolContext })]);
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34', save_as: 'record:///brief.md?card=project' })).resolves.toEqual(conflict);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('discards the one fetched body when intervention readiness is lost before fresh mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-readiness-loss-'));
    const events:string[]=[]; let readiness=0;
    const fetchSpy=jest.spyOn(globalThis,'fetch').mockImplementation(async()=>{events.push('fetch');return new Response('discarded',{status:200,headers:{'content-type':'text/plain'}});});
    const write=jest.fn();
    try {
      const analystToolContext={projectRoot:root,actor:'analyst',surface:'web-chat',interventionReadiness:{assertInterventionReady(){readiness+=1;events.push(`readiness-${readiness}`);if(readiness===2)throw new Error('intervention unavailable');}},analystMutations:{recordMutations:{admitWrite:()=>{events.push('preflight');return {ok:true as const};},write}}} as never;
      const surface=buildInvocationSurfaceFixture('analyst',[bindWeb({projectRoot:root,agentName:'analyst',analystToolContext})]);
      await expect(invokeTestTool(surface,'webfetch',{url:'https://93.184.216.34',save_as:'record:///brief.md?card=project'})).rejects.toThrow('intervention unavailable');
      expect(events).toEqual(['readiness-1','preflight','fetch','readiness-2']);
      expect(fetchSpy).toHaveBeenCalledTimes(1);expect(write).not.toHaveBeenCalled();
    } finally {fetchSpy.mockRestore();rmSync(root,{recursive:true,force:true});}
  });

  it('keeps Analyst prepared-record overflow ahead of second readiness and mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-analyst-overflow-'));
    const events: string[] = [];
    const write = jest.fn();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { events.push('fetch'); return new Response('too large', { status: 404, headers: { 'content-type': 'text/plain' } }); });
    try {
      const analystToolContext = { projectRoot: root, actor: 'analyst', surface: 'web-chat', interventionReadiness: { assertInterventionReady() { events.push('readiness'); } }, analystMutations: { recordMutations: { admitWrite: () => { events.push('preflight'); return { ok: true as const }; }, write } } } as never;
      const surface = buildInvocationSurfaceFixture('analyst', [bindWeb({ projectRoot: root, agentName: 'analyst', analystToolContext })]);
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34', save_as: 'record:///brief.md?card=project', max_bytes: 1 })).rejects.toThrow('Response exceeded max_bytes (1).');
      expect(events).toEqual(['readiness', 'preflight', 'fetch']);
      expect(write).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns exact destination-specific saved-write identities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-destinations-'));
    const cardId = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const systemTarget = `${root}/system.txt`;
    const systemUrl = `system:///${systemTarget.replace(/^\/+/, '')}`;
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(async () => new Response('saved', { status: 200, headers: { 'content-type': 'text/plain' } }));
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor', cardId })]);
      const cases = [
        { save_as: './nested/./plain.txt', kind: 'project_relative', target: 'nested/plain.txt' },
        { save_as: 'project:///nested/project.txt', kind: 'project_url', target: 'project:///nested/project.txt' },
        { save_as: `tmp:///${cardId}/tmp.txt`, kind: 'tmp_url', target: `tmp:///${cardId}/tmp.txt` },
        { save_as: systemUrl, kind: 'system_url', target: systemUrl },
      ] as const;
      for (const expected of cases) {
        const result = await invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/file', save_as: expected.save_as });
        if (!result.success) throw new Error(`${expected.kind}: ${result.error}`);
        expect(result).toMatchObject({ success: true, data: { saved_as: expected.target, write: { kind: 'workspace_file', data: { destination_kind: expected.kind, target: expected.target, bytes: 5, written: true } } } });
      }
      expect(fetchSpy).toHaveBeenCalledTimes(cases.length);
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an always-present bounded head and readable canonical content_url when incomplete', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      fetchSpy.mockResolvedValue(new Response('0123456789abcdef', { status: 200, headers: { 'content-type': 'text/plain' } }));
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' }), bindWorkspace({ projectRoot: root, agentName: 'executor', cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' })]);

      const result = await invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34', max_inline_bytes: 4 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data).toEqual(expect.objectContaining({
        kind: 'text',
        head: '0123',
        head_utf8_bytes: 4,
        redacted_text_utf8_bytes: 16,
        fetched_text_utf8_bytes: 16,
        head_complete: false,
        fetch_truncated: false,
        content_url: expect.stringMatching(/^work:\/\/\/tmp\/stash\/webfetch-[1-9][0-9]*-[0-9a-f]{16}\.txt$/),
      }));
      expect(result.data).not.toHaveProperty('stash_path');
      expect(result.data).not.toHaveProperty('stash_url');
      expect(result.data).not.toHaveProperty('url');
      const read = await invokeTestTool(surface, 'read', { path: (result.data as { content_url: string }).content_url });
      expect(read).toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ content: expect.objectContaining({ content: '0123456789abcdef' }) }) }));
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omits raw URL metadata from inline, binary, and filesystem-save results', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('inline', { status: 200, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response('binary', { status: 200, headers: { 'content-type': 'application/octet-stream' } }))
      .mockResolvedValueOnce(new Response('saved', { status: 200, headers: { 'content-type': 'text/plain' } }));
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      const inline = await invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/inline?raw-query-marker=yes' });
      const binary = await invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/binary?raw-query-marker=yes' });
      const saved = await invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/saved?raw-query-marker=yes', save_as: 'saved.txt' });
      if (!saved.success) throw new Error(saved.error);

      expect(inline).toMatchObject({ success: true, data: { redacted_url: 'https://93.184.216.34/inline?[REDACTED]', kind: 'text', head: 'inline', head_utf8_bytes: 6, redacted_text_utf8_bytes: 6, fetched_text_utf8_bytes: 6, head_complete: true, fetch_truncated: false } });
      expect(binary).toMatchObject({ success: true, data: { redacted_url: 'https://93.184.216.34/binary?[REDACTED]', content: null, binary: true } });
      expect(saved).toMatchObject({ success: true, data: { redacted_url: 'https://93.184.216.34/saved?[REDACTED]', saved_as: 'saved.txt', write: { kind: 'workspace_file', data: { destination_kind: 'project_relative', target: 'saved.txt', bytes: 5, written: true } } } });
      expect(JSON.stringify([inline, binary, saved])).not.toContain('raw-query-marker');
      for (const result of [inline, binary, saved]) expect(result).not.toHaveProperty('data.url');
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves multiline text and UTF-8 BOM with no line-count cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const text = `\uFEFF${Array.from({ length: 31 }, (_, index) => `line-${index}`).join('\r\n')}`;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.from(text), { status: 200, headers: { 'content-type': 'text/plain' } }));
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      const result = await invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/text' });
      expect(result).toMatchObject({ success: true, data: { head: text, head_complete: true, fetch_truncated: false } });
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty complete text head for a successful response with no body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204, headers: { 'content-type': 'text/plain', 'content-length': '999' } }));
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/no-body' })).resolves.toMatchObject({ success: true, data: { head: '', head_utf8_bytes: 0, redacted_text_utf8_bytes: 0, fetched_text_utf8_bytes: 0, head_complete: true, fetch_truncated: false } });
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('positively distinguishes exact EOF from one-byte overflow and drops an artificially split code point', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const cancelReleases: Array<() => void> = [];
    const cancel = jest.fn(() => new Promise<void>((resolve) => { cancelReleases.push(resolve); }));
    const response = (chunks: number[][], close: boolean) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
        if (close) controller.close();
      },
      cancel,
    }), { status: 200, headers: { 'content-type': 'text/plain' } });
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response([[97, 98, 99, 100]], true))
      .mockResolvedValueOnce(response([[97, 98, 99, 100], [101]], false))
      .mockResolvedValueOnce(response([[0xe2, 0x82, 0xac]], false));
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/exact', max_bytes: 4 })).resolves.toMatchObject({ success: true, data: { head: 'abcd', fetch_truncated: false } });
      let overflowSettled = false;
      const overflow = invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/overflow', max_bytes: 4 }).finally(() => { overflowSettled = true; });
      for (let attempt = 0; attempt < 200 && cancel.mock.calls.length < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(overflowSettled).toBe(false);
      cancelReleases[0]!();
      await expect(overflow).resolves.toMatchObject({ success: true, data: { head: 'abcd', fetch_truncated: true } });

      let splitSettled = false;
      const split = invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/split', max_bytes: 2 }).finally(() => { splitSettled = true; });
      for (let attempt = 0; attempt < 200 && cancel.mock.calls.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(splitSettled).toBe(false);
      cancelReleases[1]!();
      await expect(split).resolves.toMatchObject({ success: true, data: { head: '', fetched_text_utf8_bytes: 0, head_complete: true, fetch_truncated: true } });
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the default and absolute fetch ceilings exact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('x'.repeat(500_000), { status: 200, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response('x'.repeat(500_001), { status: 200, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response('x'.repeat(1_000_001), { status: 200, headers: { 'content-type': 'text/plain' } }));
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/default-exact' })).resolves.toMatchObject({ success: true, data: { fetched_text_utf8_bytes: 500_000, fetch_truncated: false } });
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/default-overflow' })).resolves.toMatchObject({ success: true, data: { fetched_text_utf8_bytes: 500_000, fetch_truncated: true } });
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/hard-cap', max_bytes: 2_000_000 })).resolves.toMatchObject({ success: true, data: { fetched_text_utf8_bytes: 1_000_000, fetch_truncated: true } });
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('clamps tiny and negative fetch and inline limits to one byte', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ab', { status: 200, headers: { 'content-type': 'text/plain' } }));
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/clamped', max_bytes: -5, max_inline_bytes: -9 })).resolves.toMatchObject({ success: true, data: { head: 'a', head_utf8_bytes: 1, fetched_text_utf8_bytes: 1, head_complete: true, fetch_truncated: true } });
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not convert eligible overflow cancellation failure into prefix success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('ab')); },
      cancel() { throw new Error('synthetic cancellation failure'); },
    }), { status: 200, headers: { 'content-type': 'text/plain' } });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/cancel', max_bytes: 1 })).resolves.toMatchObject({ success: false, error: 'synthetic cancellation failure' });
      expect(existsSync(join(root, '.saivage/work/tmp/stash'))).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails replacement-decoded expansion and preserves max-byte precedence for ineligible overflow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const cancel = jest.fn(async () => { throw new Error('cancellation must not replace max-bytes failure'); });
    const oversized404 = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('oversized')); },
      cancel,
    }), { status: 404, headers: { 'content-type': 'text/plain' } });
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(Uint8Array.from([0xff]), { status: 200, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(oversized404)
      .mockResolvedValueOnce(new Response('oversized', { status: 200, headers: { 'content-type': 'application/octet-stream' } }))
      .mockResolvedValueOnce(new Response('oversized', { status: 200, headers: { 'content-type': 'text/plain' } }));
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/malformed', max_bytes: 1 })).resolves.toMatchObject({ success: false, error: 'Decoded text exceeded max_bytes (1).' });
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/missing', max_bytes: 1 })).resolves.toMatchObject({ success: false, error: 'Response exceeded max_bytes (1).' });
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/binary', max_bytes: 1 })).resolves.toMatchObject({ success: false, error: 'Response exceeded max_bytes (1).' });
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/save', max_bytes: 1, save_as: 'saved.txt' })).resolves.toMatchObject({ success: false, error: 'Response exceeded max_bytes (1).' });
      expect(existsSync(join(root, '.saivage/work/tmp/stash'))).toBe(false);
      expect(existsSync(join(root, 'saved.txt'))).toBe(false);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps replacement-decoding expansion successful for an ordinary save path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-save-decode-'));
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Uint8Array.from([0xff]), { status: 200, headers: { 'content-type': 'text/plain' } }));
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      const result = await invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/malformed-save', max_bytes: 1, save_as: 'malformed.txt' });
      expect(result).toMatchObject({ success: true, data: { saved_as: 'malformed.txt', bytes: 3, write: { kind: 'workspace_file', data: { bytes: 3, written: true } } } });
      expect(readFileSync(join(root, 'malformed.txt'), 'utf8')).toBe('\uFFFD');
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps replacement-decoding expansion successful for an Analyst prepared record save', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-analyst-decode-'));
    const mutationPath = 'record:///brief.md?card=project';
    const write = jest.fn(() => ({ kind: 'returned' as const, success: true as const, data: { card_id: 'project', name: 'brief.md', state: 'closed', head_version: 4, head_entry_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', current_url: mutationPath, version_url: `${mutationPath}&v=4`, bytes: 3, written: true, surface: 'analyst', propagation: { ok: true } } }));
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Uint8Array.from([0xff]), { status: 200, headers: { 'content-type': 'text/plain' } }));
    try {
      const analystToolContext = { projectRoot: root, actor: 'analyst', surface: 'web-chat', interventionReadiness: { assertInterventionReady() {} }, analystMutations: { recordMutations: { admitWrite: () => ({ ok: true as const }), write } } } as never;
      const surface = buildInvocationSurfaceFixture('analyst', [bindWeb({ projectRoot: root, agentName: 'analyst', analystToolContext })]);
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/malformed-record', max_bytes: 1, save_as: mutationPath })).resolves.toMatchObject({ success: true, data: { saved_as: mutationPath, bytes: 3 } });
      expect(write).toHaveBeenCalledWith(mutationPath, '\uFFFD', ['write', 'webfetch']);
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts complete text before choosing a certified head and omits a pointer only for certified completeness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('prefix Bearer synthetic-secret tail', { status: 200, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response('token: ${Bearer example}', { status: 200, headers: { 'content-type': 'text/plain' } }));
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      const redacted = await invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/redacted', max_inline_bytes: 20 });
      expect(redacted).toMatchObject({ success: true, data: { head: 'prefix ', head_utf8_bytes: 7, head_complete: false, content_url: expect.any(String) } });
      expect(JSON.stringify(redacted)).not.toContain('synthetic-secret');
      const unstableFull = await invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/unstable' });
      expect(unstableFull).toMatchObject({ success: true, data: { head: '', head_complete: false, content_url: expect.any(String) } });
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports distinct fetched, redacted, and head byte domains for redaction shrinkage and expansion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const shrinking = '{"apiKey":"a-very-long-synthetic-value"}';
    const expanding = 'ghu_x';
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(shrinking, { status: 200, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response(expanding, { status: 200, headers: { 'content-type': 'text/plain' } }));
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      const shrunk = await invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/shrink', max_inline_bytes: 100 });
      expect(shrunk).toMatchObject({ success: true, data: { head: '{"apiKey":"[REDACTED]"}', fetched_text_utf8_bytes: Buffer.byteLength(shrinking), redacted_text_utf8_bytes: 23, head_utf8_bytes: 23, head_complete: true } });
      expect(shrunk).not.toHaveProperty('data.content_url');

      const expanded = await invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/expand', max_bytes: 5, max_inline_bytes: 5 });
      expect(expanded).toMatchObject({ success: true, data: { head: 'ghu-[', fetched_text_utf8_bytes: 5, redacted_text_utf8_bytes: 14, head_utf8_bytes: 5, head_complete: false, content_url: expect.any(String) } });
      expect(projectHistoricalToolResultForOutbound(expanded)).toEqual(expanded);
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('strictly rejects old text fields and noncanonical content URLs', () => {
    expect(() => WebfetchDataSchema.parse({ redacted_url: 'https://example.test/', status: 200, headers: {}, text: 'old', bytes: 3, truncated: false })).toThrow();
    const base = { kind: 'text', redacted_url: 'https://example.test/', status: 200, headers: {}, head: 'a', head_utf8_bytes: 1, redacted_text_utf8_bytes: 2, fetched_text_utf8_bytes: 2, head_complete: false, fetch_truncated: false };
    expect(() => WebfetchTextDataSchema.parse(base)).toThrow();
    expect(() => WebfetchTextDataSchema.parse({ ...base, head: 'ab', head_utf8_bytes: 2, head_complete: true, content_url: 'work:///tmp/stash/webfetch-1-0123456789abcdef.txt' })).toThrow();
    expect(() => WebfetchTextDataSchema.parse({ ...base, head_utf8_bytes: 2, content_url: 'work:///tmp/stash/webfetch-1-0123456789abcdef.txt' })).toThrow();
    for (const content_url of [
      'work:///tmp/stash/webfetch-01-0123456789abcdef.txt',
      'work:///tmp/stash/webfetch-1-0123456789ABCDEF.txt',
      'work:///tmp/stash/webfetch-1-0123456789abcdef.txt?x=1',
      'work:///tmp/stash/%77ebfetch-1-0123456789abcdef.txt',
    ]) expect(() => WebfetchTextDataSchema.parse({ ...base, content_url })).toThrow();
  });

  it('fails fixed-envelope overflow before creating a stash directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ordinary text', { status: 200, headers: { 'content-type': 'text/plain', etag: 'x'.repeat(1_000_000) } }));
    try {
      const surface = buildInvocationSurfaceFixture('executor', [bindWeb({ projectRoot: root, agentName: 'executor' })]);
      await expect(invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34/fixed', max_inline_bytes: 1 })).resolves.toMatchObject({ success: false, error: 'Webfetch text result metadata exceeded the complete-result byte limit.' });
      expect(existsSync(join(root, '.saivage/work/tmp/stash'))).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
