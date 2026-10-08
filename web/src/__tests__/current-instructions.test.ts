import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import CurrentInstructions from '../components/agents/CurrentInstructions.vue';
import { getAgentCurrentInstructions, OperatorApiError } from '../api/client';
import type { AgentCurrentInstructionsResponse } from '../api/types';

vi.mock('../api/client', async importOriginal => ({
  ...await importOriginal<typeof import('../api/client')>(), getAgentCurrentInstructions: vi.fn(),
}));
const api = vi.mocked(getAgentCurrentInstructions);
const global: AgentCurrentInstructionsResponse = { session_id: 'agent:analyst:global', basis: 'server_loaded_configuration',
  scope: { kind: 'global' }, bindings: [{ kind: 'global', instructions: 'safe prose [REDACTED]\nFINAL' }] };
const card: AgentCurrentInstructionsResponse = { session_id: 'agent:planner:project', basis: 'server_loaded_configuration',
  scope: { kind: 'card', card_id: 'project', card_type: 'project', ownership: 'retained_tombstone' },
  bindings: [{ kind: 'workflow_node', node_id: 'first', instructions: 'First complete\nFINAL-A' }, { kind: 'workflow_node', node_id: 'second', instructions: 'Second complete\nFINAL-B' }] };
let wrappers: VueWrapper[] = [];
function reader(sessionId = global.session_id) {
  const wrapper = mount(CurrentInstructions, { props: { sessionId } });
  wrappers.push(wrapper); return wrapper;
}
async function toggle(wrapper: VueWrapper, open: boolean) {
  (wrapper.get('details').element as HTMLDetailsElement).open = open;
  await wrapper.get('details').trigger('toggle'); await flushPromises();
}
function deferred() {
  let resolve!: (value: AgentCurrentInstructionsResponse) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<AgentCurrentInstructionsResponse>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => { api.mockReset(); });
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); vi.unstubAllGlobals(); });

describe('CurrentInstructions owner-local disclosure', () => {
  it('is lazy, reads afresh after closing, labels historical configuration and copies complete safe strings per binding', async () => {
    api.mockResolvedValue(card);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const wrapper = reader(card.session_id);
    expect(api).not.toHaveBeenCalled();
    expect((wrapper.get('details').element as HTMLDetailsElement).open).toBe(false);
    await wrapper.setProps({ historical: true });
    await toggle(wrapper, true);
    expect(api).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('not the instructions recorded for this historical segment');
    expect(wrapper.text()).toContain('Retained-card orientation');
    expect(wrapper.findAll('section h4').map(node => node.text())).toEqual(['Workflow node · first', 'Workflow node · second']);
    expect(wrapper.findAll('pre').map(node => node.text())).toEqual(card.bindings.map(binding => binding.instructions));
    await wrapper.findAll('.code-block__copy')[1].trigger('click');
    expect(writeText).toHaveBeenCalledWith(card.bindings[1]!.instructions);
    await wrapper.setProps({ historical: false });
    expect(api).toHaveBeenCalledTimes(1); // Segment navigation is not configuration refresh.
    await toggle(wrapper, false);
    expect(wrapper.findAll('pre')).toHaveLength(0);
    await toggle(wrapper, true);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('aborts close, session replacement and departure, fencing successes and failures even if fetch ignores abort', async () => {
    const first = deferred(); const second = deferred(); const third = deferred();
    api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    const wrapper = reader();
    await toggle(wrapper, true);
    const firstSignal = api.mock.calls[0]![1]!;
    await toggle(wrapper, false);
    expect(firstSignal.aborted).toBe(true);
    await toggle(wrapper, true);
    first.resolve(global); await flushPromises();
    expect(wrapper.findAll('pre')).toHaveLength(0);
    expect(wrapper.text()).toContain('Loading');
    const secondSignal = api.mock.calls[1]![1]!;
    await wrapper.setProps({ sessionId: card.session_id });
    expect(secondSignal.aborted).toBe(true);
    second.reject(new Error('Late private error')); await flushPromises();
    expect(wrapper.text()).not.toContain('Late private error');
    expect((wrapper.get('details').element as HTMLDetailsElement).open).toBe(false);
    await toggle(wrapper, true);
    const thirdSignal = api.mock.calls[2]![1]!;
    wrapper.unmount(); wrappers = [];
    expect(thirdSignal.aborted).toBe(true);
    third.resolve(card); await flushPromises();
  });

  it.each([
    [401, { error: 'Unauthorized', statusCode: 401 }, 'not authorized'],
    [404, { error: 'Agent session not found' }, 'absent or unconfigured'],
    [503, { error: 'current_state_unavailable', resource: 'card', owner_id: 'project', restart_required: true }, 'current state cannot be read'],
  ] as const)('clears prior content on refresh failure %s and keeps its error inside the disclosure', async (status, body, label) => {
    api.mockResolvedValueOnce(global).mockRejectedValueOnce(new OperatorApiError('agents.currentInstructions', status, body));
    const wrapper = reader();
    await toggle(wrapper, true);
    expect(wrapper.text()).toContain('FINAL');
    await wrapper.get('.current-instructions__body > button').trigger('click'); await flushPromises();
    expect(wrapper.findAll('pre')).toHaveLength(0);
    expect(wrapper.get('[role="alert"]').text()).toContain(label);
    expect((wrapper.get('details').element as HTMLDetailsElement).open).toBe(true);
  });

  it('does not request invalid session inputs or expose arbitrary failure text', async () => {
    const wrapper = reader('agent:analyst:global');
    await wrapper.setProps({ sessionId: '/arbitrary/path' });
    await toggle(wrapper, true);
    expect(api).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('invalid session identity');
    await wrapper.setProps({ sessionId: global.session_id });
    api.mockRejectedValueOnce(new Error('sk-private-canary'));
    await toggle(wrapper, true);
    expect(wrapper.text()).toContain('could not be loaded');
    expect(wrapper.text()).not.toContain('canary');
  });
});
