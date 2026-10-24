import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CardExecutionsFacet from '../../components/cockpit/CardExecutionsFacet.vue';
const api = vi.hoisted(() => ({ listCardExecutions: vi.fn(), getCardExecution: vi.fn(), getCardExecutionFile: vi.fn(), downloadCardExecutionFile: vi.fn() }));
vi.mock('../../api/client', () => api);
const row = { row_id: 'row', invocation_id: 'invocation', timestamp: '2026-10-19T00:00:00Z', operation: 'shell.run', contract_version: 1, binding: { kind: 'node', node_id: 'check', ordinal: 1, activation_id: 'activation' }, kind: 'invocation_started', disposition: null };
const detail = { invocation_id: 'invocation', operation: 'shell.run', contract_version: 1, provider: { kind: 'builtin', name: 'shell' }, output_source: 'command-stdout', artifact_paths: ['absent.txt'], output: null, binding: row.binding, completion: 'no completion retained; effects unknown', started_at: row.timestamp, finished_at: null, shell: null, disposition: null, summary: null, outcome: null, leader_exit: null, leader_error: null, interruption: null, timeout_reason: null, process: null, input: [], values: [], processes: [], processes_truncated: false, files: [{ key: 'row:0', label: 'stdout', source: 'capture', observed_at: null, size: null }], absent_artifacts: ['absent.txt'] };
describe('card execution reader', () => {
  beforeEach(() => { vi.resetAllMocks(); api.listCardExecutions.mockResolvedValue({ rows: [row], next_cursor: null }); api.getCardExecution.mockResolvedValue(detail); });
  it('shows unknown completion without inventing live status; file content stays escaped and absent artifact has no link', async () => {
    api.getCardExecutionFile.mockResolvedValue({ content: '<img src=x onerror=alert(1)>', source: 'capture', redacted: true });
    const wrapper = mount(CardExecutionsFacet, { props: { cardId: 'project' } });
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text().includes('invocation_started'))!.trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="execution-detail"]').text()).toContain('no completion retained; effects unknown');
    expect(wrapper.text()).not.toContain('running');
    expect(wrapper.findAll('button').some(button => button.text() === 'absent.txt')).toBe(false);
    await wrapper.findAll('button').find(button => button.text() === 'stdout')!.trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="execution-file-preview"]').text()).toContain('<img'); expect(wrapper.findAll('img')).toHaveLength(0);
    expect(api.getCardExecutionFile).toHaveBeenCalledWith('project', 'invocation', 'row:0', expect.any(AbortSignal));
    wrapper.unmount();
  });
  it('uses exact row cursors and never carries a previous card detail across selection', async () => {
    api.listCardExecutions.mockResolvedValueOnce({ rows: [row], next_cursor: 'row' }).mockResolvedValue({ rows: [], next_cursor: null });
    const wrapper = mount(CardExecutionsFacet, { props: { cardId: 'project' } }); await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === 'More rows')!.trigger('click'); await flushPromises();
    expect(api.listCardExecutions).toHaveBeenLastCalledWith('project', 'row', expect.any(AbortSignal));
    await wrapper.setProps({ cardId: 'card-a' }); await flushPromises();
    expect(wrapper.find('[data-testid="execution-detail"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('No retained execution evidence');
    expect(api.listCardExecutions).toHaveBeenLastCalledWith('card-a', undefined, expect.any(AbortSignal));
    wrapper.unmount();
  });
  it('reports unavailable selected content rather than fabricating a file preview', async () => {
    api.getCardExecutionFile.mockRejectedValue(new Error('Selected file unavailable.'));
    const wrapper = mount(CardExecutionsFacet, { props: { cardId: 'project' } }); await flushPromises();
    await wrapper.findAll('button').find(button => button.text().includes('invocation_started'))!.trigger('click'); await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === 'stdout')!.trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('Selected file unavailable.');
    expect(wrapper.find('[data-testid="execution-file-preview"]').exists()).toBe(false);
    wrapper.unmount();
  });
  it('does not present a failed list read as accepted absence', async () => {
    api.listCardExecutions.mockRejectedValue(new Error('Execution evidence unavailable.'));
    const wrapper = mount(CardExecutionsFacet, { props: { cardId: 'project' } }); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('Execution evidence unavailable.');
    expect(wrapper.text()).not.toContain('No retained execution evidence.');
    wrapper.unmount();
  });
});
