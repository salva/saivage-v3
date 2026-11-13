import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { presentToolCall, presentToolResult } from '../../utils/tool-presenters';
import { buildToolDisplay } from '../../utils/tool-friendly';
import ToolChip from '../../components/conversation/ToolChip.vue';
import ToolSemanticSection from '../../components/conversation/ToolSemanticSection.vue';
import CodeBlock from '../../components/content/CodeBlock.vue';
import { callEnvelope } from './_helpers';
import { entry } from './fixtures';
import * as f from './agent-session-fixtures';

const success = (data: unknown) => JSON.stringify({ success: true, data });
const view = (data: unknown) => presentToolResult(success(data), { tool: 'read_agent_session' });
const fields = (data: unknown) => Object.fromEntries(view(data).sections.flatMap(s => s.fields ?? []).map(field => [field.label, field.parts.map(part => part.kind === 'text' ? part.text : part.kind === 'session' ? part.id : '').join('')]));
const itemSections = (data: unknown) => view(data).sections.flatMap(s => s.items ?? []);

function chip(data: unknown, args: Record<string, unknown> = { session_id: f.sessionId }, failed = false) {
  const callContent = callEnvelope('read_agent_session', args);
  const resultContent = failed ? JSON.stringify(data) : success(data);
  const call = entry('request', 'tool_call', callContent, { tool: 'read_agent_session', context_policy: { kind: 'tool_call' } });
  const result = entry('result', 'tool_result', resultContent, { tool: 'read_agent_session', context_policy: { kind: 'tool_result', settlement_origin: 'executed' } });
  const wrapper = mount(ToolChip, { props: { entryId: call.id, resultEntryId: result.id, display: buildToolDisplay({ entry: call, mate: result }), callContent, resultContent, expanded: true, detailsId: 'agent-tool-details' } });
  return { wrapper, callContent, resultContent };
}

