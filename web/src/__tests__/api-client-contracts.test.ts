import { describe, expect, it } from 'vitest';
import * as client from '../api/client';

const removedMutationExports = [
  'createCard',
  'updateCard',
  'deleteCard',
  'startProject',
  'stopProject',
  'pauseRuntime',
  'resumeRuntime',
  'freezeRuntime',
  'resumeRuntimeFromFreeze',
  'acknowledgeNote',
  'deleteNote',
  'clearAllNotes',
  'acknowledgeNotification',
  'terminateProcess',
] as const;

const preservedReadAndBoundedWriteExports = [
  'listCards',
  'getCard',
  'getRuntimeState',
  'issueWebSocketTicket',
  'sendChatMessage',
] as const;

describe('operator API client contracts after S06 mutation removal', () => {
  it('does not export removed operator-side mutation helpers', () => {
    for (const name of removedMutationExports) {
      expect(client).not.toHaveProperty(name);
    }
  });

  it('preserves read clients plus bounded bootstrap and analyst chat writes', () => {
    for (const name of preservedReadAndBoundedWriteExports) {
      expect(client).toHaveProperty(name);
      expect(typeof client[name]).toBe('function');
    }
  });
});
