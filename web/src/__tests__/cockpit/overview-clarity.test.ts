import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { nextTick } from 'vue';
import CardOverviewFacet from '../../components/cockpit/CardOverviewFacet.vue';
import { useCardStore } from '../../stores/cards';
import { OperatorApiError } from '../../api/client';
import type { CardDetail } from '../../api/types';
import { cardDetail, hierarchyParent, hierarchyRecord } from './fixtures';

const api = vi.hoisted(() => ({
  getCard: vi.fn(),
  getCardChildren: vi.fn(),
  listCardRecords: vi.fn(),
  getCardRecord: vi.fn(),
  getCardAgentSessions: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  getCard: api.getCard,
  getCardChildren: api.getCardChildren,
  listCardRecords: api.listCardRecords,
  getCardRecord: api.getCardRecord,
  getCardAgentSessions: api.getCardAgentSessions,
}));

vi.mock('../../stores/sync', () => ({
  useSyncStore: () => ({
    openCardAgentSessions: (_cardId: string, callback: () => Promise<void>) => {
      void callback();
      return () => {};
    },
  }),
}));

const now = '2026-09-28T10:00:00.000Z';
const descriptors = [
  { name: 'mission-custom.md', format: 'markdown' as const, schema: 'mission.v1', bootstrap: true, current: { head_version: 5, head_entry_id: '11111111-1111-4111-8111-111111111111', state: 'open' as const, accepted_source_version: 2, draft_present: true } },
  { name: 'constraints.md', format: 'markdown' as const, schema: 'plain.v1', bootstrap: false, current: { head_version: 3, head_entry_id: '22222222-2222-4222-8222-222222222222', state: 'closed' as const, accepted_source_version: 2, draft_present: false } },
  { name: 'source-notes.md', format: 'markdown' as const, schema: 'plain.v1', bootstrap: false, current: null },
  { name: 'review-custom.md', format: 'markdown' as const, schema: 'plain.v1', bootstrap: false, current: { head_version: 1, head_entry_id: '33333333-3333-4333-8333-333333333333', state: 'closed' as const, accepted_source_version: 1, draft_present: false } },
];

function acceptedArtifact(name: string, content: string, headVersion = 3, sourceVersion = 2) {
  return {
    card_id: 'card-a',
    record: {
      name,
      head_version: headVersion,
      head_entry_id: '11111111-1111-4111-8111-111111111111',
      state: 'closed' as const,
      accepted: { source_version: sourceVersion, source_entry_id: '11111111-1111-4111-8111-111111111111', committed_at: now, writer_agent: 'analyst', card_version_seq: 2, content, content_sha256: 'a'.repeat(64), size_bytes: content.length },
      draft: null,
      discarded: null,
      effective_content_source: 'accepted' as const,
    },
  };
}

function draftArtifact(content: string) {
  return {
    card_id: 'card-a',
    record: {
      name: 'mission-custom.md',
      head_version: 5,
      head_entry_id: '11111111-1111-4111-8111-111111111111',
      state: 'open' as const,
      accepted: { source_version: 2, source_entry_id: '11111111-1111-4111-8111-111111111111', committed_at: now, writer_agent: 'analyst', card_version_seq: 2, content: 'Earlier accepted objective', content_sha256: 'a'.repeat(64), size_bytes: 26 },
      draft: { opened_at: now, updated_at: now, content, content_sha256: 'b'.repeat(64) },
      discarded: null,
      effective_content_source: 'draft' as const,
    },
  };
}

async function mountOverview(detail = cardDetail('card-a')) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useCardStore(pinia);
  await store.ensureRoot();
  await store.fetchCardDetail('card-a');
  await flushPromises();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/cards/:id', name: 'card-detail', component: { template: '<div />' } },
      { path: '/agents/:id', name: 'agent-detail', component: { template: '<div />' } },
    ],
  });
  await router.push('/cards/card-a');
  await router.isReady();
  const wrapper = mount(CardOverviewFacet, { props: { cardId: 'card-a', detail }, global: { plugins: [pinia, router] } });
  await flushPromises();
  return { wrapper, store };
}

