import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import JsonText from '../../components/content/JsonText.vue';
import CodeBlock from '../../components/content/CodeBlock.vue';

describe('escaped JSON data rendering', () => {
  it('renders markup-looking strings as continuous literal text without links, handlers or hidden transcript', () => {
    const text = ' \r\n{"x":"</span><img src=x onerror=alert(1)>&","n":900719925474099312345}\n\t';
    const wrapper = mount(JsonText, { props: { text } });
    expect(wrapper.element.textContent).toBe(text);
    expect(wrapper.find('img,script,a,button,[tabindex],[aria-label],[aria-hidden],[onerror]').exists()).toBe(false);
    expect(wrapper.find('.json-token-string').element.textContent).toBe('"</span><img src=x onerror=alert(1)>&"');
  });

  it('replaces incomplete text while its containing native disclosure stays open and copies the new source', async () => {
    const Host = defineComponent({ components: { CodeBlock }, props: ['text'], template: '<details><summary>JSON</summary><CodeBlock :code="text" language="json" copyable /></details>' });
    const wrapper = mount(Host, { props: { text: '{"x":"unfinished' } });
    const details = wrapper.element as HTMLDetailsElement;
    details.open = true;
    expect(wrapper.find('code').element.textContent).toBe('{"x":"unfinished');
    expect(wrapper.find('.json-token-string').exists()).toBe(false);
    const text = '{"x":"completed","bool":true,"nil":null}\r\n';
    await wrapper.setProps({ text });
    expect(wrapper.element).toBe(details);
    expect(details.open).toBe(true);
    expect(wrapper.find('code').element.textContent).toBe(text);
    expect(wrapper.find('.json-token-string').text()).toBe('"completed"');
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      await wrapper.find('button').trigger('click');
      expect(writeText).toHaveBeenCalledWith(text);
    } finally { vi.unstubAllGlobals(); wrapper.unmount(); }
  });

  it('retains the exact plain oversized leaf path for inline consumers too', () => {
    const text = '"' + '😀'.repeat(500_000) + '"\n';
    const wrapper = mount(JsonText, { props: { text } });
    expect(wrapper.element.textContent).toBe(text);
    expect(wrapper.find('[class^="json-token-"]').exists()).toBe(false);
  });

  it('does not guess JSON identity from ordinary text', () => {
    const code = '{"x":true}\n';
    const wrapper = mount(CodeBlock, { props: { code, language: 'text' } });
    expect(wrapper.find('code').element.textContent).toBe(code);
    expect(wrapper.find('.json-text').exists()).toBe(false);
  });
});
