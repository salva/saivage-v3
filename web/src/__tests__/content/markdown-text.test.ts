import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import MarkdownText from '../../components/content/MarkdownText.vue';

function mountMarkdownText(source: string) {
  return mount(MarkdownText, { props: { source }, global: { plugins: [createPinia()] } });
}

describe('MarkdownText', () => {
  it('renders empty output for empty input', () => {
    const wrapper = mountMarkdownText('');
    expect(wrapper.find('.markdown-text').html()).toContain('class="markdown-text"');
    expect(wrapper.find('.markdown-text').text()).toBe('');
  });

  it('renders plain text as a paragraph', () => {
    const wrapper = mountMarkdownText('hello world');
    expect(wrapper.find('p').exists()).toBe(true);
    expect(wrapper.find('p').text()).toBe('hello world');
  });

  it('renders fenced code as <pre><code>', () => {
    const wrapper = mountMarkdownText('```json\n{"a":1}\n```');
    expect(wrapper.find('pre code').exists()).toBe(true);
    expect(wrapper.find('pre code').text()).toContain('{"a":1}');
  });

  it('renders inline code with <code>', () => {
    const wrapper = mountMarkdownText('see `foo()` here');
    const codes = wrapper.findAll('code').filter((node) => !node.element.parentElement || node.element.parentElement.tagName !== 'PRE');
    expect(codes).toHaveLength(1);
    expect(codes[0].text()).toBe('foo()');
  });

  it('renders GFM tables with thead/tbody and th/td (E08 regression)', () => {
    const source = '| Card | Status |\n| --- | --- |\n| Goal | running |\n| Child | done |';
    const wrapper = mountMarkdownText(source);
    expect(wrapper.find('table').exists()).toBe(true);
    expect(wrapper.find('thead').exists()).toBe(true);
    expect(wrapper.find('tbody').exists()).toBe(true);
    expect(wrapper.findAll('thead tr')).toHaveLength(1);
    expect(wrapper.findAll('tbody tr')).toHaveLength(2);
    expect(wrapper.findAll('th')).toHaveLength(2);
    expect(wrapper.findAll('tbody td')).toHaveLength(4);
    expect(wrapper.find('thead').text()).toContain('Card');
    expect(wrapper.find('tbody').text()).toContain('running');
  });

  it('sanitizes script tags out of untrusted markdown', () => {
    const wrapper = mountMarkdownText('before <script>alert(1)</script> after');
    expect(wrapper.html()).not.toContain('<script');
    expect(wrapper.text()).toContain('before');
    expect(wrapper.text()).toContain('after');
  });

  it('renders an encoded card reference as a sanitized Cards anchor', () => {
    const wrapper = mountMarkdownText('Continue with [[card:goal%2Fnext|the next card]].');
    const link = wrapper.get('a');

    expect(link.text()).toBe('the next card');
    expect(link.attributes('href')).toBe('/cards/goal%2Fnext');
  });

  it('renders ordinary GFM structure and balanced and reference HTTPS links', () => {
    const wrapper = mountMarkdownText('# Objective\n\n**Strong** and *emphasized*.\n\n- First\n- Second\n\n[Balanced](https://example.test/path_(part)) and [Reference][safe].\n\n[safe]: https://example.test/reference');
    expect(wrapper.get('h1').text()).toBe('Objective');
    expect(wrapper.get('strong').text()).toBe('Strong');
    expect(wrapper.get('em').text()).toBe('emphasized');
    expect(wrapper.findAll('ul li').map(item => item.text())).toEqual(['First', 'Second']);
    expect(wrapper.findAll('a').map(link => [link.text(), link.attributes('href')])).toEqual([
      ['Balanced', 'https://example.test/path_(part)'],
      ['Reference', 'https://example.test/reference'],
    ]);
  });

  it('transforms card references only outside inline and fenced code', () => {
    const reference = '[[card:card-a|Next card]]';
    const wrapper = mountMarkdownText(`${reference}\n\n\`${reference}\`\n\n\`\`\`text\n${reference}\n\`\`\``);
    expect(wrapper.findAll('a')).toHaveLength(1);
    expect(wrapper.get('a').attributes('href')).toBe('/cards/card-a');
    expect(wrapper.get('a').text()).toBe('Next card');
    expect(wrapper.findAll('code').map(code => code.element.textContent)).toEqual([reference, `${reference}\n`]);
    expect(wrapper.findAll('code a')).toHaveLength(0);
  });

  it.each([
    '[unfinished](/path',
    '[unbalanced](/path((part)',
    `[](${'\u00a0'.repeat(100)}`,
  ])('preserves malformed destination source literally: %s', source => {
    const wrapper = mountMarkdownText(source);
    expect(wrapper.findAll('a')).toHaveLength(0);
    // Vue Test Utils .text() trims whitespace, including the NBSP regression input.
    expect(wrapper.get('p').element.textContent).toBe(source);
  });

  it('sanitizes executable elements, attributes and URL spellings on the real string path', () => {
    const wrapper = mountMarkdownText([
      'Benign text <script>window.markdownInjected=true</script> remains.',
      '<img alt="safe image" src="data:image/png;base64,iVBORw0KGgo=" onerror="window.markdownInjected=true">',
      '<span onclick="window.markdownInjected=true">Safe span</span>',
      '[Unsafe](javascript:window.markdownInjected=true)',
      '<a href="java&#x73;cript:window.markdownInjected=true">Encoded unsafe</a>',
      '[Safe HTTPS](https://example.test/safe)',
      '[[card:card-a|Next card]]',
    ].join('\n\n'));
    expect(wrapper.findAll('script, [onerror], [onclick]')).toHaveLength(0);
    const anchors = wrapper.findAll('a');
    expect(anchors.map(link => [link.text(), link.attributes('href')])).toEqual([
      ['Unsafe', undefined], ['Encoded unsafe', undefined],
      ['Safe HTTPS', 'https://example.test/safe'], ['Next card', '/cards/card-a'],
    ]);
    expect(wrapper.get('img').attributes('alt')).toBe('safe image');
    expect(wrapper.get('span').text()).toBe('Safe span');
    expect(wrapper.element.textContent).toContain('Benign text  remains.');
  });
});
