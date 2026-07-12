import { createConversationMutationPort } from '../../src/persistence/conversation-mutation-port.js';

export function testConversationMutations(projectRoot: string) {
  return createConversationMutationPort(projectRoot, {
    runtimeChanged() {},
    cardStateChanged() {},
    agentsChanged() {},
    conversationChanged() {},
    subscribe() { return { unsubscribe() {} }; },
  });
}
