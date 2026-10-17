import { describe, expect, it, vi, afterEach } from 'vitest';
import { formatRecentTimestamp, formatTimestamp, isRecentTimestamp, timestampTitle } from '../utils/timestamp';

describe('formatTimestamp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('formats relative edge cases', () => {
    const now = new Date('2026-05-19T12:00:00Z');
    expect(formatTimestamp('2026-05-19T12:00:00Z', 'relative', { now })).toBe('just now');
    expect(formatTimestamp('2026-05-19T11:55:00Z', 'relative', { now })).toBe('5m ago');
    expect(formatTimestamp('2026-05-19T10:00:00Z', 'relative', { now })).toBe('2h ago');
    expect(formatTimestamp('2026-05-18T12:00:00Z', 'relative', { now })).toBe('1d ago');
    expect(formatTimestamp('2026-05-19T12:05:00Z', 'relative', { now })).toBe('5m from now');
  });

  it('falls back from relative to absolute for timestamps seven days or older', () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const formatted = formatTimestamp('2026-05-12T12:00:00Z', 'relative', { now });
    expect(formatted).toContain('2026');
    expect(formatted).not.toMatch(/ago|from now|just now/);
  });

  it('formats absolute mode with invalid and empty-input fallbacks', () => {
    const date = new Date('2026-05-19T12:34:56Z');
    expect(formatTimestamp(date, 'absolute')).toContain('2026');
    expect(formatTimestamp('not-a-date', 'absolute')).toBe('not-a-date');
    expect(formatTimestamp(null, 'absolute')).toBe('—');
    expect(formatTimestamp('', 'timeOnly')).toBe('—');
  });

  it.each([
    ['UTC', '12:34:56'],
    ['America/New_York', '08:34:56'],
    ['Asia/Kolkata', '18:04:56'],
    ['Asia/Kathmandu', '18:19:56'],
  ])('formats timeOnly in local timezone %s', (zone, expected) => {
    // Control only rendering locale; the hook restores TZ after each real local-time conversion.
    vi.stubEnv('TZ', zone);
    const date = new Date('2026-05-19T12:34:56Z');
    const nativeToLocaleTimeString = date.toLocaleTimeString;
    const timeString = vi.spyOn(date, 'toLocaleTimeString').mockImplementation((_locales, options) =>
      nativeToLocaleTimeString.call(date, 'en-GB', options),
    );

    expect(formatTimestamp(date, 'timeOnly')).toBe(expected);
    expect(timeString).toHaveBeenCalledTimes(1);
    expect(timeString).toHaveBeenCalledWith([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  });

  it('detects recent timestamps under seven days', () => {
    const now = new Date('2026-05-19T12:00:00Z');
    expect(isRecentTimestamp('2026-05-13T12:00:01Z', { now })).toBe(true);
    expect(isRecentTimestamp('2026-05-12T12:00:00Z', { now })).toBe(false);
    expect(isRecentTimestamp('2026-05-19T12:00:01Z', { now })).toBe(false);
    expect(isRecentTimestamp('not-a-date', { now })).toBe(false);
  });

  it('formats only recent past timestamps relatively with a fixed now', () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const old = '2026-05-12T12:00:00Z';
    const future = '2026-05-19T12:05:00Z';

    expect(formatRecentTimestamp('2026-05-19T11:55:00Z', { now })).toBe('5m ago');
    expect(formatRecentTimestamp(old, { now })).toBe(formatTimestamp(old, 'absolute', { now }));
    expect(formatRecentTimestamp(future, { now })).toBe(formatTimestamp(future, 'absolute', { now }));
    expect(formatRecentTimestamp('not-a-date', { now })).toBe('not-a-date');
  });

  it('uses the shared absolute formatter for timestamp titles', () => {
    const value = '2026-05-19T12:34:56Z';
    expect(timestampTitle(value)).toBe(formatTimestamp(value, 'absolute'));
  });
});
