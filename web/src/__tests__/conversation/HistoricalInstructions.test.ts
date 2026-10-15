import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createRouter, createMemoryHistory } from 'vue-router';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ConversationTimeline from '../../components/conversation/ConversationTimeline.vue';
import { entriesToTimeline } from '../../utils/agent-timeline';
import { activationEntry } from '../../utils/agent-timeline/activation';
import { compilePromptTemplate, renderCompiledPrompt, type PromptHost } from '../../../../src/utils/prompt-api';
import { projectCanonicalConversationRow } from '../../../../src/application/read-models/canonical-conversation-outbound';
import { agentMessageSchema, STRUCTURAL_ROW_POLICY, type ActivationInstructions } from '../../../../src/schemas/index';
import { entry } from '../tool-presenters/fixtures';
import { redactTextForOutbound } from '../../../../src/redaction';
import type { ConversationSessionId } from '../../../../src/schemas/conversation-session-id';

const inputId = '44444444-4444-4444-8444-444444444444';
function marker(session: ConversationSessionId, instructions: ActivationInstructions, id = inputId) {
  const base = entry(`${id}:activation`, 'activity', '', { session_id: session, role: 'system', context_policy: STRUCTURAL_ROW_POLICY.activation_boundary });
  const cardId = session.split(':')[2];
  return agentMessageSchema.parse({ ...base, content: JSON.stringify({ event: 'activation_open', agent_name: session.split(':')[1], input_id: id, timestamp: base.timestamp,
    ...(cardId === 'global' ? {} : { card_id: cardId }), instructions }, null, 2) });
}
const parentInstructions: ActivationInstructions = {
  kind: 'prepared', activation_id: inputId,
  caller: { kind: 'parent', cardId: 'project', sessionId: 'agent:planner:project', sourceInputId: inputId, toolCallId: 'parent-call', toolName: 'activate_card' },
  card: { cardId: 'card-a', cardType: 'code', title: 'Recorded card title' },
  role_text: redactTextForOutbound(`${'Historical role full text. '.repeat(150)} token=role-private-canary FINAL-ROLE`),
  node: { node_id: 'execute', text: redactTextForOutbound('Recorded node token=node-private-canary FINAL-NODE') },
  parent_direction: { text: redactTextForOutbound('Exact advisory token=parent-private-canary FINAL-PARENT') },
};


