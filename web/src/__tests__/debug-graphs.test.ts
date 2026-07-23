import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DebugGraphDiagram from '../components/debug/DebugGraphDiagram.vue';

const api = vi.hoisted(() => ({ getDebugGraphs: vi.fn() }));
vi.mock('../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/client')>()), ...api }));
import { useDebugStore } from '../stores/debug';
import type { DebugGraph } from '../api/types';
import { DebugGraphsResponseSchema } from '../api/contracts';

const graph: DebugGraph = {
  card_type: 'goal',
  permitted_child_types: ['code'],
  records: [{ name: 'brief.md', format: 'markdown', schema: 'card-brief.v1', writers: ['planner'], bootstrap: true }, { name: 'status.md', format: 'markdown', schema: 'work-status.v1', writers: ['planner'], bootstrap: false }],
  entries: ['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED'].map((entry) => ({ entry: entry as 'BACKLOG' | 'CHANGED' | 'BLOCKED' | 'STOPPED', node_id: 'plan', prompt_reference: entry === 'STOPPED' ? 'stopped-recovery' : null })),
  nodes: [{ node_id: 'plan', agent_name: 'planner', session: { scope: 'card', identity_pattern: 'agent:planner:<card-id>' }, prompt: { source: 'bundled', reference: 'planner', process_reference: 'plan', correction_reference: 'correct-plan-result' }, model: { route: 'planner', candidates: [{ provider: 'openai', model: 'gpt-5.6' }], temperature: 0.2, max_tokens: 4096 }, skills: false, tools: ['create_card', 'activate_card'], child_creation_types: ['code'], child_activation_types: ['code'], readable_records: ['brief.md', 'status.md'], writable_records: ['status.md'], requirements: [{ record_name: 'status.md', kind: 'updated' }], descendant_context: null, outcomes: ['again', 'done'] }],
  edges: [{ source_node_id: 'plan', outcome: 'again', runtime_owned: false, prompt_reference: 'retry', target: { kind: 'node', node_id: 'plan' }, export_records: [], promotion: null }, { source_node_id: 'plan', outcome: 'done', runtime_owned: false, prompt_reference: null, target: { kind: 'terminal', terminal: 'DONE' }, export_records: ['status.md'], promotion: { kind: 'current' } }, { source_node_id: 'plan', outcome: 'execution:failed', runtime_owned: true, prompt_reference: null, target: { kind: 'terminal', terminal: 'FAILED' }, export_records: [], promotion: null }],
  terminals: [{ terminal: 'DONE' }, { terminal: 'BLOCKED' }, { terminal: 'FAILED' }],
};

describe('Debug Graphs', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); });

  it('owns initial and retained refresh state independently', async () => {
    api.getDebugGraphs.mockResolvedValueOnce({ graphs: [graph] });
    const store = useDebugStore();
    await store.fetchGraphs();
    expect(store.graphs).toEqual([graph]);
    expect(store.graphsError).toBeNull();

    let rejectRefresh!: (error: Error) => void;
    api.getDebugGraphs.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRefresh = reject; }));
    const pending = store.fetchGraphs();
    expect(store.graphsRefreshing).toBe(true);
    rejectRefresh(new Error('offline'));
    await pending;
    expect(store.graphs).toEqual([graph]);
    expect(store.graphsRefreshError).toBe('Failed to fetch compiled graphs');
    expect(store.loading).toBe(false);
  });

  it('renders a deterministic accessible SVG with cycle, terminal export, and selectable details', async () => {
    const wrapper = mount(DebugGraphDiagram, { props: { graph } });
    expect(wrapper.find('svg[role="img"]').exists()).toBe(true);
    expect(wrapper.find('path.cycle').exists()).toBe(true);
    expect(wrapper.text()).toContain('plan · planner');
    expect(wrapper.text()).toContain('status.md · work-status.v1');
    const doneEdge = wrapper.findAll('.graph-edge-group').find((edge) => edge.attributes('aria-label')?.includes('exports status.md'))!;
    expect(doneEdge.attributes('tabindex')).toBe('0');
    await doneEdge.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(wrapper.find('.graph-details pre').text()).toContain('"promotion"');
    expect(wrapper.find('.graph-details pre').text()).toContain('"status.md"');
  });

  it('rejects malformed or disclosure-bearing graph payloads at the shared wire contract', () => {
    expect(DebugGraphsResponseSchema.safeParse({ graphs: [{ ...graph, nodes: [{ ...graph.nodes[0], prompt: { ...graph.nodes[0]!.prompt, text: 'secret prompt body' } }] }] }).success).toBe(false);
    expect(DebugGraphsResponseSchema.safeParse({ graphs: [{ ...graph, edges: [{ ...graph.edges[0], runtime_owned: undefined }] }] }).success).toBe(false);
  });
});
