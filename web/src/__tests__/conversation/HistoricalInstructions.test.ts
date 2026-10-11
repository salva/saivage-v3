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


describe('shared historical instruction presentation from source compiler/public projector', () => {
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
      const ingress = fixtureIngress('11111111-1111-4111-8111-111111111111', 'Synthetic operator input', { kind: 'prepared', role_text: role, node: null });
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
