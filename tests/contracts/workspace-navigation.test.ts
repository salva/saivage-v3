import { describe, expect, it } from '@jest/globals';

import {
  workspaceNavigationIntentSchema,
  workspaceNavigationTargetSchema,
} from '../../src/contracts/workspace-navigation.js';

describe('workspace navigation contract', () => {
  it('accepts current workspace and Back intents', () => {
    expect(workspaceNavigationIntentSchema.parse({
      intent: 'navigate_workspace',
      target: { kind: 'card', id: 'card-a', refinement: 'history' },
    })).toEqual({
      intent: 'navigate_workspace',
      target: { kind: 'card', id: 'card-a', refinement: 'history' },
    });
    expect(workspaceNavigationIntentSchema.parse({ intent: 'navigate_back' })).toEqual({ intent: 'navigate_back' });
  });

  it('rejects malformed discriminants and missing workspace targets', () => {
    expect(() => workspaceNavigationIntentSchema.parse({ intent: 'open_workspace', target: { kind: 'card' } })).toThrow();
    expect(() => workspaceNavigationIntentSchema.parse({ intent: 'navigate_workspace' })).toThrow();
  });

  it('rejects extra intent and nested target properties', () => {
    expect(() => workspaceNavigationIntentSchema.parse({ intent: 'navigate_back', target: { kind: 'card' } })).toThrow();
    expect(() => workspaceNavigationTargetSchema.parse({ kind: 'config', extra: true })).toThrow();
  });
});