describe('work-first Overview clarity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCard.mockResolvedValue({ card: cardDetail('card-a') });
    api.getCardChildren.mockImplementation(async (id: string) => id === 'project'
      ? { parent: hierarchyParent('project', { title: 'Project root title' }), children: [hierarchyRecord('card-a', { title: 'Parented work' })] }
      : { parent: hierarchyParent(id), children: [] });
    api.listCardRecords.mockResolvedValue({ card_id: 'card-a', records: descriptors });
    api.getCardAgentSessions.mockResolvedValue({ sessions: [] });
    api.getCardRecord.mockImplementation(async (_cardId: string, name: string) => {
      if (name === 'mission-custom.md') return draftArtifact('Draft objective ' + 'x'.repeat(650));
      if (name === 'constraints.md') return acceptedArtifact(name, 'These are source constraints, not a progress report.', 3, 2);
      if (name === 'source-notes.md') throw new OperatorApiError('cards.records.get', 500, { error: 'InternalServerError', message: 'Internal server error' });
      return acceptedArtifact(name, '# Review notes\nSubstantive observations only.', 1, 1);
    });
  });

  it('renders custom sources in declaration order with truthful state, bounded plain text, and direct full content', async () => {
    const { wrapper, store } = await mountOverview();

    const objective = wrapper.get('[data-testid="overview-objective"]');
    expect(objective.text()).toContain('From mission-custom.md');
    expect(objective.text()).toContain('Draft');
    const objectiveExcerpt = objective.get('[data-testid="record-excerpt"]').text();
    expect(Array.from(objectiveExcerpt).length).toBe(601);
    expect(objectiveExcerpt.endsWith('…')).toBe(true);
    expect(objective.get('.record-full-content').text()).toContain('Draft objective');
    expect(objective.get('.record-details').text()).toContain('Head revision5');
    expect(objective.get('.record-details').text()).toContain('Accepted source revision2');

    const records = wrapper.get('[data-testid="overview-records"]');
    expect(records.findAll('article').map((article) => article.get('h4').text())).toEqual(['constraints.md', 'source-notes.md', 'review-custom.md']);
    expect(records.text()).toContain('These are source constraints, not a progress report.');
    expect(records.text()).toContain('Could not load source-notes.md');
    expect(records.text()).toContain('Review notes');
    expect(records.text()).not.toMatch(/percent|approved progress/i);

    store.cardRecords['constraints.md'] = {
      ...store.cardRecords['constraints.md']!,
      refreshing: false,
      stale: true,
      staleReason: 'refresh-failed',
      refreshError: 'constraints refresh failed',
    };
    await nextTick();
    expect(records.text()).toContain('Last loaded · stale');
    expect(records.text()).toContain('constraints refresh failed');

    const recordsLink = wrapper.findAll('a').find((link) => link.text() === 'Records & History');
    expect(recordsLink?.attributes('href')).toBe('/cards/card-a?facet=records');
    expect(recordsLink?.attributes('href')).not.toMatch(/record=|version=/);
    wrapper.unmount();
  });

  it('keeps result and reason language neutral across done, failed, and unexplained stopped states', async () => {
    const done = cardDetail('card-a', {
      lifecycle: { status: 'done', completed_at: now, error: null, result: { kind: 'workflow-result', terminal: 'DONE', agent_name: 'reviewer', node_id: 'review', outcome: 'done', summary: 'Recorded output', records: [] } },
    });
    const { wrapper } = await mountOverview(done);
    expect(wrapper.get('[data-testid="overview-result-line"]').text()).toContain('Recorded result — Recorded output');
    expect(wrapper.text()).toContain('Accepted as done; not independently verified correctness.');

    await wrapper.setProps({ detail: cardDetail('card-a', { lifecycle: { status: 'failed', completed_at: now, error: 'Tool execution failed', result: { kind: 'runtime-failure', summary: 'Runtime stopped the attempt' } } }) });
    expect(wrapper.text()).toContain('Recorded result — Runtime stopped the attempt');
    expect(wrapper.text()).toContain('Ended');
    expect(wrapper.get('[data-testid="overview-problems"]').text()).toContain('Tool execution failed');
    expect(wrapper.text()).not.toContain('Accepted result');

    const blockedError = 'Provider declined this card';
    const blockedLifecycle = {
      status: 'blocked',
      completed_at: null,
      error: blockedError,
      result: {
        kind: 'content-policy-refusal',
        summary: 'Provider content policy blocked this card after one safety-respecting reframing attempt.',
        session_id: 'agent:executor:card-a',
        marker_id: 'marker-1',
        evidence_url: '/api/debug/provider-exchanges/marker-1',
      },
    } as CardDetail['lifecycle'];
    await wrapper.setProps({ detail: cardDetail('card-a', { lifecycle: blockedLifecycle }) });
    expect(wrapper.get('[data-testid="overview-result-line"]').text()).toContain('Provider content policy blocked');
    expect(wrapper.text().split(blockedError)).toHaveLength(2);

    await wrapper.setProps({ detail: cardDetail('card-a', { lifecycle: { status: 'stopped', completed_at: null, error: null, result: null } }) });
    expect(wrapper.text()).toContain('No result recorded.');
    expect(wrapper.text()).toContain('No card error reported.');
    expect(wrapper.text()).toContain('No reason is supplied by the current card detail');
    wrapper.unmount();
  });

  it('distinguishes unpublished sessions and undiscovered child work without inventing absence', async () => {
    const { wrapper } = await mountOverview();
    expect(wrapper.text()).toContain('No published sessions');
    expect(wrapper.text()).toContain('does not prove that nobody has ever worked');
    expect(wrapper.get('[data-testid="overview-related-work"]').text()).toContain('Child work has not been requested.');
    expect(wrapper.get('[data-testid="overview-related-work"]').text()).toContain('Parent: Project root title');
    wrapper.unmount();
  });
});
