import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restart_server } from '../../src/tools/analyst-runtime-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { CardStore } from '../../src/cards/card-store.js';

describe('analyst server restart composition', () => {
  it('uses the server-supplied restart callback instead of a runtime server backlink', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-restart-tool-'));
    const requestServerRestart = jest.fn(async () => undefined);
    try {
      const ctx: ToolContext = { projectRoot, store: new CardStore(projectRoot), actor: 'runtime', surface: 'runtime', requestServerRestart };
      const result = await restart_server(ctx);
      expect(result).toEqual({ success: true, data: { restart_requested: true } });
      expect(requestServerRestart).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports restart unavailable when composition root did not provide a callback', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-restart-tool-'));
    try {
      const ctx: ToolContext = { projectRoot, store: new CardStore(projectRoot), actor: 'runtime', surface: 'runtime' };
      await expect(restart_server(ctx)).resolves.toEqual({
        success: false,
        error: 'Server restart primitive is not available.',
        errorEnvelope: { kind: 'conflict', message: 'Server restart primitive is not available.' },
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
