import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../persistence/index.js';
import { llmExchangeSchema, type LlmExchange } from '../contracts/index.js';

export class LlmExchangeCorruptedError extends Error {
  override name = 'LlmExchangeCorruptedError';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

export function exchangePath(saivageDir: string, sessionId: string): string {
  return join(saivageDir, 'agents', 'llm-exchanges', `${sessionId}.json`);
}

export async function readLatestLlmExchange(
  saivageDir: string,
  sessionId: string,
): Promise<LlmExchange | null> {
  const p = exchangePath(saivageDir, sessionId);
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new LlmExchangeCorruptedError(`Invalid JSON at ${p}`, cause);
  }
  const result = llmExchangeSchema.safeParse(parsed);
  if (!result.success) {
    throw new LlmExchangeCorruptedError(`Schema validation failed at ${p}`, result.error);
  }
  return result.data;
}

export async function writeLatestLlmExchange(
  saivageDir: string,
  exchange: LlmExchange,
): Promise<void> {
  const validated = llmExchangeSchema.parse(exchange);
  const p = exchangePath(saivageDir, validated.sessionId);
  writeFileAtomic(p, JSON.stringify(validated, null, 2));
}
