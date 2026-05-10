/**
 * Write Territory Warnings — Advisory rules per agent role
 *
 * Each agent role has advisory write territory rules — conventions
 * about which areas of the project each role should write to. These
 * are enforced as **warnings, not blocks**: violations are logged but
 * do not prevent the write.
 *
 * See 05-security.md § "Agent Write Territories" for the spec.
 */

// ── Types ─────────────────────────────────────────────────────

/**
 * All agent roles recognised by the territory system.
 *
 * Matches the roles from 03-agents.md plus the `content_supervisor`
 * role from 05-security.md.
 */
export type TerritoryRole =
  | 'analyst'
  | 'planner'
  | 'executor'
  | 'reviewer'
  | 'content_supervisor';

/**
 * Result from `checkWriteTerritory`.
 *
 * - `allowed` is always `true` — territory violations produce
 *   warnings but never block writes.
 * - `warning` is the human-readable message when the write
 *   falls outside the role's territory (or is in an excluded area).
 */
export interface TerritoryResult {
  /** Always `true` — territories are advisory only. */
  allowed: boolean;
  /** Warning message if the write violates territory, or undefined. */
  warning?: string;
}

/**
 * Definition of one role's territory rules.
 */
export interface TerritoryRule {
  /** Directories or prefix patterns the role is allowed to write to. */
  allowed: string[];
  /** Directories or prefix patterns the role should NOT write to. */
  excludes: string[];
}

// ── Territory Rules ───────────────────────────────────────────

/**
 * The complete set of write territory rules per agent role.
 *
 * Matches the matrix from 05-security.md § "Agent Write Territories":
 *
 * | Role     | Write territory                                     | Exclude                          |
 * |----------|-----------------------------------------------------|----------------------------------|
 * | Analyst  | Chat sessions & notes via `.saivage/agents/`, `.saivage/notes/` | `src/` (project source) |
 * | Planner  | Plan card diary (via runtime) — `.saivage/`          | `src/`, `.saivage-work/`         |
 * | Executor | Project files (`src/`), `.saivage-work/cards/`, `.saivage-work/processes/` | `.saivage/`, other cards' artifacts |
 * | Reviewer | Review reports via runtime — `.saivage/`             | `src/`, `.saivage-work/`         |
 *
 * `content_supervisor` has no restrictions — it only writes to
 * quarantine and supervision directories.
 */
export const TERRITORY_RULES: Record<TerritoryRole, TerritoryRule> = {
  analyst: {
    allowed: ['.saivage/agents/', '.saivage/notes/'],
    excludes: ['src/'],
  },
  planner: {
    allowed: ['.saivage/'],
    excludes: ['src/', '.saivage-work/'],
  },
  executor: {
    allowed: ['src/', '.saivage-work/cards/', '.saivage-work/processes/'],
    excludes: ['.saivage/'],
  },
  reviewer: {
    allowed: ['.saivage/'],
    excludes: ['src/', '.saivage-work/'],
  },
  /** No territory restrictions — it writes to quarantine/supervision only. */
  content_supervisor: {
    allowed: [],
    excludes: [],
  },
};

// ── Helpers ───────────────────────────────────────────────────

/**
 * Check whether `filePath` starts with `prefix` (after normalisation).
 *
 * Handles Windows backslash paths by converting to forward slashes
 * before comparison. Prefix matching is case-sensitive.
 */
function startsWithPrefix(filePath: string, prefix: string): boolean {
  // Normalise to forward slashes for comparison
  const normalised = filePath.replace(/\\/g, '/');
  const normalisedPrefix = prefix.replace(/\\/g, '/');
  return normalised.startsWith(normalisedPrefix);
}

/**
 * Strip a leading `./` from a project-relative path.
 */
function stripDotSlash(filePath: string): string {
  if (filePath.startsWith('./')) {
    return filePath.slice(2);
  }
  return filePath;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Check whether a write operation at `filePath` falls within the
 * territory of the given agent `role`.
 *
 * **Territory violations are advisory only** — `allowed` is always
 * `true`.  The returned `warning` string describes the violation
 * when the path is outside the role's allowed territory or within
 * an excluded area.
 *
 * Rules:
 *  - If no territory rules exist for the role → no warning.
 *  - If the path falls within allowed territory AND is not in an
 *    excluded area → no warning.
 *  - If the path falls within allowed territory BUT also within an
 *    excluded area → returns `{ allowed: true, warning: '...' }`.
 *  - If the path does NOT match any allowed territory → returns
 *    `{ allowed: true, warning: '...' }`.
 *
 * @param role    - The agent role performing the write.
 * @param filePath - Project-relative file path being written to.
 * @returns A `TerritoryResult` with `allowed: true` and an optional
 *          warning string.
 */
export function checkWriteTerritory(
  role: string,
  filePath: string,
): TerritoryResult {
  const clean = stripDotSlash(filePath);

  // Unknown roles — no territory rules apply
  if (!(role in TERRITORY_RULES)) {
    return { allowed: true };
  }

  const rule = TERRITORY_RULES[role as TerritoryRole];

  // content_supervisor has no restrictions
  if (rule.allowed.length === 0 && rule.excludes.length === 0) {
    return { allowed: true };
  }

  // Check if path is in any excluded area (check first — exclusions
  // take priority even when a path also matches an allowed prefix)
  let excludedMatch: string | null = null;
  for (const excl of rule.excludes) {
    if (startsWithPrefix(clean, excl)) {
      excludedMatch = excl;
      break;
    }
  }

  // Check if path is in any allowed territory
  let allowedMatch: string | null = null;
  for (const allow of rule.allowed) {
    if (startsWithPrefix(clean, allow)) {
      allowedMatch = allow;
      break;
    }
  }

  // If not in any allowed territory → warn
  if (allowedMatch === null) {
    const roleLabel = role.replace(/_/g, ' ');
    return {
      allowed: true,
      warning: `${roleLabel} writing to "${filePath}" (outside territory: ${rule.allowed.join(', ') || 'none'})`,
    };
  }

  // If within allowed but also within excluded → warn
  if (excludedMatch !== null) {
    const roleLabel = role.replace(/_/g, ' ');
    return {
      allowed: true,
      warning: `${roleLabel} writing to "${filePath}" within excluded area "${excludedMatch}" (allowed: ${allowedMatch})`,
    };
  }

  // Fully within territory
  return { allowed: true };
}

/**
 * Convenience: return the warning string for a territory violation,
 * or `null` if the write is fully within the role's territory.
 *
 * This is the main API for runtime territory checks — the caller
 * can log the warning if non-null, and always allow the write.
 *
 * @param role     - The agent role performing the write.
 * @param filePath - Project-relative file path being written to.
 * @returns The warning string, or `null` if no violation.
 */
export function getTerritoryWarning(
  role: string,
  filePath: string,
): string | null {
  const result = checkWriteTerritory(role, filePath);
  return result.warning ?? null;
}
