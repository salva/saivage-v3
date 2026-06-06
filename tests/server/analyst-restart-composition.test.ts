import { describe, expect, it, jest } from '@jest/globals';
import { restart_server, type ToolContext } from '../../src/agents/analyst-tools.js';
import { CardStore } from '../../src/cards/card-store.js';

describe('analyst server restart composition', () => {
  it('uses the server-supplied restart callback instead of a runtime server backlink', async () => {
    const requestServerRestart = jest.fn(async () => undefined);
    const ctx: ToolContext = { projectRoot: '/tmp/project', store: new CardStore('/tmp/project'), actor: 'runtime', surface: 'runtime', requestServerRestart };
    const result = await restart_server(ctx);
    expect(result).toEqual({ success: true, data: { restart_requested: true } });
    expect(requestServerRestart).toHaveBeenCalledTimes(1);
  });

  it('reports restart unavailable when composition root did not provide a callback', async () => {
    const ctx: ToolContext = { projectRoot: '/tmp/project', store: new CardStore('/tmp/project'), actor: 'runtime', surface: 'runtime' };
    await expect(restart_server(ctx)).resolves.toEqual({ success: false, error: 'Server restart primitive is not available.' });
  });
});
