import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { invokeTool } from '../../src/tools/invocation.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { createWebProvider } from '../../src/tools/web-tools.js';
import { createWorkspaceProvider } from '../../src/tools/workspace-provider.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';

describe('WebProvider', () => {
  it('waits only around public fetch and resumes before result publication/finalization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    let release!: (response: Response) => void;
    const fetched = new Promise<Response>((resolve) => { release = resolve; });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockReturnValue(fetched);
    const events: string[] = [];
    try {
      const surface = buildInvocationSurfaceFixture('executor', [createWebProvider({ projectRoot: root, agentName: 'executor', filesystemWrite: true })]);
      const context = {
        ...testLlmToolInvocationContext({ toolCallId: 'call-web', toolName: 'webfetch' }),
        waits: {
          waitExternal: async <T>(promise: Promise<T>) => { events.push('wait-enter'); const value = await promise; events.push('wait-exit'); return value; },
          waitProcess: async <T>(_id: string, _promise: Promise<T>) => { throw new Error('unexpected process wait'); },
        },
      };
      const pending = invokeTool(surface, 'webfetch', { url: 'https://93.184.216.34', metadata_only: true }, new AbortController().signal, context);
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
    const surface = buildInvocationSurfaceFixture('executor', [createWebProvider({ projectRoot: '/project', agentName: 'executor' })]);
    expect([...surface.tools.keys()]).toEqual(['websearch', 'webfetch']);
  });

  it('validates webfetch arguments before execution', async () => {
    const surface = buildInvocationSurfaceFixture('executor', [createWebProvider({ projectRoot: '/project', agentName: 'executor' })]);
    const result = await invokeTool(surface, 'webfetch', { url: 123 });
    expect(result).toEqual(expect.objectContaining({ success: false }));
    if (!result.success) expect(result.error).toContain('Expected string');
  });

  it('rejects multimodal webfetch before fetch while accepting auto and text modes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const surface = buildInvocationSurfaceFixture('executor', [createWebProvider({ projectRoot: root, agentName: 'executor', filesystemWrite: true })]);
      const rejected = await invokeTool(surface, 'webfetch', { url: 'https://93.184.216.34', read_mode: 'multimodal' });
      expect(rejected.success).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy
        .mockResolvedValueOnce(new Response('automatic', { status: 200, headers: { 'content-type': 'text/plain' } }))
        .mockResolvedValueOnce(new Response('forced', { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
      await expect(invokeTool(surface, 'webfetch', { url: 'https://93.184.216.34/auto', read_mode: 'auto' })).resolves.toMatchObject({ success: true, data: { text: 'automatic' } });
      await expect(invokeTool(surface, 'webfetch', { url: 'https://93.184.216.34/text', read_mode: 'text' })).resolves.toMatchObject({ success: true, data: { text: 'forced' } });
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
      const surface = buildInvocationSurfaceFixture('executor', [createWebProvider({ projectRoot: root, agentName: 'executor' })]);
      const result = await invokeTool(surface, 'webfetch', { url: 'https://93.184.216.34/final', metadata_only: true });

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
      const surface = buildInvocationSurfaceFixture('executor', [createWebProvider({ projectRoot: root, agentName: 'executor' })]);
      let settled = false;
      const pending = invokeTool(surface, 'webfetch', { url: 'https://93.184.216.34/start?raw-query-marker=yes', metadata_only: true }).finally(() => { settled = true; });
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
      const surface = buildInvocationSurfaceFixture('executor', [createWebProvider({ projectRoot: root, agentName: 'executor' })]);
      const result = await invokeTool(surface, 'webfetch', { url: 'http://127.0.0.1:1', metadata_only: true });
      expect(result).toEqual(expect.objectContaining({ success: false }));
      if (!result.success) expect(result.error).toContain('private/internal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pre-authorizes save_as with canonical workspace write policy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const surface = buildInvocationSurfaceFixture('reviewer', [createWebProvider({ projectRoot: root, agentName: 'reviewer' })]);
      const result = await invokeTool(surface, 'webfetch', { url: 'https://example.com', save_as: 'fetched.txt' });
      expect(result).toEqual({ success: false, error: 'reviewer cannot write project files.' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes prepared record fetch content through the same brief write operation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const content = '# Goal\nFetched\n# Instructions\nUse it\n# Acceptance Criteria\nSaved';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(content, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const write = jest.fn(() => ({ kind: 'returned' as const, success: true as const, data: { record_url: 'record:///brief.md?card=project&v=2' } }));
    const readiness = new RuntimeInterventionBinding(); readiness.markStoppedReady();
    try {
      const analystToolContext = { projectRoot: root, actor: 'analyst', surface: 'web-chat', interventionReadiness: readiness, analystMutations: { recordMutations: { write } } } as never;
      const surface = buildInvocationSurfaceFixture('analyst', [createWebProvider({ projectRoot: root, agentName: 'analyst', analystToolContext })]);
      const result = await invokeTool(surface, 'webfetch', { url: 'https://example.com/path?raw-query-marker=yes', save_as: 'record:///brief.md?card=project&v=next' });
      expect(result).toMatchObject({ success: true, data: { redacted_url: 'https://example.com/path?[REDACTED]', saved_as: 'record:///brief.md?card=project&v=2' } });
      expect(JSON.stringify(result)).not.toContain('raw-query-marker');
      expect(result).not.toHaveProperty('data.url');
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith('record:///brief.md?card=project&v=next', content);
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns oversized fetch stash_url as a readable work URL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      fetchSpy.mockResolvedValue(new Response('0123456789abcdef', { status: 200, headers: { 'content-type': 'text/plain' } }));
      const surface = buildInvocationSurfaceFixture('executor', [createWebProvider({ projectRoot: root, agentName: 'executor' }), createWorkspaceProvider({ projectRoot: root, agentName: 'executor', cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',filesystemWrite:false })]);

      const result = await invokeTool(surface, 'webfetch', { url: 'https://example.com', max_inline_bytes: 4 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data).toEqual(expect.objectContaining({ stash_url: expect.stringMatching(/^work:\/\/\/tmp\/stash\/webfetch-.*\.txt$/), truncated: true }));
      expect(result.data).not.toHaveProperty('stash_path');
      expect(result.data).not.toHaveProperty('url');
      const read = await invokeTool(surface, 'read', { path: (result.data as { stash_url: string }).stash_url });
      expect(read).toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ content: '0123456789abcdef' }) }));
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
      const surface = buildInvocationSurfaceFixture('executor', [createWebProvider({ projectRoot: root, agentName: 'executor', filesystemWrite: true })]);
      const inline = await invokeTool(surface, 'webfetch', { url: 'https://93.184.216.34/inline?raw-query-marker=yes' });
      const binary = await invokeTool(surface, 'webfetch', { url: 'https://93.184.216.34/binary?raw-query-marker=yes' });
      const saved = await invokeTool(surface, 'webfetch', { url: 'https://93.184.216.34/saved?raw-query-marker=yes', save_as: 'saved.txt' });
      if (!saved.success) throw new Error(saved.error);

      expect(inline).toMatchObject({ success: true, data: { redacted_url: 'https://93.184.216.34/inline?[REDACTED]', text: 'inline', truncated: false } });
      expect(binary).toMatchObject({ success: true, data: { redacted_url: 'https://93.184.216.34/binary?[REDACTED]', content: null, binary: true } });
      expect(saved).toMatchObject({ success: true, data: { redacted_url: 'https://93.184.216.34/saved?[REDACTED]', saved_as: 'saved.txt', write: { path: 'saved.txt', written: true } } });
      expect(JSON.stringify([inline, binary, saved])).not.toContain('raw-query-marker');
      for (const result of [inline, binary, saved]) expect(result).not.toHaveProperty('data.url');
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
