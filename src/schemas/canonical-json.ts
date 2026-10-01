import { sha256Hex } from './sha256.js';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function canonicalValueSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}