describe('read_agent_session public observation presentation', () => {
  it.each([f.messages, f.context, f.diagnostics, f.message])('selects the actual $section page', data => {
    const result = view(data);
    expect(result.outcome).toBe('Observation recorded');
    expect(result.headline.map(p => p.kind === 'text' ? p.text : '').join('')).toContain(data.section);
    expect(JSON.stringify(result)).not.toContain('messages not reported');
    expect(fields(data)).toMatchObject({ 'segment id': f.segmentId, 'segment version': '1', 'has segment context': 'false' });
  });

  it('keeps the received omitted-section request and exact long message identity without truncation', () => {
    const omitted = presentToolCall(callEnvelope('read_agent_session', { session_id: f.sessionId }));
    expect(omitted.sections[0].fields?.map(field => field.label)).not.toContain('section');
    const requested = presentToolCall(callEnvelope('read_agent_session', { session_id: f.sessionId, section: 'message', message_id: f.messageId, position: { item_index: 0, item_byte_offset: 7 }, response_bytes: 1200 }));
    expect(requested.sections[0].fields?.find(field => field.label === 'message id')?.parts).toEqual([{ kind: 'text', text: f.messageId, language: 'text' }]);
    expect(JSON.stringify(presentToolCall(callEnvelope('read_runtime_events', { message_id: f.messageId })))).not.toContain(f.messageId);
  });

  it('preserves the existing populated context and message projections', () => {
    const contextFields = itemSections(f.compactedContext)[0].fields!;
    expect(contextFields.map(field => field.label)).toEqual(['kind', 'source version', 'covered through message id', 'summary text', 'protected prompts', 'required model facts', 'continuation']);
    expect(contextFields.find(field => field.label === 'summary text')?.parts).toEqual([{ kind: 'text', text: 'fixture compacted summary', language: 'text' }]);
    const messages = itemSections(f.messages)[0].fields!;
    expect(messages.find(field => field.label === 'content')?.parts).toEqual([{ kind: 'text', text: f.exactEntry.content, language: 'text' }]);
  });

  it('renders complete diagnostics in source order, not a row whitelist or inferred execution', () => {
    for (const data of [f.diagnostics, f.preparedDiagnostics, f.tailIncompleteDiagnostics]) {
      expect(itemSections(data).map(s => JSON.parse(s.content!))).toEqual(data.diagnostics.items);
      expect(itemSections(data).every(s => s.language === 'json')).toBe(true);
      expect(JSON.stringify(view(data))).not.toMatch(/replayed|executed successfully|all history/i);
    }
    expect(view(f.tailIncompleteDiagnostics).outcome).toContain('Incomplete previews');
    expect(fields(f.diagnostics)).toMatchObject({ scope: 'current_segment_rows', 'total diagnostic entries': '3', 'selected diagnostic entries': '3', 'omitted earlier diagnostic entries': '0', 'historical segments included': 'false', 'inherited notices included': 'false', 'first message id': 'activation', 'last message id': f.messageId, 'first timestamp': f.timestamp, 'last timestamp': f.timestamp, next: 'null' });
  });

  it('distinguishes selected-tail omissions, transport coverage and preview truncation even at next:null', () => {
    expect(view(f.tailDiagnostics).outcome).toBe('Observation recorded · 2 earlier diagnostics omitted');
    expect(fields(f.tailDiagnostics)).toMatchObject({ total: '1', returned: '1', next: 'null', 'total diagnostic entries': '3', 'selected diagnostic entries': '1', 'omitted earlier diagnostic entries': '2' });
    expect(view(f.partialDiagnostics).outcome).toBe('Observation recorded · Partial coverage');
    expect(fields(f.partialDiagnostics)).toMatchObject({ total: '3', returned: '1', position: '{\n  "item_index": 0,\n  "item_byte_offset": 0\n}', next: '{\n  "item_index": 1,\n  "item_byte_offset": 0\n}' });
    const empty = view(f.emptyDiagnostics);
    expect(empty.headline).toEqual([{ kind: 'text', text: '0 of 0 selected diagnostics' }]);
    expect(fields(f.emptyDiagnostics)).toMatchObject({ 'first message id': 'null', 'last message id': 'null', 'first timestamp': 'null', 'last timestamp': 'null', 'total diagnostic entries': '0', 'selected diagnostic entries': '0', 'historical segments included': 'false' });
    expect(JSON.stringify(empty)).not.toMatch(/no prior failure|no failures|all history/i);
  });

  it.each(['text', 'activity', 'model_issue', 'model_recovered', 'content_policy_refusal', 'tool_call', 'tool_result'])('keeps the full supplied exact %s entry', kind => {
    const supplied = { ...f.exactEntry, kind, links: [{ label: 'supplied link', target: 'literal' }], extra_public_fact: { complete: true } };
    expect(JSON.parse(itemSections({ ...f.message, message: f.page([supplied]) })[0].content!)).toEqual(supplied);
  });

  it('keeps entry origin and unavailable original metadata outside full and partial carried notice bodies', () => {
    for (const data of [f.carriedMessage, f.slicedCarriedMessage]) {
      expect(fields(data)).toMatchObject({ 'entry origin': 'carried_synthesized_notice', 'original event metadata': 'not_available' });
      expect(view(data).sections.some(s => s.title === 'Carried synthesized notice — not original event metadata')).toBe(true);
    }
    expect(fields(f.message)).toMatchObject({ 'entry origin': 'segment_row' });
    expect(fields(f.message)).not.toHaveProperty('original event metadata');
    const sliced = itemSections(f.slicedMessage)[0];
    expect(sliced).toMatchObject({ title: 'Partial JSON item 1 (not a complete observation)', content: '227d' });
    expect(sliced.language).toBeUndefined();
    expect(view(f.slicedMessage).outcome).toBe('Observation recorded · Partial coverage · Partial JSON items');
    for (const section of ['messages', 'context']) expect(view({ ...f.metadata, section, [section]: f.slicedMessage.message }).outcome).toContain('Partial JSON items');
  });

  it.each([f.emptySession, f.missingSession, f.missingMessage, f.unavailable, { success: false, error: 'No public data' }])('leaves failed envelopes to shared error/refusal rendering', envelope => {
    const result = presentToolResult(JSON.stringify(envelope), { tool: 'read_agent_session' });
    expect(result.status).toBe('error');
    expect(result.outcome).toBe(envelope === f.unavailable ? 'Failed · Restart required' : 'Failed');
    expect(result.sections[0]).toMatchObject({ title: 'Error', content: envelope.error });
    expect(JSON.stringify(result)).not.toMatch(/Observation recorded|not reported|recorded coverage|Selected messages/);
    if (envelope === f.missingMessage) expect(JSON.stringify(result.sections)).toContain(f.segmentId);
  });

  it.each([{ ...f.messages, section: 'unknown' }, { ...f.messages, section: undefined }, { ...f.messages, messages: undefined }, { ...f.messages, messages: [] }, { ...f.messages, messages: { total: 0 } }, { ...f.messages, messages: { items: [] } }])('refuses unknown or missing success collections rather than defaulting to messages', data => {
    expect(view(data)).toMatchObject({ status: 'error', outcome: 'Presentation unavailable', sections: [] });
  });

  it('mounts real Request/Result sections, preserves literal preview text and exact safe originals', async () => {
    const { wrapper, callContent, resultContent } = chip(f.diagnostics, { session_id: f.sessionId, section: 'diagnostics' });
    expect(wrapper.findAllComponents(ToolSemanticSection).length).toBeGreaterThan(3);
    expect(wrapper.find('.tool-request').text()).toContain('diagnostics');
    const rendered = wrapper.find('.tool-result').text();
    for (const text of ['instructions_omitted', 'preview_utf8_bytes', 'execution_failed', 'scope', 'current_segment_rows', 'omitted earlier diagnostic entries', f.messageId, f.timestamp, f.segmentId]) expect(rendered).toContain(text);
    expect(wrapper.find('.tool-result img').exists()).toBe(false);
    expect(rendered).toContain('<img src=x onerror=alert(1)>');
    const originals = wrapper.findAll('.safe-original').map(section => section.findComponent(CodeBlock).props('code'));
    expect(originals).toEqual([callContent, resultContent]);
    expect(originals[1]?.slice(-8)).toBe(resultContent.slice(-8));
    await wrapper.setProps({ expanded: false });
    expect(wrapper.find('.tool-chip-detail').exists()).toBe(false);
    const omitted = chip(f.tailIncompleteDiagnostics, { session_id: f.sessionId, section: 'diagnostics', last_n: 1 }).wrapper;
    await omitted.setProps({ expanded: false });
    expect(omitted.find('.tool-chip-status').text()).toContain('2 earlier diagnostics omitted');
    expect(omitted.find('.tool-chip-status').text()).toContain('Incomplete previews');
    const partial = chip(f.partialDiagnostics).wrapper;
    await partial.setProps({ expanded: false });
    expect(partial.find('.tool-chip-status').text()).toContain('Partial coverage');
    const prepared = chip(f.preparedDiagnostics).wrapper;
    expect(prepared.find('.tool-result').text()).toContain('activation_id');
    expect(prepared.find('.tool-result').text()).toContain('instructions_omitted');
  });

  it('mounts carried/sliced exact entries and failed lookup without misleading success', async () => {
    for (const data of [f.message, f.carriedMessage, f.slicedCarriedMessage]) {
      const id = data.entry_origin === 'segment_row' ? f.messageId : f.carriedEntry.id;
      const { wrapper, callContent, resultContent } = chip(data, { session_id: f.sessionId, section: 'message', message_id: id });
      expect(wrapper.find('.tool-request').text()).toContain(id);
      expect(wrapper.find('.tool-result').text()).toContain(data.entry_origin);
      if (data.entry_origin === 'carried_synthesized_notice') expect(wrapper.find('.tool-result').text()).toContain('not original event metadata');
      expect(wrapper.findAll('.safe-original').map(s => s.findComponent(CodeBlock).props('code'))).toEqual([callContent, resultContent]);
      if (typeof data.message.items[0] === 'object' && data.message.items[0] !== null && 'content_hex' in data.message.items[0]) {
        expect(wrapper.find('.tool-result').text()).toContain('not a complete observation');
        await wrapper.setProps({ expanded: false });
        expect(wrapper.find('.tool-chip-status').text()).toContain('Partial JSON items');
      }
    }
    const { wrapper } = chip(f.missingMessage, { session_id: f.sessionId, section: 'message', message_id: 'missing' }, true);
    expect(wrapper.find('.tool-result').text()).toContain(f.segmentId);
    expect(wrapper.find('.tool-result').text()).toContain(f.missingMessage.error);
    expect(wrapper.find('.tool-chip-status').text()).toContain('Failed');
    expect(wrapper.text()).not.toContain('Observation recorded');
  });
});
