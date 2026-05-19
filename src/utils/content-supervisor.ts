/**
 * Content Supervisor — The orchestration layer
 *
 * Coordinates the two-layer prompt injection scanner (heuristic → LLM)
 * and quarantine flow. Screens external content before it enters an
 * agent context.
 *
 * See docs/design/security.md § "Content Supervisor" for the spec.
 */

import type { EventEmitter } from 'node:events';
import type { SourceKind } from '../schemas/types.js';
import type { ContentReview, QuarantineItem } from '../schemas/types.js';
import { scanContent, isInjectionSuspicious } from './heuristic-scanner.js';
import type { ScanResult, SensitivityLevel } from './heuristic-scanner.js';
import { scanWithLLM } from './llm-scanner.js';
import type { LlmVerdict } from './llm-scanner.js';
import { quarantineContent, recordContentPass } from './quarantine.js';

// ── Types ─────────────────────────────────────────────────────

/** Configuration for the ContentSupervisor. */
export interface ContentSupervisorConfig {
  /** Whether injection scanning is enabled. */
  enabled: boolean;
  /** Model identifier for the Layer 2 LLM scan. */
  injectionModel?: string;
  /** Maximum bytes of content to send to the LLM scanner. */
  maxScanLengthBytes: number;
  /** Sensitivity level for the heuristic scanner. */
  sensitivity?: SensitivityLevel;
  /** Path to the .saivage directory (for supervision storage). */
  saivageDir: string;
  /** Path to the .saivage-work directory (for quarantine storage). */
  saivageWorkDir: string;
  /**
   * Optional LLM call function.
   *
   * In production this is wired to the agent adapter's model
   * invocation machinery. In tests a mock is provided.
   */
  makeLlmCall?: (
    model: string,
    systemPrompt: string,
    userContent: string,
  ) => Promise<string>;
  /** Optional event bus for publishing supervisor events. */
  eventBus?: EventEmitter;
}

/** Result from a `screenContent` call. */
export interface ScreenContentResult {
  /** Final screening status. */
  status: 'passed' | 'blocked' | 'sanitized';
  /** Human-readable summary of the screening result. */
  summary: string;
  /** The ContentReview record if one was created. */
  review?: ContentReview;
  /** The QuarantineItem record if content was quarantined. */
  quarantine?: QuarantineItem;
}

// ── Source Kinds That Should Be Screened ────────────────────

/**
 * Source kinds that contain external content and must be screened.
 *
 * Per docs/design/security.md:
 *  - command_output: command output from processes
 *  - file: file reads
 *  - download: content from download_file
 *  - web: web search results and fetched pages
 *  - api: API responses
 *  - tool: MCP tool responses and other tool results
 */
const SCREENABLE_SOURCE_KINDS: ReadonlySet<SourceKind> = new Set([
  'command_output',
  'file',
  'download',
  'web',
  'api',
  'tool',
]);

/** Minimum confidence threshold for LLM verdicts. Below this, content is blocked regardless of safe flag. */
const MIN_CONFIDENCE_THRESHOLD = 0.3;

// ── ContentSupervisor ─────────────────────────────────────────

export class ContentSupervisor {
  private config: ContentSupervisorConfig;

  constructor(config: ContentSupervisorConfig) {
    this.config = {
      sensitivity: 'medium',
      ...config,
    };
  }

