// F13 r5 §"Boot recovery" + §"On-disk write sequence" — durable commit-marker
// shape, paths, and atomic I/O. Markers live at .saivage/cards/.commit/<token>.json.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileSyncDurable } from '../persistence/index.js';
import type { CardHistoryEntry } from '../schemas/index.js';

export type CommitMarkerByIdPlan =
  | { kind: 'rename'; tmp_path: string; final_path: string }
  | { kind: 'unlink'; unlink_path: string };

export interface CommitMarkerHistory {
  jsonl_path: string;
  entry: CardHistoryEntry;
  entry_id: string;
}

export interface CommitMarkerGroupRef {
  group_token: string;
  index: number;
  total: number;
}

export interface CommitMarker {
  token: string;
  card_id: string;
  by_id: CommitMarkerByIdPlan;
  history: CommitMarkerHistory | null;
  group?: CommitMarkerGroupRef;
}

/**
 * Non-authoritative breadcrumb for an in-progress mutation group. Boot recovery
 * replays per-card markers independently; this marker does not provide group
 * atomicity, and `per_card_tokens` is intentionally empty in current writes.
 */
export interface GroupCommitMarker {
  group_token: string;
  total: number;
  per_card_tokens: string[];
}

export function commitMarkerDir(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'cards', '.commit');
}

export function commitMarkerPath(projectRoot: string, token: string): string {
  return join(commitMarkerDir(projectRoot), `${token}.json`);
}

export function groupCommitMarkerPath(projectRoot: string, groupToken: string): string {
  return join(commitMarkerDir(projectRoot), `group-${groupToken}.json`);
}

function fsyncDir(dirPath: string): void {
  try {
    const fd = openSync(dirPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Best-effort directory fsync; not all platforms permit opening a directory.
  }
}

export function writeCommitMarker(projectRoot: string, marker: CommitMarker): void {
  const path = commitMarkerPath(projectRoot, marker.token);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSyncDurable(path, JSON.stringify(marker, null, 2) + '\n');
  fsyncDir(commitMarkerDir(projectRoot));
}

export function writeGroupCommitMarker(projectRoot: string, marker: GroupCommitMarker): void {
  const path = groupCommitMarkerPath(projectRoot, marker.group_token);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSyncDurable(path, JSON.stringify(marker, null, 2) + '\n');
  fsyncDir(commitMarkerDir(projectRoot));
}

export function readCommitMarkerFile(path: string): CommitMarker | GroupCommitMarker {
  return JSON.parse(readFileSync(path, 'utf-8')) as CommitMarker | GroupCommitMarker;
}

export function unlinkCommitMarker(projectRoot: string, token: string): void {
  const path = commitMarkerPath(projectRoot, token);
  if (existsSync(path)) unlinkSync(path);
  fsyncDir(commitMarkerDir(projectRoot));
}

export function unlinkGroupCommitMarker(projectRoot: string, groupToken: string): void {
  const path = groupCommitMarkerPath(projectRoot, groupToken);
  if (existsSync(path)) unlinkSync(path);
  fsyncDir(commitMarkerDir(projectRoot));
}

export function listCommitMarkerFiles(projectRoot: string): string[] {
  const dir = commitMarkerDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => join(dir, n));
}

export function isGroupMarkerFile(filePath: string): boolean {
  return /\/group-[^/]+\.json$/.test(filePath);
}
