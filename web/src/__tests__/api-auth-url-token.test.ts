import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthToken, getAuthToken, setAuthToken } from '../api/auth';

describe('API auth URL token handling', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/?token=arch004-test-token');
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('ignores URL query tokens and never persists them', () => {
    expect(getAuthToken()).not.toBe('arch004-test-token');
    expect(getAuthToken()).toBeNull();
    expect(localStorage.getItem('saivage_api_token')).toBeNull();
  });

  it('still returns manually stored localStorage tokens', () => {
    setAuthToken('arch004-stored-token');
    expect(getAuthToken()).toBe('arch004-stored-token');
    clearAuthToken();
    expect(getAuthToken()).toBeNull();
  });
});