  /**
   * Screen external content before it enters an agent context.
   *
   * Flow:
   *  1. If disabled → return passed immediately
   *  2. Run heuristic scan at configured sensitivity
   *  3. If NOT flagged → record pass, return passed
   *  4. If flagged but NOT suspicious (risk=low) → record pass, return passed
   *  5. If suspicious → escalate to LLM scan
   *  6. If LLM fails → quarantine (conservative), return blocked
   *  7. If LLM confidence < 0.3 → quarantine (conservative), return blocked
   *  8. If LLM says safe → record pass, return passed
   *  9. If LLM says unsafe → quarantine, return blocked
   *
   * @param params.sourceKind - The kind of content source.
   * @param params.sourceRef  - A reference string identifying the source.
   * @param params.content    - The content to screen.
   * @returns A `ScreenContentResult` with status, summary, and optionally
   *          the review and quarantine records.
   */
  async screenContent(params: {
    sourceKind: SourceKind;
    sourceRef: string;
    content: string;
  }): Promise<ScreenContentResult> {
    const { sourceKind, sourceRef, content } = params;

    // 1. Disabled → pass through immediately
    if (!this.config.enabled) {
      return {
        status: 'passed',
        summary: 'Content supervision is disabled.',
      };
    }

    const sensitivity = this.config.sensitivity ?? 'medium';

    // 2. Run heuristic scan
    const scanResult: ScanResult = scanContent(content, sensitivity);

    // 3. Not flagged at all → pass
    if (!scanResult.flagged) {
      const review = recordContentPass(
        this.config.saivageDir,
        sourceKind,
        sourceRef,
        'Content passed heuristic scan (no patterns matched).',
        'low',
      );
      return {
        status: 'passed',
        summary: 'Content passed heuristic scan.',
        review,
      };
    }

    // 4. Flagged but low risk → pass (don't escalate)
    if (!isInjectionSuspicious(scanResult)) {
      const review = recordContentPass(
        this.config.saivageDir,
        sourceKind,
        sourceRef,
        `Content flagged by heuristic (risk=${scanResult.risk}, category=${scanResult.matchedCategory ?? 'unknown'}) but risk is low — not escalated to LLM.`,
        scanResult.risk,
      );
      return {
        status: 'passed',
        summary: `Content flagged by heuristic as low risk (${scanResult.matchedCategory ?? 'unknown'}) — allowed through.`,
        review,
      };
    }

    // 5. Suspicious → escalate to LLM
    const llmModel = this.config.injectionModel ?? 'default-injection-model';

    let verdict: LlmVerdict;
    try {
      verdict = await scanWithLLM(content, {
        injectionModel: llmModel,
        maxScanLengthBytes: this.config.maxScanLengthBytes,
        makeLlmCall: this.config.makeLlmCall,
      });
    } catch (err) {
      // 6. LLM scan threw → conservative: block
      const reason = `LLM scan failed: ${(err as Error).message}`;
      const qResult = quarantineContent({
        saivageDir: this.config.saivageDir,
        saivageWorkDir: this.config.saivageWorkDir,
        sourceKind,
        sourceRef,
        content,
        reason,
        risk: scanResult.risk,
      });

      this.emitBlocked(qResult.sanitizedSummary, qResult.review);

      return {
        status: 'blocked',
        summary: qResult.sanitizedSummary,
        review: qResult.review,
        quarantine: qResult.quarantine,
      };
    }

    // 7. Low confidence → block regardless of safe flag (conservative)
    if (verdict.confidence < MIN_CONFIDENCE_THRESHOLD) {
      const reason = `LLM confidence too low (${verdict.confidence.toFixed(2)} < ${MIN_CONFIDENCE_THRESHOLD}): ${verdict.reason}`;
      const qResult = quarantineContent({
        saivageDir: this.config.saivageDir,
        saivageWorkDir: this.config.saivageWorkDir,
        sourceKind,
        sourceRef,
        content,
        reason,
        risk: scanResult.risk,
      });

      this.emitBlocked(qResult.sanitizedSummary, qResult.review);

      return {
        status: 'blocked',
        summary: qResult.sanitizedSummary,
        review: qResult.review,
        quarantine: qResult.quarantine,
      };
    }

    // 8. LLM says safe (with sufficient confidence) → pass
    if (verdict.safe) {
      const review = recordContentPass(
        this.config.saivageDir,
        sourceKind,
        sourceRef,
        `Content passed LLM scan: ${verdict.reason} (confidence=${verdict.confidence.toFixed(2)})`,
        scanResult.risk,
      );
      return {
        status: 'passed',
        summary: `Content passed LLM scan (confidence: ${verdict.confidence.toFixed(2)}).`,
        review,
      };
    }

    // 9. LLM says unsafe → block
    const reason = `LLM scan detected injection: ${verdict.reason}`;
    const qResult = quarantineContent({
      saivageDir: this.config.saivageDir,
      saivageWorkDir: this.config.saivageWorkDir,
      sourceKind,
      sourceRef,
      content,
      reason,
      risk: scanResult.risk,
    });

    this.emitBlocked(qResult.sanitizedSummary, qResult.review);

    return {
      status: 'blocked',
      summary: qResult.sanitizedSummary,
      review: qResult.review,
      quarantine: qResult.quarantine,
    };
  }

  /**
   * Determine whether a given source kind should be screened.
   *
   * Returns true for external content sources (command_output, file,
   * download, web, api, tool). Returns false for internal-only sources.
   */
  shouldScreen(sourceKind: SourceKind): boolean {
    return SCREENABLE_SOURCE_KINDS.has(sourceKind);
  }

  /**
   * Check whether content screening is currently disabled.
   */
  isScreeningDisabled(): boolean {
    return !this.config.enabled;
  }

  // ── Private Helpers ───────────────────────────────────────

  /** Emit a 'supervisor_blocked' event on the event bus, if configured. */
  private emitBlocked(summary: string, review: ContentReview): void {
    if (!this.config.eventBus) return;

    try {
      this.config.eventBus.emit('supervisor_blocked', {
        summary,
        review,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Silently ignore event emission errors — screening must not fail
      // because of event bus issues.
    }
  }
}
