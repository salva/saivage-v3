import { describe, expect, it, jest } from '@jest/globals';
import { McpLifecycleIngress } from '../../src/server/composition/mcp-lifecycle-ingress.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { deferred } from '../../src/runtime/actors/deferred.js';
import type { McpToolInvocationPort } from '../../src/mcp/manager-api.js';

describe('whole HTTP MCP lifecycle ingress', () => {
  it('admits scope through the operator authority, rejects GC busy and preserves fatal accounting', async () => {
    const policy = { controllerCardId: 'project', exposure: 'subtree' as const };
    const failure = new PublicationOutcomeUnknownError();
    let busy = false;
    const setServerScope = jest.fn<McpToolInvocationPort['setServerScope']>((caller, serverName, selected) => {
      expect(caller.principal).toEqual({ kind: 'operator' });
      if (serverName === 'fatal') throw failure;
      return { serverName, policy: selected, updated: true };
    });
    const fatal = jest.fn((error: PublicationOutcomeUnknownError): never => { throw error; });
    const ingress = new McpLifecycleIngress({ setServerScope } as unknown as McpToolInvocationPort,
      () => { if (busy) throw new Error('GC busy'); }, { publicationOutcomeUnknown: fatal });
    await expect(ingress.setServerScope('one', policy)).resolves.toEqual({ serverName: 'one', policy, updated: true });
    expect(ingress.hasActiveLifecycleCall()).toBe(false);
    busy = true;
    await expect(ingress.setServerScope('one', policy)).rejects.toThrow('GC busy');
    expect(setServerScope).toHaveBeenCalledTimes(1);
    busy = false;
    await expect(ingress.setServerScope('fatal', policy)).rejects.toBe(failure);
    expect(fatal).toHaveBeenCalledWith(failure);
    expect(ingress.hasActiveLifecycleCall()).toBe(true);
  });
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
