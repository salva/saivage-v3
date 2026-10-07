import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ErrorsPanel from '../components/debug/ErrorsPanel.vue';
import ConfigurationPanel from '../components/system/ConfigurationPanel.vue';
import { useSystemResourcesStore } from '../stores/systemResources';
import { projectErrorRecord } from '../stores/debug-read-model';

describe('dedicated JSON inspectors', () => {
  it('highlights existing redacted error details but keeps message prose literal', () => {
    const error = projectErrorRecord({ kind: 'runtime_diagnostic', id: 'synthetic-error', timestamp: '2026-10-07T00:00:00Z', phase: 'plan', error_message: '{"message":"literal prose"}', card_id: 'project' });
    const wrapper = mount(ErrorsPanel, { props: { errorsLoading: false, errorsError: null, errorsTotal: 1, errors: [error], errorSourceEntries: [{ source: error.source, errors: [error] }] } });
    expect(wrapper.get('code').element.textContent).toBe(error.details);
    expect(wrapper.get('.json-token-key').text()).toBe('"phase"');
    expect(wrapper.get('.error-message').text()).toBe(error.message);
    expect(wrapper.get('.error-message').find('.json-text').exists()).toBe(false);
  });

  it('retains the initially open read-only configuration disclosure and producer formatting', () => {
    setActivePinia(createPinia());
    const store = useSystemResourcesStore();
    // Synthetic public projection; no configuration file is read.
    store.config = { config: { server: { host: 'synthetic-host', port: 8080 } }, warnings: ['Synthetic warning'] } as unknown as NonNullable<typeof store.config>;
    const fetch = vi.spyOn(store, 'fetchConfig');
    const wrapper = mount(ConfigurationPanel);
    expect((wrapper.get('details').element as HTMLDetailsElement).open).toBe(true);
    expect(wrapper.get('code').element.textContent).toBe(JSON.stringify(store.config.config, null, 2));
    expect(wrapper.find('.json-token-key').exists()).toBe(true);
    expect(wrapper.text()).toContain('Synthetic warning');
    expect(wrapper.text()).toContain('No editor');
    expect(fetch).not.toHaveBeenCalled();
  });
});
