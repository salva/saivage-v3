/**
 * Heuristic Prompt Injection Scanner — Layer 1
 *
 * Fast, pure-regex scanner that detects common prompt injection
 * techniques before content enters an agent context.
 *
 * See current security behavior in this module and its tests.
 */

import {
  getCompiledPatterns,
  type Pattern,
} from './heuristic-patterns.js';

export { PATTERNS_BY_CATEGORY } from './heuristic-patterns.js';

// ── Types ─────────────────────────────────────────────────────

/** Controls matching strictness: narrower patterns vs broader. */
export type SensitivityLevel = 'low' | 'medium' | 'high';

/**
 * Result from a single `scanContent` call.
 *
 * - `flagged` is true when at least one pattern matched.
 * - `matchedCategory` is the highest-severity category that matched.
 * - `matchedPatterns` lists every individual pattern id that fired.
 * - `risk` is the scanner's assessment: low (cosmetic only), medium
 *   (suspicious), or high (almost certainly injection).
 */
export interface ScanResult {
  flagged: boolean;
  matchedCategory?: InjectionCategory;
  matchedPatterns?: string[];
  risk: 'low' | 'medium' | 'high';
}

/** The six injection categories implemented by this scanner. */
export type InjectionCategory =
  | 'instruction_override'
  | 'role_hijacking'
  | 'tool_use_direction'
  | 'secret_exfiltration'
  | 'destructive_commands'
  | 'self_labeled_injection';

// ── Sensitivity Ordering ─────────────────────────────────────

const SENSITIVITY_RANK: Record<SensitivityLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function patternActive(p: Pattern, level: SensitivityLevel): boolean {
  return SENSITIVITY_RANK[p.sensitivity] <= SENSITIVITY_RANK[level];
}

// ── Category Priority (for matchedCategory) ──────────────────

const CATEGORY_PRIORITY: Record<InjectionCategory, number> = {
  self_labeled_injection: 6,
  secret_exfiltration: 5,
  destructive_commands: 4,
  instruction_override: 3,
  role_hijacking: 2,
  tool_use_direction: 1,
};

// ── Public API ────────────────────────────────────────────────

/**
 * Scan content for prompt injection patterns.
 *
 * @param content - The text to scan. Empty strings return clean.
 * @param sensitivity - Matching strictness. Default: 'medium'.
 * @returns A `ScanResult` with `flagged`, `matchedCategory`,
 *          `matchedPatterns`, and `risk`.
 */
export function scanContent(
  content: string,
  sensitivity: SensitivityLevel = 'medium',
): ScanResult {
  // Fast path: empty or whitespace-only content is never flagged
  if (!content || content.trim().length === 0) {
    return { flagged: false, risk: 'low' };
  }

  const active: Pattern[] = [];
  for (const p of getCompiledPatterns()) {
    if (patternActive(p, sensitivity)) {
      active.push(p);
    }
  }

  // Short-circuit if no patterns are active at this sensitivity
  if (active.length === 0) {
    return { flagged: false, risk: 'low' };
  }

  const matched: Pattern[] = [];

  for (const p of active) {
    // Reset lastIndex for global/sticky patterns just in case
    p.regex.lastIndex = 0;
    if (p.regex.test(content)) {
      matched.push(p);
    }
  }

  if (matched.length === 0) {
    return { flagged: false, risk: 'low' };
  }

  // Determine overall risk as max severity among matches
  const severityRank: Record<string, number> = { low: 0, medium: 1, high: 2 };
  let maxSev: 'low' | 'medium' | 'high' = 'low';
  for (const m of matched) {
    if (severityRank[m.severity] > severityRank[maxSev]) {
      maxSev = m.severity;
    }
  }

  // Pick the highest-priority category among matches
  let bestCat: InjectionCategory | undefined;
  let bestPrio = -1;
  for (const m of matched) {
    const prio = CATEGORY_PRIORITY[m.category];
    if (prio > bestPrio) {
      bestPrio = prio;
      bestCat = m.category;
    }
  }

  return {
    flagged: true,
    matchedCategory: bestCat,
    matchedPatterns: matched.map((m) => m.id),
    risk: maxSev,
  };
}

/**
 * Returns true when a scan result is suspicious enough to warrant
 * escalation to Layer 2 (LLM scan).
 *
 * Suspicious := flagged AND risk is 'medium' or 'high'.
 * Low-risk flagged results are logged but not escalated.
 */
export function isInjectionSuspicious(result: ScanResult): boolean {
  return result.flagged && (result.risk === 'medium' || result.risk === 'high');
}
