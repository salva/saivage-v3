import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { diaryEntrySchema, reviewAssessmentSchema } from '../schemas/validators.js';
import type { DiaryEntry, DiaryKind, ReviewAssessment } from '../schemas/types.js';
import { writeFileAtomic } from './file-tree.js';

// ── Index Types ───────────────────────────────────────────────

interface DiaryIndexEntry {
  id: string;
  kind: DiaryKind;
  timestamp: string;
  filename: string;
}

interface DiaryIndex {
  sequence: number;
  entries: DiaryIndexEntry[];
}

interface ReviewsByGoalIndex {
  reviews: Array<{
    id: string;
    result: 'pass' | 'fail';
    timestamp: string;
    plan_card_id: string;
    diary_entry_id: string;
  }>;
}

// ── Path Helpers ──────────────────────────────────────────────

function diaryDir(saivageDir: string, planCardId: string): string {
  return join(saivageDir, 'diaries', `plan-${planCardId}`);
}

function indexFilePath(saivageDir: string, planCardId: string): string {
  return join(diaryDir(saivageDir, planCardId), 'index.json');
}

function reviewIndexPath(saivageDir: string, goalCardId: string): string {
  return join(saivageDir, 'reviews', 'by-goal', `${goalCardId}.json`);
}

// ── Index I/O Helpers ─────────────────────────────────────────

