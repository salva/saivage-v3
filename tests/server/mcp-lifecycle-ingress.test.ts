import { describe, expect, it, jest } from '@jest/globals';
import { McpLifecycleIngress } from '../../src/server/composition/mcp-lifecycle-ingress.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { deferred } from '../../src/runtime/actors/deferred.js';
import type { McpToolInvocationPort } from '../../src/mcp/manager-api.js';

describe('whole HTTP MCP lifecycle ingress', () => {
  it.each(['startServer', 'stopServer', 'restartServer'] as const)('observes all of %s, including post-stop continuation and failing cleanup', async method => {
    const stopped = deferred<void>();
    const cleanup = deferred<void>();
    const failure = new Error('original lifecycle failure');
    const call = jest.fn(async () => { await stopped.promise; await cleanup.promise; throw failure; });
    let held = false;
    const ingress = new McpLifecycleIngress({ [method]: call } as unknown as McpToolInvocationPort,
      () => { if (held) throw new Error('held'); }, { publicationOutcomeUnknown: error => { throw error; } });
    const result = ingress[method]('demo');
    expect(ingress.hasActiveLifecycleCall()).toBe(true);
    stopped.resolve();
    await Promise.resolve();
    held = true;
    await expect(ingress[method]('other')).rejects.toThrow('held');
    expect(call).toHaveBeenCalledTimes(1);
    expect(ingress.hasActiveLifecycleCall()).toBe(true);
    cleanup.resolve();
    await expect(result).rejects.toBe(failure);
    expect(ingress.hasActiveLifecycleCall()).toBe(false);
  });

  it('delivers publication uncertainty before decrement or caller reporting', async () => {
    const failure = new PublicationOutcomeUnknownError(new Error('cleanup publication uncertain'));
    const terminal = new Error('fatal boundary');
    let ingress!: McpLifecycleIngress;
    const fatal = jest.fn((_error: PublicationOutcomeUnknownError): never => {
      expect(ingress.hasActiveLifecycleCall()).toBe(true);
      throw terminal;
    });
    ingress = new McpLifecycleIngress({ startServer: async () => { throw failure; } } as unknown as McpToolInvocationPort,
      () => {}, { publicationOutcomeUnknown: fatal });
    await expect(ingress.startServer('demo')).rejects.toBe(terminal);
    expect(fatal).toHaveBeenCalledWith(failure);
    expect(ingress.hasActiveLifecycleCall()).toBe(true);
  });
});
