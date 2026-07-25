import { describe, expect, it } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import { useAgentTimeline } from '../../composables/useAgentTimeline';
import type { AgentConversationEntry } from '../../api/types';

const assistantRound = 'r-assistant-00000000000000000000000000000001';
const assistantRoundTwo = 'r-assistant-00000000000000000000000000000002';
const userRound = 'r-user-00000000000000000000000000000003';

function textEntry(id: string, round_id = assistantRound): AgentConversationEntry {
  return {
    id,
    session_id: 'agent:analyst:global',
    role: round_id.startsWith('r-user-') ? 'user' : 'assistant',
    kind: 'text',
    content: `message ${id}`,
    round_id,
    message_index: Number(id.replace(/\D/g, '') || 0),
    block_index: 0,
    timestamp: `2026-01-01T00:00:0${Number(id.replace(/\D/g, '') || 0)}.000Z`,
  } as AgentConversationEntry;
}

function scrollElement(scrollTop = 0): HTMLElement {
  return { scrollTop, scrollHeight: 1000, clientHeight: 200 } as HTMLElement;
}

async function flushScrollWatch(): Promise<void> {
  await nextTick();
  await nextTick();
}

function setup(initialEntries: AgentConversationEntry[] = [textEntry('m1')]) {
  const entries = ref<readonly AgentConversationEntry[]>(initialEntries);
  const controls = useAgentTimeline(entries);
  const el = scrollElement();
  controls.scrollAreaRef.value = el;
  return { entries, controls, el };
}

function markScrolledAway(controls: ReturnType<typeof useAgentTimeline>, el: HTMLElement): void {
  el.scrollTop = 0;
  controls.handleTimelineScroll();
  expect(controls.pinnedToLatest.value).toBe(false);
}

describe('useAgentTimeline auto-scroll trigger', () => {
  it('tail-follows within-round appends without increasing unseen count', async () => {
    const { entries, controls, el } = setup();

    entries.value = [...entries.value, textEntry('m2', assistantRound)];
    await flushScrollWatch();

    expect(el.scrollTop).toBe(el.scrollHeight);
    expect(controls.unseenCount.value).toBe(0);
  });

  it('routes within-round appends to unseen count when scrolled away', async () => {
    const { entries, controls, el } = setup();
    markScrolledAway(controls, el);

    entries.value = [...entries.value, textEntry('m2', assistantRound)];
    await flushScrollWatch();

    expect(el.scrollTop).toBe(0);
    expect(controls.unseenCount.value).toBe(1);
  });

  it('tail-follows and counts unseen content for new rounds', async () => {
    const tailing = setup();
    tailing.entries.value = [...tailing.entries.value, textEntry('m2', userRound)];
    await flushScrollWatch();

    expect(tailing.el.scrollTop).toBe(tailing.el.scrollHeight);
    expect(tailing.controls.unseenCount.value).toBe(0);

    const away = setup();
    markScrolledAway(away.controls, away.el);
    away.entries.value = [...away.entries.value, textEntry('m2', assistantRoundTwo)];
    await flushScrollWatch();

    expect(away.el.scrollTop).toBe(0);
    expect(away.controls.unseenCount.value).toBe(1);
  });

  it('pauses auto-scroll while pinned and resumes according to pinned state', async () => {
    const { entries, controls, el } = setup();

    controls.toggleAutoScrollPause();
    expect(controls.autoScrollPaused.value).toBe(true);

    entries.value = [...entries.value, textEntry('m2', assistantRound)];
    await flushScrollWatch();

    expect(el.scrollTop).toBe(0);
    expect(controls.unseenCount.value).toBe(1);

    controls.toggleAutoScrollPause();
    await flushScrollWatch();

    expect(controls.autoScrollPaused.value).toBe(false);
    expect(controls.unseenCount.value).toBe(0);
    expect(el.scrollTop).toBe(el.scrollHeight);

    el.scrollTop = 0;
    markScrolledAway(controls, el);
    controls.toggleAutoScrollPause();
    entries.value = [...entries.value, textEntry('m3', assistantRound)];
    await flushScrollWatch();
    expect(controls.unseenCount.value).toBe(1);

    el.scrollTop = 0;
    controls.toggleAutoScrollPause();
    await flushScrollWatch();

    expect(controls.autoScrollPaused.value).toBe(false);
    expect(controls.unseenCount.value).toBe(1);
    expect(el.scrollTop).toBe(0);
  });

  it('ignores visible volume decreases', async () => {
    const { entries, controls, el } = setup([textEntry('m1'), textEntry('m2', assistantRound)]);

    entries.value = [textEntry('m1')];
    await flushScrollWatch();

    expect(el.scrollTop).toBe(0);
    expect(controls.unseenCount.value).toBe(0);
  });
});
