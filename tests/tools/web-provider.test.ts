import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { createWebProvider } from '../../src/tools/web-tools.js';

describe('WebProvider', () => {
  it('exposes websearch and webfetch through an invocation surface', () => {
    const surface = buildInvocationSurface('executor', [createWebProvider({ projectRoot: '/project', agentRole: 'executor' })]);
    expect([...surface.tools.keys()]).toEqual(['websearch', 'webfetch']);
  });

  it('validates webfetch arguments before execution', async () => {
    const surface = buildInvocationSurface('executor', [createWebProvider({ projectRoot: '/project', agentRole: 'executor' })]);
    const result = await invokeTool(surface, 'webfetch', { url: 123 });
    expect(result).toEqual(expect.objectContaining({ success: false }));
    if (!result.success) expect(result.error).toContain('Expected string');
  });

  it('returns model-visible provider errors for blocked private targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-web-provider-'));
    try {
      const surface = buildInvocationSurface('executor', [createWebProvider({ projectRoot: root, agentRole: 'executor' })]);
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
      const surface = buildInvocationSurface('reviewer', [createWebProvider({ projectRoot: root, agentRole: 'reviewer' })]);
      const result = await invokeTool(surface, 'webfetch', { url: 'https://example.com', save_as: 'fetched.txt' });
      expect(result).toEqual({ success: false, error: 'reviewer cannot write project files.' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
