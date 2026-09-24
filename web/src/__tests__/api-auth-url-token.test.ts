import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAuthToken } from '../api/auth';

describe('API auth URL token handling', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/?token=arch004-test-token');
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('ignores URL query tokens and never persists them', () => {
    expect(getAuthToken()).not.toBe('arch004-test-token');
    expect(getAuthToken()).toBeNull();
    expect(localStorage.getItem('saivage_api_token')).toBeNull();
  });

  it('still returns operator-set localStorage tokens for bearer deployments', () => {
    localStorage.setItem('saivage_api_token', 'arch004-stored-token');
    expect(getAuthToken()).toBe('arch004-stored-token');
  });
});
