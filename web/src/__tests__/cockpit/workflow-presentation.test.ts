import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import CardFlowHeader from '../../components/cockpit/CardFlowHeader.vue';
import ParticipantRail from '../../components/cockpit/ParticipantRail.vue';
import { useWorkflowPresentationStore } from '../../stores/workflowPresentation';
import { agentSession, cardDetail, cyclicCodePresentation } from './fixtures';
import type { WorkflowPresentation } from '../../api/types';
import type { OperatorApiError } from '../../api/client';

const api = vi.hoisted(() => ({ getWorkflowPresentation: vi.fn(), getDebugGraphs: vi.fn(), getCardAgentSessions: vi.fn() }));
vi.mock('../../api/client', async (original) => ({ ...(await original<{ OperatorApiError: typeof OperatorApiError }>()), ...api }));
vi.mock('../../stores/sync', () => ({ useSyncStore: () => ({ openCardAgentSessions: (_id: string, callback: () => Promise<void>) => { void callback(); return () => {}; } }) }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((accept) => { resolve = accept; }); return { promise, resolve }; }
beforeEach(() => {
  setActivePinia(createPinia()); vi.clearAllMocks();
  api.getWorkflowPresentation.mockResolvedValue(cyclicCodePresentation());
  api.getDebugGraphs.mockRejectedValue(new Error('Not a cockpit dependency'));
  api.getCardAgentSessions.mockResolvedValue({ card_id: 'card-a', sessions: [agentSession('agent:executor:card-a'), agentSession('agent:reviewer:card-a')] });
});
function header(detail: ReturnType<typeof cardDetail> | null = null) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ name: 'card-detail', path: '/cards/:id', component: { template: '<div />' } }] });
  return mount(CardFlowHeader, { props: { cardId: 'card-a', detail, position: { kind: 'node', cardType: 'code', stateId: 'node:execute', nodeId: 'execute', executionOrdinal: 1 } }, global: { plugins: [router] } });
}
describe('cockpit workflow presentation ownership', () => {
  it('shares one pending per-type read across late detail arrival in both consumers and retains full topology', async () => {
    const pending = deferred<WorkflowPresentation>(); api.getWorkflowPresentation.mockReturnValueOnce(pending.promise);
    const flow = header();
    const rail = mount(ParticipantRail, { props: { cardId: 'card-a', detail: null, selectedSessionId: null } });
    expect(api.getWorkflowPresentation).not.toHaveBeenCalled();
    await flow.setProps({ detail: cardDetail('card-a', { type: 'code' }) });
    await rail.setProps({ detail: cardDetail('card-a', { type: 'code' }) });
    expect(api.getWorkflowPresentation.mock.calls).toEqual([['code']]);
    pending.resolve(cyclicCodePresentation()); await flushPromises();
    expect(flow.get('[data-testid="card-flow-position"]').text()).toContain("executor's step");
    const technical = flow.get('[data-testid="card-flow-technical"]');
    expect(technical.attributes('open')).toBeUndefined();
    for (const text of ['Nodes:', 'Entries:', 'Edges:', 'Terminals:', 'Records:', 'needs-repair', 'repair', 'notes.md']) expect(technical.text()).toContain(text);
    expect(rail.findAll('.rail-node-label').map((label) => label.text())).toEqual(['Configured node/role: execute', 'Configured node/role: repair']);
    expect(rail.text()).toContain('reviewer'); expect(rail.text()).toContain('unassociated');
    expect(api.getDebugGraphs).not.toHaveBeenCalled();
    flow.unmount(); rail.unmount();
  });
  it('never renders a late prior-type result as the new type and reuses accepted immutable facts', async () => {
    const old = deferred<WorkflowPresentation>(); const current = deferred<WorkflowPresentation>();
    api.getWorkflowPresentation.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const flow = header(cardDetail('card-a', { type: 'code' }));
    await flow.setProps({ detail: cardDetail('card-a', { type: 'goal' }) });
    old.resolve(cyclicCodePresentation()); await flushPromises();
    expect(flow.text()).not.toContain("executor's step");
    current.resolve({ ...cyclicCodePresentation(), card_type: 'goal', nodes: [{ node_id: 'execute', agent_name: 'planner' }] }); await flushPromises();
    expect(flow.text()).toContain("planner's step");
    await flow.setProps({ detail: cardDetail('card-a', { type: 'code' }) });
    expect(flow.text()).toContain("executor's step"); expect(api.getWorkflowPresentation).toHaveBeenCalledTimes(2);
    flow.unmount();
  });
  it('offers explicit failure retry and keeps exact no-match position unavailable', async () => {
    api.getWorkflowPresentation.mockRejectedValueOnce(new Error('read failed'));
    const flow = header(cardDetail('card-a', { type: 'code' })); await flushPromises();
    expect(flow.text()).toContain('read failed');
    await flow.get('[data-testid="card-flow-technical"] button').trigger('click'); await flushPromises();
    await flow.setProps({ position: { kind: 'node', cardType: 'code', stateId: 'node:missing', nodeId: 'missing', executionOrdinal: 2 } });
    expect(flow.get('[data-testid="card-flow-position"]').text()).toContain('unavailable for the observed node');
    await useWorkflowPresentationStore().fetch('code'); expect(api.getWorkflowPresentation).toHaveBeenCalledTimes(2);
    flow.unmount();
  });
});
