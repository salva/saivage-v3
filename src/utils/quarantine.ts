/**
 * Quarantine Storage & Content Review Tracking
 *
 * When content is flagged as injection, the original content is stored
 * under .saivage-work/quarantine/<id>/ and a ContentReview record is
 * appended to .saivage/supervision/reviews.jsonl. The quarantine index
 * at .saivage/supervision/quarantine-index.json maintains fast lookups.
 *
 * See 05-security.md and 09-data-model.md for the spec.
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  contentReviewSchema,
  quarantineItemSchema,
} from '../schemas/validators.js';
import type {
  ContentReview,
  QuarantineItem,
  SourceKind,
  RiskLevel,
} from '../schemas/types.js';
import { writeFileAtomic } from './file-tree.js';

// ── Path Helpers ──────────────────────────────────────────────

function supervisionDir(saivageDir: string): string {
  return join(saivageDir, 'supervision');
}

function reviewsJsonlPath(saivageDir: string): string {
  return join(supervisionDir(saivageDir), 'reviews.jsonl');
}

function quarantineIndexPath(saivageDir: string): string {
  return join(supervisionDir(saivageDir), 'quarantine-index.json');
}

function quarantineDir(saivageWorkDir: string, id: string): string {
  return join(saivageWorkDir, 'quarantine', id);
}

function quarantineMetaPath(saivageWorkDir: string, id: string): string {
  return join(quarantineDir(saivageWorkDir, id), 'meta.json');
}

function quarantineRawPath(saivageWorkDir: string, id: string): string {
  return join(quarantineDir(saivageWorkDir, id), 'raw.bin');
}

// ── ID Generation ─────────────────────────────────────────────

function generateId(): string {
  return randomBytes(12).toString('hex'); // 24-char hex
}

// ── JSONL Append Helpers ──────────────────────────────────────

/**
 * Append a line to a JSONL file. Creates parent directories and
 * the file itself if they don't exist. Uses atomic write for the
 * whole file (read → append line → write temp → rename).
 *
 * For append-heavy use cases this can become expensive at scale,
 * but for supervision (low volume) it's safe and correct.
 */
function appendJsonl(path: string, line: string): void {
  let existing = '';
  if (existsSync(path)) {
    existing = readFileSync(path, 'utf-8');
  }
  // Ensure trailing newline before appending
  const content = existing.endsWith('\n') || existing.length === 0
    ? existing + line + '\n'
    : existing + '\n' + line + '\n';
  writeFileAtomic(path, content);
}

// ── Quarantine Index Helpers ──────────────────────────────────

interface QuarantineIndexEntry {
  quarantine_id: string;
  review_id: string;
  source_ref: string;
  risk: RiskLevel;
  created_at: string;
}

