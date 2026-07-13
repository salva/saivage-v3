/**
 * Content review logging.
 *
 * Blocked content is never persisted by this module. Supervision writes a
 * sanitized content_review entry to the app log and returns a summary that can
 * be shown to an agent or operator in place of the blocked payload.
 */

import { randomBytes } from 'node:crypto';
import { readAppLogEntries, type AppLogStore } from '../persistence/app-log.js';
import type { MutationAuthority } from '../application/mutation-authority.js';
import { contentReviewSchema } from '../schemas/index.js';
import type { ContentReview, RiskLevel, SourceKind } from '../schemas/index.js';

function generateId(): string {
  return randomBytes(12).toString('hex');
}

function parseContentReview(data: unknown): ContentReview | null {
  const parsed = contentReviewSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export interface BlockedContentReviewResult {
  review: ContentReview;
  sanitizedSummary: string;
}

export function quarantineContent(params: {
  projectRoot: string;
  sourceKind: SourceKind;
  sourceRef: string;
  content: string;
  reason: string;
  risk: RiskLevel;
  appLogs: AppLogStore;
  mutationAuthority: MutationAuthority;
}): BlockedContentReviewResult {
  const { projectRoot, sourceKind, sourceRef, reason, risk } = params;
  const now = new Date().toISOString();
  const review: ContentReview = {
    id: `blocked-${generateId()}`,
    source_kind: sourceKind,
    source_ref: sourceRef,
    status: 'blocked',
    summary: `Blocked: ${reason}`,
    risk,
    created_at: now,
  };

  const parsedReview = contentReviewSchema.parse(review);
  params.appLogs.append(params.mutationAuthority, { id: parsedReview.id, timestamp: now, type: 'content_review', data: parsedReview });

  return {
    review: parsedReview,
    sanitizedSummary: `Content from [${sourceRef}] was blocked by the content supervisor (reason: ${reason}). The original content was not stored.`,
  };
}

export function recordContentPass(
  appLogs: AppLogStore,
  mutationAuthority: MutationAuthority,
  sourceKind: SourceKind,
  sourceRef: string,
  summary: string,
  risk: RiskLevel = 'low',
): ContentReview {
  const now = new Date().toISOString();
  const review: ContentReview = {
    id: `rev-${generateId()}`,
    source_kind: sourceKind,
    source_ref: sourceRef,
    status: 'passed',
    summary,
    risk,
    created_at: now,
  };

  const parsedReview = contentReviewSchema.parse(review);
  appLogs.append(mutationAuthority, { id: parsedReview.id, timestamp: now, type: 'content_review', data: parsedReview });
  return parsedReview;
}

export function listRecentReviews(projectRoot: string, limit = 50): ContentReview[] {
  const reviews = readAppLogEntries(projectRoot, 'content_review')
    .map((entry) => parseContentReview(entry.data))
    .filter((review): review is ContentReview => review !== null);

  return reviews.slice(-limit).reverse();
}
