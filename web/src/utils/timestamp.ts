export type TimestampMode = 'absolute' | 'relative' | 'timeOnly';

export interface TimestampFormatOptions {
  now?: Date | number | string;
}

function parseDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function absoluteFormat(date: Date): string {
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function isRecentTimestamp(value: string | number | Date | null | undefined, options: TimestampFormatOptions = {}): boolean {
  const date = parseDate(value);
  if (!date) return false;
  const now = parseDate(options.now ?? new Date()) ?? new Date();
  const diff = now.getTime() - date.getTime();
  return diff >= 0 && diff < 7 * 24 * 60 * 60 * 1000;
}

export function formatTimestamp(
  value: string | number | Date | null | undefined,
  mode: TimestampMode = 'absolute',
  options: TimestampFormatOptions = {},
): string {
  const date = parseDate(value);
  if (!date) return value == null || value === '' ? '—' : String(value);

  if (mode === 'timeOnly') {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  if (mode === 'relative') {
    const now = parseDate(options.now ?? new Date()) ?? new Date();
    const diff = now.getTime() - date.getTime();
    const absDiff = Math.abs(diff);
    if (absDiff < 30_000) return 'just now';
    const suffix = diff >= 0 ? 'ago' : 'from now';
    const minutes = Math.round(absDiff / 60_000);
    if (minutes < 60) return `${minutes}m ${suffix}`;
    const hours = Math.round(absDiff / 3_600_000);
    if (hours < 24) return `${hours}h ${suffix}`;
    const days = Math.round(absDiff / 86_400_000);
    if (days < 7) return `${days}d ${suffix}`;
    return absoluteFormat(date);
  }

  return absoluteFormat(date);
}

export function timestampTitle(value: string | number | Date | null | undefined): string {
  return formatTimestamp(value, 'absolute');
}