function readQuarantineIndex(saivageDir: string): QuarantineIndexEntry[] {
  const path = quarantineIndexPath(saivageDir);
  if (!existsSync(path)) {
    return [];
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed as QuarantineIndexEntry[];
}

function writeQuarantineIndex(saivageDir: string, index: QuarantineIndexEntry[]): void {
  writeFileAtomic(
    quarantineIndexPath(saivageDir),
    JSON.stringify(index, null, 2) + '\n',
  );
}

// ── Public API ────────────────────────────────────────────────

/**
 * Result from quarantining content.
 */
export interface QuarantineResult {
  review: ContentReview;
  quarantine: QuarantineItem;
  sanitizedSummary: string;
}

/**
 * Quarantine blocked content.
 *
 * Stores the raw content under .saivage-work/quarantine/<id>/raw.bin,
 * writes QuarantineItem metadata to meta.json, creates a ContentReview
 * with status='blocked', appends to reviews.jsonl, and updates the
 * quarantine index.
 *
 * @returns The review, quarantine item, and a sanitized summary string
 *          suitable for passing to the agent in place of the blocked content.
 */
export function quarantineContent(params: {
  saivageDir: string;
  saivageWorkDir: string;
  sourceKind: SourceKind;
  sourceRef: string;
  content: string;
  reason: string;
  risk: RiskLevel;
}): QuarantineResult {
  const { saivageDir, saivageWorkDir, sourceKind, sourceRef, content, reason, risk } = params;

  const now = new Date().toISOString();
  const quarantineId = generateId();
  const reviewId = `rev-${generateId()}`;

  // Ensure quarantine and supervision directories exist
  const qDir = quarantineDir(saivageWorkDir, quarantineId);
  mkdirSync(qDir, { recursive: true });
  mkdirSync(supervisionDir(saivageDir), { recursive: true });

  // Write raw content
  writeFileAtomic(quarantineRawPath(saivageWorkDir, quarantineId), content);

  // Build QuarantineItem
  const storedPath = quarantineDir(saivageWorkDir, quarantineId);
  const quarantine: QuarantineItem = {
    id: quarantineId,
    review_id: reviewId,
    source_ref: sourceRef,
    stored_path: storedPath,
    reason,
    created_at: now,
  };
  quarantineItemSchema.parse(quarantine);

  // Write quarantine meta.json
  writeFileAtomic(
    quarantineMetaPath(saivageWorkDir, quarantineId),
    JSON.stringify(quarantine, null, 2) + '\n',
  );

  // Build ContentReview
  const review: ContentReview = {
    id: reviewId,
    source_kind: sourceKind,
    source_ref: sourceRef,
    status: 'blocked',
    summary: `Blocked: ${reason}`,
    risk,
    quarantine_id: quarantineId,
    created_at: now,
  };
  contentReviewSchema.parse(review);

  // Append to reviews.jsonl
  appendJsonl(reviewsJsonlPath(saivageDir), JSON.stringify(review));

  // Update quarantine index
  const index = readQuarantineIndex(saivageDir);
  index.push({
    quarantine_id: quarantineId,
    review_id: reviewId,
    source_ref: sourceRef,
    risk,
    created_at: now,
  });
  writeQuarantineIndex(saivageDir, index);

  // Build sanitized summary for the agent
  const sanitizedSummary =
    `Content from [${sourceRef}] was blocked by the content supervisor (reason: ${reason}). The original has been quarantined.`;

  return { review, quarantine, sanitizedSummary };
}

/**
 * Record a content pass (content that was scanned and allowed).
 *
 * Creates a ContentReview with status='passed', appends it to
 * reviews.jsonl. Does NOT create any quarantine files.
 *
 * @returns The created ContentReview.
 */
export function recordContentPass(
  saivageDir: string,
  sourceKind: SourceKind,
  sourceRef: string,
  summary: string,
  risk: RiskLevel = 'low',
): ContentReview {
  const now = new Date().toISOString();
  const reviewId = `rev-${generateId()}`;

  mkdirSync(supervisionDir(saivageDir), { recursive: true });

  const review: ContentReview = {
    id: reviewId,
    source_kind: sourceKind,
    source_ref: sourceRef,
    status: 'passed',
    summary,
    risk,
    created_at: now,
  };
  contentReviewSchema.parse(review);

  appendJsonl(reviewsJsonlPath(saivageDir), JSON.stringify(review));

  return review;
}

/**
 * Get a QuarantineItem by its ID.
 *
 * Reads the meta.json from .saivage-work/quarantine/<id>/meta.json.
 * Returns null if the quarantine item doesn't exist.
 */
export function getQuarantineItem(
  saivageWorkDir: string,
  quarantineId: string,
): QuarantineItem | null {
  const metaPath = quarantineMetaPath(saivageWorkDir, quarantineId);
  if (!existsSync(metaPath)) {
    return null;
  }
  try {
    const raw = readFileSync(metaPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return quarantineItemSchema.parse(parsed);
  } catch {
    return null;
  }
}

/**
 * List the most recent ContentReview records from reviews.jsonl.
 *
 * Reads the JSONL file line by line (most recent last), returns
 * up to `limit` entries in reverse chronological order.
 *
 * @param saivageDir - Path to .saivage/
 * @param limit - Maximum number of entries to return (default: 50)
 * @returns Array of ContentReview records, newest first.
 */
export function listRecentReviews(
  saivageDir: string,
  limit: number = 50,
): ContentReview[] {
  const path = reviewsJsonlPath(saivageDir);
  if (!existsSync(path)) {
    return [];
  }

  const raw = readFileSync(path, 'utf-8');
  const lines = raw.trim().split('\n').filter(Boolean);

  // Take the last `limit` lines, reverse for newest-first
  const recent = lines.slice(-limit).reverse();

  const reviews: ContentReview[] = [];
  for (const line of recent) {
    try {
      const parsed = JSON.parse(line);
      reviews.push(contentReviewSchema.parse(parsed));
    } catch {
      // Skip malformed lines
    }
  }

  return reviews;
}

/**
 * Read the raw quarantined content.
 *
 * Reads raw.bin from .saivage-work/quarantine/<id>/raw.bin.
 * Returns null if the quarantine item doesn't exist.
 */
export function readQuarantineContent(
  saivageWorkDir: string,
  quarantineId: string,
): string | null {
  const rawPath = quarantineRawPath(saivageWorkDir, quarantineId);
  if (!existsSync(rawPath)) {
    return null;
  }
  try {
    return readFileSync(rawPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Get all quarantine index entries.
 *
 * Reads .saivage/supervision/quarantine-index.json.
 * Returns an empty array if the file doesn't exist.
 */
export function listQuarantineIndex(
  saivageDir: string,
): QuarantineIndexEntry[] {
  return readQuarantineIndex(saivageDir);
}
