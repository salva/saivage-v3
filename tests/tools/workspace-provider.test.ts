import { describe, expect, it } from '@jest/globals';

import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { createPatchProvider, createWorkspaceProvider } from '../../src/tools/workspace-provider.js';

describe('workspace and patch providers', () => {
  it('exposes canonical workspace tools', () => {
    const surface = buildInvocationSurface('executor', [createWorkspaceProvider({ projectRoot: process.cwd(), cardId: 'card-1', agentRole: 'executor' })]);

    expect([...surface.tools.keys()]).toEqual(['read', 'write', 'edit', 'glob', 'grep']);
  });

  it('keeps apply_patch in a separate provider', () => {
    const surface = buildInvocationSurface('executor', [
      createWorkspaceProvider({ projectRoot: process.cwd(), cardId: 'card-1', agentRole: 'executor' }),
      createPatchProvider({ projectRoot: process.cwd(), cardId: 'card-1', agentRole: 'executor' }),
    ]);

    expect([...surface.tools.keys()]).toContain('apply_patch');
  });

  it('returns model-visible file errors instead of throwing', async () => {
    const surface = buildInvocationSurface('executor', [createWorkspaceProvider({ projectRoot: process.cwd(), cardId: 'card-1', agentRole: 'executor' })]);

    const result = await invokeTool(surface, 'read', { path: 'definitely-missing-file.txt' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('ENOENT');
  });
});
