import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MarkdownText from '../../components/content/MarkdownText.vue';

describe('MarkdownText', () => {
  it('renders empty output for empty input', () => {
    const wrapper = mount(MarkdownText, { props: { source: '' } });
    expect(wrapper.find('.markdown-text').html()).toContain('class="markdown-text"');
    expect(wrapper.find('.markdown-text').text()).toBe('');
  });

  it('renders plain text as a paragraph', () => {
    const wrapper = mount(MarkdownText, { props: { source: 'hello world' } });
    expect(wrapper.find('p').exists()).toBe(true);
    expect(wrapper.find('p').text()).toBe('hello world');
  });

  it('renders fenced code as <pre><code>', () => {
    const wrapper = mount(MarkdownText, { props: { source: '```json\n{"a":1}\n```' } });
    expect(wrapper.find('pre code').exists()).toBe(true);
    expect(wrapper.find('pre code').text()).toContain('{"a":1}');
  });

  it('renders inline code with <code>', () => {
    const wrapper = mount(MarkdownText, { props: { source: 'see `foo()` here' } });
    const codes = wrapper.findAll('code').filter((node) => !node.element.parentElement || node.element.parentElement.tagName !== 'PRE');
    expect(codes).toHaveLength(1);
    expect(codes[0].text()).toBe('foo()');
  });

  it('renders GFM tables with thead/tbody and th/td (E08 regression)', () => {
    const source = '| Card | Status |\n| --- | --- |\n| Goal | active |\n| Child | done |';
    const wrapper = mount(MarkdownText, { props: { source } });
    expect(wrapper.find('table').exists()).toBe(true);
    expect(wrapper.find('thead').exists()).toBe(true);
    expect(wrapper.find('tbody').exists()).toBe(true);
    expect(wrapper.findAll('thead tr')).toHaveLength(1);
    expect(wrapper.findAll('tbody tr')).toHaveLength(2);
    expect(wrapper.findAll('th')).toHaveLength(2);
    expect(wrapper.findAll('tbody td')).toHaveLength(4);
    expect(wrapper.find('thead').text()).toContain('Card');
    expect(wrapper.find('tbody').text()).toContain('active');
  });

  it('sanitizes script tags out of untrusted markdown', () => {
    const wrapper = mount(MarkdownText, { props: { source: 'before <script>alert(1)</script> after' } });
    expect(wrapper.html()).not.toContain('<script');
    expect(wrapper.text()).toContain('before');
    expect(wrapper.text()).toContain('after');
  });
});
