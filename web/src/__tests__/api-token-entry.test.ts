import { describe, expect, it } from 'vitest';
import tokenEntrySource from '../components/auth/ApiTokenEntry.vue?raw';
import navRailSource from '../components/nav/NavRail.vue?raw';

describe('bounded API token bootstrap UI', () => {
  it('retains only auth-token bootstrap controls in the shell navigation', () => {
    expect(navRailSource).toContain("$emit('open-token')");
    expect(navRailSource).toContain('Manage API token for API and WebSocket access');
    expect(navRailSource).toContain('Open public docs');

    expect(navRailSource).not.toMatch(/provider|model|routing|runtime setting|start project|stop project/i);
  });

  it('allows saving and clearing the local API token without exposing operator mutations', () => {
    expect(tokenEntrySource).toContain('authStore.saveToken(trimmed)');
    expect(tokenEntrySource).toContain('authStore.clearToken()');
    expect(tokenEntrySource).toContain('placeholder="64-char hex token"');
    expect(tokenEntrySource).toContain('@submit.prevent="saveToken"');

    expect(tokenEntrySource).not.toMatch(/createCard|updateCard|deleteCard|startProject|provider secret|role routing/i);
  });
});
