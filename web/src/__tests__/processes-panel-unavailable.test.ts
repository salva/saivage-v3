import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ProcessesPanel from '../components/debug/ProcessesPanel.vue';
import { listProcesses } from '../api/client';
import { presentToolResult } from '../utils/tool-presenters';
import { unavailableProcess } from './fixtures/process-unavailable';
import ToolChip from '../components/conversation/ToolChip.vue';
import { buildToolDisplay } from '../utils/tool-friendly';
import { call, result } from './tool-presenters/fixtures';
import { createMemoryHistory, createRouter } from 'vue-router';

describe('transported process evidence presentation', () => {
  it('renders independent facts, refresh and readable logs without a terminate control', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ processes: [unavailableProcess] }), { status: 200 })));
    const response = await listProcesses();
    const panel = mount(ProcessesPanel, { props: { sortedProcesses: response.processes, processesLoading: false, processesError: null, selectedProcessId: null }, global: { stubs: { RouterLink: true } } });
    expect(panel.text()).toContain('Evidence unavailable');
    expect(panel.text()).toContain('Leader exit observed:code 1');
    expect(panel.text()).toContain('Stream open · Capture failed: synthetic stdout capture error');
    expect(panel.text()).toContain('EOF observed · Capture failed: synthetic stderr capture error');
    expect(panel.text()).toContain('Later activations cannot take ownership');
    expect(panel.text()).not.toContain('Ended:');
    expect(panel.findAll('button').map(button => button.text())).toEqual(['Refresh', 'Browse', 'Browse']);
    await panel.find('button.process-link-button').trigger('click');
    expect(panel.emitted('browse-log')).toEqual([[unavailableProcess.logs.stdout]]);
    await panel.setProps({ sortedProcesses: [{ ...unavailableProcess, status: 'running', evidence: { ...unavailableProcess.evidence, group: 'tracked', stdout: 'closed' } }] });
    expect(panel.text()).toContain('Awaiting group/output settlement');
    expect(panel.text()).toContain('Closed without observed EOF · Capture failed');
    await panel.find('button').trigger('click');
    expect(panel.emitted('refresh')).toHaveLength(1);
    await panel.setProps({ sortedProcesses: response.processes });
    expect(panel.text()).toContain('Evidence unavailable');
    panel.unmount();
    vi.unstubAllGlobals();
  });

  it('shows supplied historical list evidence only, preserving generic old observations and failed commands', () => {
    const { evidence, ...old } = unavailableProcess;
    for (const item of [{ ...old, status: 'running' }, unavailableProcess]) {
      const view = presentToolResult(JSON.stringify({ success: true, data: { processes: { total: 1, returned: 1, items: [item] } } }), { tool: 'list_processes_tool' });
      expect(view.outcome).toContain('Observation recorded');
      expect(JSON.stringify(view.sections)).toContain('Recorded observation (not a live monitor)');
      const serialized = JSON.stringify(view.sections);
      if ('evidence' in item) {
        expect(serialized).toContain('group_diagnostic');
        expect(serialized).toContain('stdout_error');
      } else {
        expect(serialized).not.toContain('group_diagnostic');
        expect(serialized).not.toContain('EOF');
      }
    }
    const failed = presentToolResult(JSON.stringify({ success: false, error: 'cleanup/exit evidence unavailable' }), { tool: 'wait_process' });
    expect(failed.outcome).toContain('Failed');
    expect(JSON.stringify(failed)).toContain('cleanup/exit evidence unavailable');
  });

  it('mounts historical list and failed-command chips with exact safe originals and no synthesized evidence', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/files', name: 'files', component: { template: '<div />' } }, { path: '/cards/:id', name: 'card-detail', component: { template: '<div />' } }, { path: '/agents/:id', name: 'agent-detail', component: { template: '<div />' } }] });
    await router.push('/'); await router.isReady();
    const { evidence: _evidence, ...old } = unavailableProcess;
    for (const item of [{ ...old, status: 'running' }, unavailableProcess]) {
      const c = call('list_processes_tool', {});
      const r = result('list_processes_tool', { processes: { total: 1, returned: 1, items: [item] } });
      const chip = mount(ToolChip, { props: { entryId: c.id, resultEntryId: r.id, display: buildToolDisplay({ entry: c, mate: r }), callContent: c.content, resultContent: r.content, expanded: true, detailsId: 'historical-process' }, global: { plugins: [router] } });
      expect(chip.text()).toContain('Observation recorded');
      expect(chip.text()).toContain('Recorded observation (not a live monitor)');
      expect(chip.find('.tool-result .safe-original code').element.textContent).toBe(r.content);
      if ('evidence' in item) expect(chip.text()).toContain('synthetic stdout capture error');
      else expect(chip.text()).not.toContain('group_diagnostic');
      chip.unmount();
    }
    const c = call('wait_process', { process_id: unavailableProcess.id });
    const r = result('wait_process', {}, { content: JSON.stringify({ success: false, error: 'cleanup/exit evidence unavailable' }) });
    const chip = mount(ToolChip, { props: { entryId: c.id, resultEntryId: r.id, display: buildToolDisplay({ entry: c, mate: r }), callContent: c.content, resultContent: r.content, expanded: true, detailsId: 'failed-process' }, global: { plugins: [router] } });
    expect(chip.find('.tool-chip-status').text()).toContain('Failed');
    expect(chip.text()).toContain('cleanup/exit evidence unavailable');
    chip.unmount();
  });
});
