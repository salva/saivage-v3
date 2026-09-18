import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DebugGraphDiagram from '../components/debug/DebugGraphDiagram.vue';
import GraphsPanel from '../components/debug/GraphsPanel.vue';

const api = vi.hoisted(() => ({ getDebugGraphs: vi.fn() }));
vi.mock('../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/client')>()), ...api }));
import { useDebugStore } from '../stores/debug';
import type { DebugGlobalAgent, DebugGraph } from '../api/types';
import { DebugGraphsResponseSchema } from '../api/contracts';

const graph: DebugGraph = {
  card_type: 'goal',
  notification_recipient: 'planner',
  permitted_child_types: ['code'],
  records: [{ name: 'brief.md', format: 'markdown', schema: 'card-brief.v1', bootstrap: true }, { name: 'status.md', format: 'markdown', schema: 'work-status.v1', bootstrap: false }],
  entries: ['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED'].map((entry) => ({ entry: entry as 'BACKLOG' | 'CHANGED' | 'BLOCKED' | 'STOPPED', node_id: 'plan', prompt: entry === 'STOPPED' ? { reference: 'stopped-recovery', compactable: true } : null })),
  nodes: [{ node_id: 'plan', agent_name: 'planner', session: { scope: 'card', identity_pattern: 'agent:planner:<card-id>' }, prompt: { source: 'bundled-shared', declaration: { reference: 'planner', compactable: true }, process: { reference: 'plan', compactable: true }, correction: { reference: 'correct-plan-result', compactable: true } }, model: { route: 'planner', candidates: [{ provider: 'openai', model: 'gpt-5.6' }], temperature: 0.2, max_tokens: 4096 }, skills: false, tools: ['create_card', 'activate_card'], child_creation_types: ['code'], child_activation_types: ['code'], readable_records: ['brief.md', 'status.md'], record_write_patterns: ['status.md'], requirements: [{ record_name: 'status.md', mode: 'continue', gate: 'updated' }], descendant_context: null, outcomes: ['again', 'done'] }],
  edges: [{ source_node_id: 'plan', outcome: 'again', runtime_owned: false, condition: 'default', prompt: { reference: 'retry', compactable: true }, target: { kind: 'node', node_id: 'plan' }, export_records: [], promotion: null }, { source_node_id: 'plan', outcome: 'done', runtime_owned: false, condition: 'default', prompt: null, target: { kind: 'terminal', terminal: 'DONE' }, export_records: ['status.md'], promotion: { kind: 'current' } }, { source_node_id: 'plan', outcome: 'execution:failed', runtime_owned: true, condition: 'default', prompt: null, target: { kind: 'terminal', terminal: 'FAILED' }, export_records: [], promotion: null }, { source_node_id: 'plan', outcome: 'execution:blocked', runtime_owned: true, condition: 'default', prompt: null, target: { kind: 'terminal', terminal: 'BLOCKED' }, export_records: [], promotion: null }],
  terminals: [{ terminal: 'DONE' }, { terminal: 'BLOCKED' }, { terminal: 'FAILED' }],
};
const globalAgent:DebugGlobalAgent={agent_name:'analyst',session:{scope:'global',identity:'agent:analyst:global'},prompt:{source:'bundled-shared',declaration:{reference:'analyst',compactable:false}},model:{route:'analyst',candidates:[{provider:'openai',model:'gpt-5.6'}],temperature:.2,max_tokens:4096},skills:true,tools:['read']};

