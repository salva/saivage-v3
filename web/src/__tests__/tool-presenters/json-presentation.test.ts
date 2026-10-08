import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { presentToolCall, presentToolResult } from '../../utils/tool-presenters';
import ToolSemanticSection from '../../components/conversation/ToolSemanticSection.vue';
import { callEnvelope } from './_helpers';
import { collection, processData, slice } from './fixtures';

describe('producer-owned JSON presentation identity', () => {
  it('marks opaque arguments/results and bootstrap objects, but not shortened headlines', () => {
    const args = { payload: { items: [1, null, true], text: '<img src=x>' } };
    const call = presentToolCall(callEnvelope('unknown_tool', args));
    expect(call.sections[0]).toMatchObject({ language: 'json', content: JSON.stringify(args, null, 2) });
    expect(call.headline.every(part => part.kind === 'text' && part.language === undefined)).toBe(true);
    expect(presentToolResult('{"success":true,"data":[1,null]}', { tool: 'unknown_tool' }).sections[0]).toMatchObject({ language: 'json', content: '[\n  1,\n  null\n]' });
    const bootstrap = presentToolCall(callEnvelope('create_card', { title: 'Leaf', bootstrap_content: { 'brief.md': 'Literal instructions' } }));
    expect(bootstrap.sections[1]).toMatchObject({ language: 'json', content: '{\n  "brief.md": "Literal instructions"\n}' });
  });

  it('carries structured config and failure fields into inline JSON without changing serialization', () => {
    const config = { agents: { planner: 'worker' }, analyst_agent: 'analyst', card_types: ['leaf'] };
    const sections = presentToolResult(JSON.stringify({ success: true, data: { config } }), { tool: 'show_config' }).sections;
    const fields = sections[1].fields!;
    expect(fields.find(field => field.label === 'agents')!.parts).toEqual([{ kind: 'text', text: JSON.stringify(config.agents, null, 2), language: 'json' }]);
    expect(fields.find(field => field.label === 'analyst agent')!.parts).toEqual([{ kind: 'text', text: 'analyst', language: 'text' }]);
    const wrapper = mount(ToolSemanticSection, { props: { section: sections[1] } });
    expect(wrapper.findAll('.json-text')).toHaveLength(2);
    expect(wrapper.find('.json-token-key').text()).toBe('"planner"');
    const failed = presentToolResult('{"success":false,"error":"Refused","data":{"current_head":{"revision":3},"reason":"literal prose"}}', { tool: 'unknown_tool' });
    expect(failed.sections[0]).toMatchObject({ title: 'Error', content: 'Refused' });
    const context = failed.sections.find(section => section.title === 'Recorded refusal / error context')!;
    expect(context.fields!.find(field => field.label === 'current head')!.parts).toEqual([{ kind: 'text', text: '{"revision":3}', language: 'json' }]);
    expect(context.fields!.find(field => field.label === 'reason')!.parts[0]).toMatchObject({ language: 'text' });
  });

  it('preserves MCP JSON identity only for non-string bodies, including recursive sections', () => {
    const call = presentToolCall(callEnvelope('mcp_tool_call', { serverName: 'public', toolName: 'lookup', args: { input: [1, 2] } }));
    expect(call.sections[1].language).toBe('json');
    const structured = presentToolResult('{"success":true,"data":{"result":{"structuredContent":{"ok":true}}}}', { tool: 'mcp_tool_call' }).sections[0];
    const string = presentToolResult('{"success":true,"data":{"result":"{\\"ok\\":true}"}}', { tool: 'mcp_tool_call' }).sections[0];
    expect(structured.language).toBe('json');
    expect(string.language).toBe('text');
    const wrapper = mount(ToolSemanticSection, { props: { section: { title: 'Recursive', items: [{ ...structured, disclosure: true }, string] } } });
    expect(wrapper.findAll('.json-text')).toHaveLength(1);
    expect((wrapper.find('details').element as HTMLDetailsElement).open).toBe(false);
    expect(wrapper.findAll('code').map(code => code.element.textContent)).toEqual([structured.content, string.content]);
  });

  it('keeps stdout/stderr, patches, prose, slices and partial hex items uncolored', () => {
    const process = presentToolResult(JSON.stringify({ success: true, data: { ...processData, stdout: '{"ordinary log":true}' } }), { tool: 'run_command' });
    expect(process.sections.filter(section => section.content !== undefined).every(section => section.language === 'text')).toBe(true);
    const patch = presentToolCall(callEnvelope('apply_patch', { patch: '{"not": "a JSON data display"}' }));
    expect(patch.sections[1].language).toBe('text');
    const read = presentToolResult(JSON.stringify({ success: true, data: { content: slice('{"slice":1}') } }), { tool: 'read' });
    const recorded = read.sections.find(section => section.title === 'Recorded content');
    expect(recorded?.content).toBe('{"slice":1}');
    expect(recorded?.language).toBeUndefined();
    const page = presentToolResult(JSON.stringify({ success: true, data: { cards: collection([{ content_hex: '7b22', ...slice('') }]) } }), { tool: 'list_cards' });
    const partial = page.sections.find(section => section.items)?.items![0];
    expect(partial?.content).toBe('7b22');
    expect(partial?.language).toBeUndefined();
  });
});