describe('shared historical instruction presentation from source compiler/public projector', () => {
  it('keeps complete public parent preparation, original recorded bytes and source provenance through replacement', async () => {
    const prepared = marker('agent:executor:card-a', parentInstructions);
    const unavailable = marker(prepared.session_id, { kind: 'unavailable', reason: 'not_recorded' }, '55555555-5555-4555-8555-555555555555');
    const diagnostic = entry('issue', 'model_issue', 'Recorded issue');
    const refusal = entry('refusal', 'content_policy_refusal', '{}');
    const rows = [prepared, diagnostic, refusal, unavailable];
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });
    await router.push('/'); await router.isReady();
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    const wrapper = mount(ConversationTimeline, { props: { timeline: entriesToTimeline(rows), expandedIds: new Set<string>() }, global: { plugins: [router] } });
    const activation = wrapper.get('.activation-marker');
    const disclosures = activation.findAll('.instruction-disclosure');
    expect(disclosures.map(d => d.get('summary').text())).toEqual(['Role instructions', 'Node execute instructions', 'Parent activation direction', 'Caller and card orientation']);
    const orientation = JSON.stringify({ activation_id: parentInstructions.activation_id, caller: parentInstructions.caller, card: parentInstructions.card }, null, 2);
    for (const [index, value] of [parentInstructions.role_text, parentInstructions.node!.text, parentInstructions.parent_direction!.text, orientation].entries()) {
      expect((disclosures[index].element as HTMLDetailsElement).open).toBe(false);
      expect(disclosures[index].get('pre').element.textContent).toBe(value);
      await disclosures[index].get('button').trigger('click');
      expect(copy).toHaveBeenLastCalledWith(value);
    }
    expect(activation.text()).toContain('Activation-scoped advisory direction, not acceptance');
    const raw = activation.get('details:not(.instruction-disclosure)');
    expect(raw.get('pre').element.textContent).toBe(prepared.content);
    expect(raw.text()).toContain(`system · ${prepared.timestamp} · ${prepared.id} · source ${prepared.round_id}, message 0, block 0`);
    expect(wrapper.findAll('[data-entry-id]').map(row => row.attributes('data-entry-id'))).toEqual(rows.map(row => row.id));
    expect(wrapper.text()).toContain('repeated provider content-policy refusal');
    expect(wrapper.text()).not.toMatch(/private-canary|outside this displayed/);
    await wrapper.setProps({ timeline: entriesToTimeline([unavailable]) });
    expect(wrapper.findAll('.activation-marker')).toHaveLength(1);
    expect(wrapper.findAll('.instruction-disclosure')).toHaveLength(0);
    expect(wrapper.text()).toContain('Historical instructions unavailable — not recorded');
    expect(wrapper.text()).not.toContain('FINAL-ROLE');
    wrapper.unmount();
  });

  it.each<ConversationSessionId>(['agent:executor:project', 'agent:analyst:global'])('distinguishes root/global preparation without inventing a parent: %s', (session) => {
    const global = session.endsWith(':global');
    const instructions: ActivationInstructions = { kind: 'prepared', role_text: 'Recorded role', activation_id: global ? null : inputId,
      caller: { kind: global ? 'global' : 'root' }, card: global ? null : { cardId: 'project', cardType: 'project', title: 'Root' },
      node: global ? null : { node_id: 'plan', text: 'Root node' }, parent_direction: null };
    const wrapper = mount(ConversationTimeline, { props: { timeline: entriesToTimeline([marker(session, instructions)]), expandedIds: new Set<string>() } });
    expect(wrapper.text()).toContain(`No parent direction · ${global ? 'global' : 'root'} caller`);
    expect(wrapper.findAll('.instruction-disclosure')).toHaveLength(global ? 2 : 3);
    expect(wrapper.text()).not.toContain('Parent activation direction');
    wrapper.unmount();
  });

  it('keeps first-row notice semantics for ordinary, empty and compacted-only inputs and rejects malformed markers', async () => {
    const prepared = marker('agent:analyst:global', { kind: 'unavailable', reason: 'not_recorded' });
    const wrapper = mount(ConversationTimeline, { props: { timeline: entriesToTimeline([entry('ordinary', 'text', 'First'), prepared]), expandedIds: new Set<string>() } });
    expect(wrapper.text()).toContain('activation start is outside this displayed segment or tail');
    await wrapper.setProps({ timeline: entriesToTimeline([prepared]) });
    expect(wrapper.text()).not.toContain('outside this displayed');
    await wrapper.setProps({ timeline: entriesToTimeline([]) });
    expect(wrapper.text()).not.toContain('outside this displayed');
    await wrapper.setProps({ timeline: entriesToTimeline([entry('compacted', 'text', 'Retained summary', { round_id: 'r-compacted-0000000000000000000000000000000c' })]) });
    expect(wrapper.text()).not.toContain('outside this displayed');
    wrapper.unmount();
    expect(() => mount(ConversationTimeline, { props: { timeline: entriesToTimeline([{ ...prepared, content: '{' }]), expandedIds: new Set<string>() } })).toThrow('Malformed activation_open');
  });
  it('renders compiled role text and explicit absence without current templates, and marked text/repair once at source positions', async () => {
      const promptRoot = join(process.cwd(), '../src/config/system-templates/classic/prompts');
      const compile = (host: PromptHost, name: string, family: string) => {
        const path = join(promptRoot, family, '_shared', `${name}.md`);
        return compilePromptTemplate({ host, name, path, text: readFileSync(path, 'utf8'), resolveFragment: id => {
          const path = join(promptRoot, 'fragments/_shared', `${id}.md`);
          return { path, text: readFileSync(path, 'utf8') };
        } });
      };
      const role = renderCompiledPrompt({ kind: 'global-agent' }, 'analyst', compile({ kind: 'global-agent' }, 'analyst', 'agents'), { vocabularySnippet: 'Synthetic source vocabulary' });
      const session = 'agent:analyst:global';
      const fixtureIngress = (inputId: string, content: string, instructions: ActivationInstructions) => {
        const base = { ...entry(inputId, 'text', content), session_id: session };
        return [agentMessageSchema.parse({ ...base, id: `${inputId}:activation`, role: 'system', kind: 'activity', context_policy: STRUCTURAL_ROW_POLICY.activation_boundary, content: JSON.stringify({ event: 'activation_open', agent_name: 'analyst', input_id: inputId, timestamp: base.timestamp, instructions }) }), agentMessageSchema.parse(base)];
      };
      const ingress = fixtureIngress('11111111-1111-4111-8111-111111111111', 'Synthetic operator input', { kind: 'prepared',activation_id:null,caller:{kind:'global'},card:null,parent_direction:null, role_text: role, node: null });
      const absent = fixtureIngress('22222222-2222-4222-8222-222222222222', 'Historical input', { kind: 'unavailable', reason: 'not_recorded' });
      const confirmation = fixtureIngress('33333333-3333-4333-8333-333333333333', 'Confirmation', { kind: 'not_applicable', reason: 'non_model_ingress' });
      const host = { kind: 'process', cardType: 'code' } as const;
      const prompt = { role: 'user' as const, content: renderCompiledPrompt(host, 'execute', compile(host, 'execute', 'process'), { cardType: 'code' }), instruction_origin: 'workflow_prompt' as const };
      const cardSession = 'agent:executor:card-a';
      const inputId = '44444444-4444-4444-8444-444444444444';
      const marked = agentMessageSchema.parse({ ...entry('owned-prompt', 'text', prompt.content), session_id: cardSession, role: 'user', instruction_origin: prompt.instruction_origin });
      const ordinary = agentMessageSchema.parse({ ...marked, id: 'ordinary-neighbor', instruction_origin: undefined });
      const repair = { ...marked, id: `${inputId}:repair`, kind: 'model_repair' as const };
      const rows = [...ingress, ...absent, ...confirmation, marked, ordinary, repair].map(row => projectCanonicalConversationRow(row, () => { throw new Error('Fixture has no tool invocations.'); }));
      const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });
      await router.push('/'); await router.isReady();
      const copy = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
      const wrapper = mount(ConversationTimeline, { props: { timeline: entriesToTimeline(rows), expandedIds: new Set<string>() }, global: { plugins: [router] } });
      expect(wrapper.text()).toContain('Prepared instructions');
      expect(wrapper.text()).toContain('privacy-filtered recorded instructions');
       expect(wrapper.text()).toContain('Historical instructions unavailable — not recorded');
       expect(wrapper.text()).toContain('No model invocation for this ingress');
       expect(wrapper.findAll('.activation-marker').map(row => row.attributes('data-entry-id'))).toEqual([ingress[0].id, absent[0].id, confirmation[0].id]);
       expect(wrapper.findAll('.activation-marker').slice(1).every(row => row.find('.instruction-disclosure').exists() === false)).toBe(true);
      const roleDisclosure = wrapper.get('.activation-marker .instruction-disclosure');
      expect(roleDisclosure.get('summary').text()).toBe('Role instructions');
      expect(roleDisclosure.get('pre').element.textContent).toBe(role);
      await roleDisclosure.get('button').trigger('click');
      expect(copy).toHaveBeenCalledWith(role);
      const promptRow = wrapper.get(`[data-entry-id="${marked.id}"]`);
      expect(promptRow.findAll('summary')).toHaveLength(1);
      expect(promptRow.text()).toContain('Recorded workflow instruction');
      expect(wrapper.get(`[data-entry-id="${ordinary.id}"]`).find('details').exists()).toBe(false);
      const repairRow = wrapper.get(`[data-entry-id="${repair.id}"]`);
      expect(repairRow.findAll('pre')).toHaveLength(1);
      expect(repairRow.text()).toContain('Repair instruction recorded');
      expect(repairRow.text()).toContain('Recorded workflow instruction');
      expect(wrapper.text()).not.toContain('Delivered instructions');
      const bad = { ...ingress[0], content: JSON.stringify({ ...JSON.parse(ingress[0].content), instructions: undefined }) };
      expect(() => activationEntry(bad)).toThrow('Malformed activation_open');
      wrapper.unmount();
  });
});
