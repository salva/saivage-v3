import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationInvalidation } from '../../sync/client';
import { useSelectedConversation } from '../../composables/useSelectedConversation';

const harness = vi.hoisted(() => {
  const token = Object.freeze({ token: 'selected' });
  return {
    token,
    order: [] as string[],
    callback: null as null | ((frame: ConversationInvalidation) => Promise<void>),
    beginConversationSelection: vi.fn(() => token),
    refetchConversation: vi.fn(async () => undefined),
    fetchConversation: vi.fn(async () => undefined),
    fetchConversationVersions: vi.fn(async () => undefined),
    selectConversationVersion: vi.fn(async () => undefined),
    clearConversationSelection: vi.fn(),
    close: vi.fn(),
    openConversation: vi.fn(),
  };
});

vi.mock('../../stores/agents', () => ({
  useAgentStore: () => ({
    beginConversationSelection: harness.beginConversationSelection,
    refetchConversation: harness.refetchConversation,
    fetchConversation: harness.fetchConversation,
    fetchConversationVersions: harness.fetchConversationVersions,
    selectConversationVersion: harness.selectConversationVersion,
    clearConversationSelection: harness.clearConversationSelection,
  }),
}));

vi.mock('../../stores/sync', () => ({
  useSyncStore: () => ({ openConversation: harness.openConversation }),
}));

let selectedConversation: ReturnType<typeof useSelectedConversation>;
const Host = defineComponent({
  setup() {
    selectedConversation = useSelectedConversation('agent:planner:project');
    return () => null;
  },
});

describe('useSelectedConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.order.length = 0;
    harness.callback = null;
    harness.beginConversationSelection.mockImplementation(() => {
      harness.order.push('claim');
      return harness.token;
    });
    harness.openConversation.mockImplementation((_sessionId, callback) => {
      harness.order.push('subscribe');
      harness.callback = callback;
      return () => {
        harness.order.push('close');
        harness.close();
      };
    });
    harness.clearConversationSelection.mockImplementation(() => {
      harness.order.push('clear');
    });
  });

  it('claims before subscribing and waits for the acknowledged callback before reading', async () => {
    mount(Host);

    expect(harness.order).toEqual(['claim', 'subscribe']);
    expect(harness.beginConversationSelection).toHaveBeenCalledWith('agent:planner:project');
    expect(harness.openConversation).toHaveBeenCalledWith(
      'agent:planner:project',
      expect.any(Function),
    );
    expect(harness.refetchConversation).not.toHaveBeenCalled();
    await selectedConversation.reload();
    expect(harness.fetchConversation).not.toHaveBeenCalled();

    await harness.callback!(null);
    expect(harness.refetchConversation).toHaveBeenCalledWith(harness.token, null);
  });

  it('forwards typed invalidations with the captured token', async () => {
    mount(Host);
    const frame = {
      t: 'invalidate',
      resource: 'conversation',
      id: 'agent:planner:project',
      segment_version: 3,
      visible_message_id: 'message-3',
    } as const;

    await harness.callback!(frame);

    expect(harness.refetchConversation).toHaveBeenCalledWith(harness.token, frame);
  });

  it('gates manual reload on acknowledgement and consumes its expected rejection', async () => {
    mount(Host);
    await selectedConversation.reload();
    expect(harness.fetchConversation).not.toHaveBeenCalled();
    await harness.callback!(null);
    harness.fetchConversation.mockRejectedValueOnce(new Error('recorded request failure'));

    await expect(selectedConversation.reload()).resolves.toBeUndefined();

    expect(harness.fetchConversation).toHaveBeenCalledWith(harness.token);
  });

  it('keeps version-history operations bound to the captured token', async () => {
    mount(Host);

    await selectedConversation.fetchVersions();
    await selectedConversation.selectVersion(4);

    expect(harness.fetchConversationVersions).toHaveBeenCalledWith(harness.token);
    expect(harness.selectConversationVersion).toHaveBeenCalledWith(harness.token, 4);
  });

  it('closes before clearing and lets an in-flight guarded callback finish after unmount', async () => {
    let finish!: () => void;
    harness.refetchConversation.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (finish = resolve));
    });
    const wrapper = mount(Host);
    const callback = harness.callback!(null);

    wrapper.unmount();

    expect(harness.order).toEqual(['claim', 'subscribe', 'close', 'clear']);
    expect(harness.clearConversationSelection).toHaveBeenCalledWith(harness.token);
    expect(harness.refetchConversation).toHaveBeenCalledOnce();
    finish();
    await callback;
    expect(harness.refetchConversation).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.clearConversationSelection).toHaveBeenCalledOnce();
  });
});
