import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { saivageCardsRoot } from '../../persistence/layout.js';

export interface ParsedConversationSessionId {
  readonly sessionId: string;
  readonly role: 'planner' | 'executor' | 'reviewer' | 'analyst';
  readonly cardId: string | null;
  readonly assessmentId: string | null;
}

export interface ConversationInventory {
  readonly sessionId: string;
  readonly versions: readonly number[];
  readonly activeVersion: number;
}

export type ConversationVersionReplacement = {
  sessionId: string;
  activeVersion: number;
  compactedThrough: { message_id: string; round_id: string; timestamp: string };
  compactionGeneration: number;
};

const CARD_ID = '(?:project|card-[1-9][0-9]*)';
const PLANNER_OR_EXECUTOR = new RegExp(`^(planner|executor):(${CARD_ID})$`, 'u');
const REVIEWER = new RegExp(`^reviewer:(${CARD_ID}):(assessment-(${CARD_ID})-1)$`, 'u');
const ANALYST = /^analyst:(global|telegram-(?:0|-?[1-9][0-9]*))$/u;

export function parseConversationSessionId(sessionId: string): ParsedConversationSessionId {
  const worker = PLANNER_OR_EXECUTOR.exec(sessionId);
  if (worker) return Object.freeze({ sessionId, role: worker[1] as 'planner' | 'executor', cardId: worker[2]!, assessmentId: null });
  const reviewer = REVIEWER.exec(sessionId);
  if (reviewer) {
    if (reviewer[1] !== reviewer[3]) throw new Error(`Reviewer session '${sessionId}' embeds mismatched card ids.`);
    return Object.freeze({ sessionId, role: 'reviewer', cardId: reviewer[1]!, assessmentId: reviewer[2]! });
  }
  if (ANALYST.test(sessionId)) return Object.freeze({ sessionId, role: 'analyst', cardId: null, assessmentId: null });
  throw new Error(`Conversation session id '${sessionId}' is outside the canonical durable grammar.`);
}

export function conversationDir(projectRoot: string, sessionId: string): string {
  const parsed = parseConversationSessionId(sessionId);
  const encoded = encodeURIComponent(sessionId);
  return parsed.cardId === null
    ? join(projectRoot, '.saivage', 'agents', 'conversations', encoded)
    : join(saivageCardsRoot(projectRoot), parsed.cardId, 'conversations', encoded);
}

export function activeVersionPath(projectRoot: string, sessionId: string, version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error(`Conversation version '${version}' is invalid.`);
  return join(conversationDir(projectRoot, sessionId), `${version}.jsonl`);
}

export function versionExists(projectRoot: string, sessionId: string, version: number): boolean {
  return existsSync(activeVersionPath(projectRoot, sessionId, version));
}

export function readConversationInventory(projectRoot: string, sessionId: string): ConversationInventory | null {
  const directory = conversationDir(projectRoot, sessionId);
  if (!existsSync(directory)) return null;
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error(`Conversation session is not a real directory: '${directory}'.`);
  const versions: number[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error(`Conversation entry has an invalid type: '${path}'.`);
    if (entry.name === 'summaries.jsonl' && entry.isFile()) continue;
    const match = /^([1-9][0-9]*)\.jsonl$/u.exec(entry.name);
    if (!match || !entry.isFile()) throw new Error(`Unknown conversation entry: '${path}'.`);
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version)) throw new Error(`Conversation version name exceeds the safe integer range: '${path}'.`);
    versions.push(version);
  }
  versions.sort((a, b) => a - b);
  if (versions.length === 0) throw new Error(`Conversation '${sessionId}' has no published versions.`);
  versions.forEach((version, index) => { if (version !== index + 1) throw new Error(`Conversation '${sessionId}' has a version gap at ${index + 1}.`); });
  return Object.freeze({ sessionId, versions: Object.freeze(versions), activeVersion: versions.at(-1)! });
}