describe('Debug Graphs', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); });

  it('owns initial and retained refresh state independently', async () => {
    api.getDebugGraphs.mockResolvedValueOnce({ global_agents:[globalAgent],graphs: [graph] });
    const store = useDebugStore();
    await store.fetchGraphs();
    expect(store.graphs).toEqual([graph]);
    expect(store.globalAgents).toEqual([globalAgent]);
    expect(store.graphsError).toBeNull();

    let rejectRefresh!: (error: Error) => void;
    api.getDebugGraphs.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRefresh = reject; }));
    const pending = store.fetchGraphs();
    expect(store.graphsRefreshing).toBe(true);
    rejectRefresh(new Error('offline'));
    await pending;
    expect(store.graphs).toEqual([graph]);
    expect(store.graphsRefreshError).toBe('Failed to fetch compiled graphs');
    expect(store.graphsRefreshing).toBe(false);
  });

  it('renders selected global declarations without prompt bodies or paths',()=>{
    const wrapper=mount(GraphsPanel,{props:{graphs:[graph],globalAgents:[globalAgent],graphsLoading:false,graphsRefreshing:false,graphsError:null,graphsRefreshError:null,selectedGraphCardType:'goal',selectedGraph:graph}});
    const global=wrapper.get('[data-testid="debug-global-agents"]');
    expect(global.text()).toContain('Selected global agents');
    expect(global.text()).toContain('"agent_name": "analyst"');
    expect(global.text()).toContain('"compactable": false');
    expect(global.text()).not.toMatch(/prompt body|\.saivage|"path"/i);
  });

  it('renders a deterministic accessible SVG with cycle, terminal export, and selectable details', async () => {
    const wrapper = mount(DebugGraphDiagram, { props: { graph } });
    expect(wrapper.find('svg[role="img"]').exists()).toBe(true);
    expect(wrapper.find('path.cycle').exists()).toBe(true);
    expect(wrapper.text()).toContain('plan · planner');
    expect(wrapper.text()).toContain('status.md · work-status.v1');
    expect(wrapper.text()).toContain('Notification recipient');
    const doneEdge = wrapper.findAll('.graph-edge-group').find((edge) => edge.attributes('aria-label')?.includes('exports status.md'))!;
    expect(doneEdge.attributes('tabindex')).toBe('0');
    await doneEdge.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(wrapper.find('.graph-details pre').text()).toContain('"promotion"');
    expect(wrapper.find('.graph-details pre').text()).toContain('"status.md"');
  });

  it('accepts and renders a custom leaf type with its effective create_card-free tools',async()=>{
    const custom:DebugGraph={...graph,card_type:'custom-leaf',notification_recipient:'planner',permitted_child_types:[],nodes:graph.nodes.map((node)=>({...node,tools:['activate_card'],child_creation_types:[],child_activation_types:[]}))};
    api.getDebugGraphs.mockResolvedValueOnce(DebugGraphsResponseSchema.parse({global_agents:[globalAgent],graphs:[custom]}));
    const store=useDebugStore();await store.fetchGraphs();
    expect(store.graphs?.[0]?.card_type).toBe('custom-leaf');
    expect(store.graphs?.[0]?.nodes[0]?.tools).toEqual(['activate_card']);
    const wrapper=mount(DebugGraphDiagram,{props:{graph:store.graphs![0]!}});
    expect(wrapper.text()).toContain('custom-leaf');
    expect(wrapper.text()).toContain('activate_card');
    expect(wrapper.text()).not.toContain('create_card');
  });

  it('renders pending-notifications edges as explicit conditional routing', () => {
    const conditional: DebugGraph = { ...graph, edges: [...graph.edges, { source_node_id: 'plan', outcome: 'approved', runtime_owned: false, condition: 'pending_notifications', prompt: { reference: 'review-to-notifications', compactable: true }, target: { kind: 'node', node_id: 'plan' }, export_records: [], promotion: null }] };
    const wrapper = mount(DebugGraphDiagram, { props: { graph: conditional } });
    expect(wrapper.find('path.conditional-edge').exists()).toBe(true);
    expect(wrapper.text()).toContain('approved · pending');
    expect(wrapper.findAll('.graph-edge-group').at(-1)!.attributes('aria-label')).toContain('Pending-notifications conditional');
  });

  it('rejects malformed or disclosure-bearing graph payloads at the shared wire contract', () => {
    expect(DebugGraphsResponseSchema.safeParse({ global_agents:[globalAgent],graphs: [{ ...graph, nodes: [{ ...graph.nodes[0], prompt: { ...graph.nodes[0]!.prompt, text: 'secret prompt body' } }] }] }).success).toBe(false);
    expect(DebugGraphsResponseSchema.safeParse({ global_agents:[globalAgent],graphs: [{ ...graph, edges: [{ ...graph.edges[0], runtime_owned: undefined }] }] }).success).toBe(false);
    expect(DebugGraphsResponseSchema.safeParse({ global_agents:[{...globalAgent,prompt:{...globalAgent.prompt,path:'/secret'}}],graphs:[graph] }).success).toBe(false);
  });
});
