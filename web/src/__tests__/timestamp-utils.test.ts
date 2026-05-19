import { describe, expect, it, vi, afterEach } from 'vitest';
import { formatTimestamp, isRecentTimestamp } from '../utils/timestamp';

describe('formatTimestamp', () => {
  afterEach(() => vi.useRealTimers());

  it('formats relative edge cases', () => {
    const now = new Date('2026-05-19T12:00:00Z');
    expect(formatTimestamp('2026-05-19T12:00:00Z', 'relative', { now })).toBe('just now');
    expect(formatTimestamp('2026-05-19T11:55:00Z', 'relative', { now })).toBe('5m ago');
    expect(formatTimestamp('2026-05-18T12:00:00Z', 'relative', { now })).toBe('1d ago');
    expect(formatTimestamp('2026-05-19T12:05:00Z', 'relative', { now })).toBe('5m from now');
  });

  it('formats absolute and timeOnly modes with invalid fallback', () => {
    const date = new Date('2026-05-19T12:34:56Z');
    expect(formatTimestamp(date, 'absolute')).toContain('2026');
    expect(formatTimestamp(date, 'timeOnly')).toMatch(/12:34:56|34:56/);
    expect(formatTimestamp('not-a-date', 'absolute')).toBe('not-a-date');
    expect(formatTimestamp(null, 'absolute')).toBe('—');
  });

  it('detects recent timestamps under seven days', () => {
    const now = new Date('2026-05-19T12:00:00Z');
    expect(isRecentTimestamp('2026-05-13T12:00:01Z', { now })).toBe(true);
    expect(isRecentTimestamp('2026-05-12T12:00:00Z', { now })).toBe(false);
  });
});