function readDiaryIndex(saivageDir: string, planCardId: string): DiaryIndex {
  const path = indexFilePath(saivageDir, planCardId);
  if (!existsSync(path)) {
    return { sequence: 0, entries: [] };
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as DiaryIndex;
  // Defensive: ensure fields exist
  return {
    sequence: typeof parsed.sequence === 'number' ? parsed.sequence : 0,
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
  };
}

function writeDiaryIndexAtomic(saivageDir: string, planCardId: string, index: DiaryIndex): void {
  writeFileAtomic(indexFilePath(saivageDir, planCardId), JSON.stringify(index, null, 2) + '\n');
}

function readReviewIndex(saivageDir: string, goalCardId: string): ReviewsByGoalIndex {
  const path = reviewIndexPath(saivageDir, goalCardId);
  if (!existsSync(path)) {
    return { reviews: [] };
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as ReviewsByGoalIndex;
  return {
    reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
  };
}

function writeReviewIndexAtomic(
  saivageDir: string,
  goalCardId: string,
  index: ReviewsByGoalIndex,
): void {
  writeFileAtomic(reviewIndexPath(saivageDir, goalCardId), JSON.stringify(index, null, 2) + '\n');
}

// ── Filename Helpers ──────────────────────────────────────────

function paddedSequence(seq: number): string {
  return String(seq).padStart(6, '0');
}

function entryFilename(seq: number, kind: DiaryKind): string {
  return `${paddedSequence(seq)}.${kind}.json`;
}

function entryFilePath(
  saivageDir: string,
  planCardId: string,
  seq: number,
  kind: DiaryKind,
): string {
  return join(diaryDir(saivageDir, planCardId), entryFilename(seq, kind));
}

// ── Public API ────────────────────────────────────────────────

/**
 * Initialize a diary for a plan card.
 * Creates the diary directory and initial index.json.
 * Idempotent: if index.json already exists, does nothing.
 * Called when a plan card is first created.
 */
export function initDiary(saivageDir: string, planCardId: string): void {
  const path = indexFilePath(saivageDir, planCardId);
  if (existsSync(path)) {
    return; // Already initialized
  }
  // writeFileAtomic creates parent directories as needed
  writeDiaryIndexAtomic(saivageDir, planCardId, { sequence: 0, entries: [] });
}

/**
 * Delete a diary for a plan card (when the plan card is deleted).
 * Removes the entire diary directory.
 * Silently succeeds if diary directory doesn't exist.
 */
export function deleteDiary(saivageDir: string, planCardId: string): void {
  const dir = diaryDir(saivageDir, planCardId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Append a diary entry to a plan card's diary.
 * Auto-generates sequential filename: {padded_seq}.{kind}.json
 * Validates with diaryEntrySchema before writing.
 * Updates the index.json sequence counter.
 * Returns the created DiaryEntry with all fields populated.
 */
export function appendDiaryEntry(
  saivageDir: string,
  entry: Omit<DiaryEntry, 'id' | 'timestamp'> & { id?: string },
): DiaryEntry {
  const index = readDiaryIndex(saivageDir, entry.plan_card_id);
  const newSeq = index.sequence + 1;

  // Generate ID: use provided or auto-generate
  const entryId = entry.id ?? `entry-${newSeq}`;
  const timestamp = new Date().toISOString();
  const filename = entryFilename(newSeq, entry.kind);

  const fullEntry: DiaryEntry = {
    id: entryId,
    plan_card_id: entry.plan_card_id,
    invocation_id: entry.invocation_id,
    kind: entry.kind,
    timestamp,
    ...(entry.input_summary !== undefined ? { input_summary: entry.input_summary } : {}),
    ...(entry.decision !== undefined ? { decision: entry.decision } : {}),
    ...(entry.rationale !== undefined ? { rationale: entry.rationale } : {}),
    ...(entry.created_cards !== undefined ? { created_cards: entry.created_cards } : {}),
    ...(entry.updated_cards !== undefined ? { updated_cards: entry.updated_cards } : {}),
    ...(entry.reviewed_cards !== undefined ? { reviewed_cards: entry.reviewed_cards } : {}),
    ...(entry.assessment !== undefined ? { assessment: entry.assessment } : {}),
    ...(entry.raw !== undefined ? { raw: entry.raw } : {}),
  };

  // Validate with Zod
  diaryEntrySchema.parse(fullEntry);

  // Write the entry file
  writeFileAtomic(
    entryFilePath(saivageDir, entry.plan_card_id, newSeq, entry.kind),
    JSON.stringify(fullEntry, null, 2) + '\n',
  );

  // Update index
  index.sequence = newSeq;
  index.entries.push({
    id: fullEntry.id,
    kind: fullEntry.kind,
    timestamp: fullEntry.timestamp,
    filename,
  });
  writeDiaryIndexAtomic(saivageDir, entry.plan_card_id, index);

  return fullEntry;
}

/**
 * Get all diary entries for a plan card, in order.
 * Returns empty array if the diary directory doesn't exist.
 */
export function getDiaryEntries(saivageDir: string, planCardId: string): DiaryEntry[] {
  const index = readDiaryIndex(saivageDir, planCardId);
  const entries: DiaryEntry[] = [];

  for (const idxEntry of index.entries) {
    const path = join(diaryDir(saivageDir, planCardId), idxEntry.filename);
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as DiaryEntry;
      // Validate on read
      entries.push(diaryEntrySchema.parse(parsed));
    }
  }

  return entries;
}

/**
 * Get a specific diary entry by plan card ID and entry ID.
 * Returns null if not found.
 */
export function getDiaryEntry(
  saivageDir: string,
  planCardId: string,
  entryId: string,
): DiaryEntry | null {
  const index = readDiaryIndex(saivageDir, planCardId);
  const idxEntry = index.entries.find((e) => e.id === entryId);

  if (!idxEntry) {
    return null;
  }

  const path = join(diaryDir(saivageDir, planCardId), idxEntry.filename);
  if (!existsSync(path)) {
    return null;
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as DiaryEntry;
  return diaryEntrySchema.parse(parsed);
}

/**
 * Convenience: append a review assessment as a diary entry.
 * Creates a DiaryEntry with kind='review_assessment' and the assessment embedded.
 * Also updates the reviews index at reviews/by-goal/{goalCardId}.json.
 * Returns the created DiaryEntry and ReviewAssessment.
 */
export function appendReviewAssessment(
  saivageDir: string,
  assessment: Omit<ReviewAssessment, 'id' | 'created_at'> & { id?: string },
): { entry: DiaryEntry; assessment: ReviewAssessment } {
  const now = new Date().toISOString();

  // Determine review assessment ID
  const reviewIndex = readReviewIndex(saivageDir, assessment.goal_card_id);
  const revSeq = reviewIndex.reviews.length + 1;
  const assessmentId = assessment.id ?? `rev-${revSeq}`;

  const fullAssessment: ReviewAssessment = {
    id: assessmentId,
    goal_card_id: assessment.goal_card_id,
    plan_card_id: assessment.plan_card_id,
    reviewer_session_id: assessment.reviewer_session_id,
    result: assessment.result,
    summary: assessment.summary,
    achieved: assessment.achieved,
    missing: assessment.missing,
    evidence_card_ids: assessment.evidence_card_ids,
    created_at: now,
  };

  // Validate assessment
  reviewAssessmentSchema.parse(fullAssessment);

  // Append the diary entry with the assessment embedded.
  // Use the reviewer_session_id as the invocation_id for the diary entry,
  // since review assessments are session-scoped.
  const entry = appendDiaryEntry(saivageDir, {
    plan_card_id: assessment.plan_card_id,
    invocation_id: assessment.reviewer_session_id,
    kind: 'review_assessment',
    assessment: fullAssessment,
    input_summary: `Review assessment: ${assessment.result === 'pass' ? 'passed' : 'failed'} - ${assessment.summary}`,
    reviewed_cards: assessment.evidence_card_ids,
  });

  // Update the reviews index
  reviewIndex.reviews.push({
    id: fullAssessment.id,
    result: fullAssessment.result,
    timestamp: now,
    plan_card_id: assessment.plan_card_id,
    diary_entry_id: entry.id,
  });
  writeReviewIndexAtomic(saivageDir, assessment.goal_card_id, reviewIndex);

  return { entry, assessment: fullAssessment };
}

/**
 * Get all review assessments for a goal from the reviews index.
 * Returns empty array if none exist.
 */
export function getReviewAssessments(saivageDir: string, goalCardId: string): ReviewAssessment[] {
  const reviewIndex = readReviewIndex(saivageDir, goalCardId);
  const assessments: ReviewAssessment[] = [];

  for (const rev of reviewIndex.reviews) {
    // Try to read the full assessment from the diary entry
    const diaryEntry = getDiaryEntry(saivageDir, rev.plan_card_id, rev.diary_entry_id);
    if (diaryEntry?.assessment) {
      assessments.push(diaryEntry.assessment);
    } else {
      // Fallback: construct a minimal assessment from the index entry
      assessments.push({
        id: rev.id,
        goal_card_id: goalCardId,
        plan_card_id: rev.plan_card_id,
        reviewer_session_id: '',
        result: rev.result,
        summary: '',
        achieved: [],
        missing: [],
        evidence_card_ids: [],
        created_at: rev.timestamp,
      });
    }
  }

  return assessments;
}
