import { describe, expect, it } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import { useAgentTimeline } from '../../composables/useAgentTimeline';
import type { ActivityStatus, AgentConversationEntry } from '../../api/types';

const assistantRound = 'r-assistant-00000000000000000000000000000001';
const assistantRoundTwo = 'r-assistant-00000000000000000000000000000002';
const userRound = 'r-user-00000000000000000000000000000003';

function textEntry(id: string, round_id = assistantRound): AgentConversationEntry {
  return {
    id,
    session_id: 's1',
    role: round_id.startsWith('r-user-') ? 'user' : 'assistant',
    kind: 'text',
    content: `message ${id}`,
    round_id,
    message_index: Number(id.replace(/\D/g, '') || 0),
    block_index: 0,
    timestamp: `2026-01-01T00:00:0${Number(id.replace(/\D/g, '') || 0)}.000Z`,
  } as AgentConversationEntry;
}

function idleActivity(): ActivityStatus {
  return { status: 'idle', pending_calls: [], updated_at: '2026-01-01T00:00:00.000Z' };
}

function activityWithPending(count: number): ActivityStatus {
  return {
    status: 'tool_calling',
    pending_calls: Array.from({ length: count }, (_, index) => ({
      id: `pending-${index}`,
      tool: 'read',
      started_at: `2026-01-01T00:00:0${index}.000Z`,
    })),
    updated_at: '2026-01-01T00:00:01.000Z',
  };
}

function scrollElement(scrollTop = 0): HTMLElement {
  return { scrollTop, scrollHeight: 1000, clientHeight: 200 } as HTMLElement;
}

async function flushScrollWatch(): Promise<void> {
  await nextTick();
  await nextTick();
}

function setup(
  initialEntries: AgentConversationEntry[] = [textEntry('m1')],
  initialActivity: ActivityStatus | null = idleActivity(),
  initialExtraPending = 0,
) {
  const entries = ref<readonly AgentConversationEntry[]>(initialEntries);
  const activityStatus = ref<ActivityStatus | null>(initialActivity);
  const extraPendingCount = ref(initialExtraPending);
  const controls = useAgentTimeline(entries, activityStatus, undefined, extraPendingCount);
  const el = scrollElement();
  controls.scrollAreaRef.value = el;
  return { entries, activityStatus, extraPendingCount, controls, el };
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

  it('reacts to activity pending footer growth', async () => {
    const tailing = setup();
    tailing.activityStatus.value = activityWithPending(1);
    await flushScrollWatch();

    expect(tailing.el.scrollTop).toBe(tailing.el.scrollHeight);
    expect(tailing.controls.unseenCount.value).toBe(0);

    const away = setup();
    markScrolledAway(away.controls, away.el);
    away.activityStatus.value = activityWithPending(2);
    await flushScrollWatch();

    expect(away.el.scrollTop).toBe(0);
    expect(away.controls.unseenCount.value).toBe(2);
  });

  it('reacts to analyst extra pending count growth', async () => {
    const tailing = setup();
    tailing.extraPendingCount.value = 1;
    await flushScrollWatch();

    expect(tailing.el.scrollTop).toBe(tailing.el.scrollHeight);
    expect(tailing.controls.unseenCount.value).toBe(0);

    const away = setup();
    markScrolledAway(away.controls, away.el);
    away.extraPendingCount.value = 3;
    await flushScrollWatch();

    expect(away.el.scrollTop).toBe(0);
    expect(away.controls.unseenCount.value).toBe(3);
  });

  it('does not double-count pending-to-entry replacement', async () => {
    const { entries, activityStatus, controls, el } = setup([textEntry('m1')], activityWithPending(1));

    entries.value = [...entries.value, textEntry('m2', assistantRound)];
    activityStatus.value = idleActivity();
    await flushScrollWatch();

    expect(el.scrollTop).toBe(0);
    expect(controls.unseenCount.value).toBe(0);
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

    const pending = setup([textEntry('m1')], activityWithPending(2));
    pending.activityStatus.value = activityWithPending(1);
    await flushScrollWatch();

    expect(pending.el.scrollTop).toBe(0);
    expect(pending.controls.unseenCount.value).toBe(0);
  });
});
