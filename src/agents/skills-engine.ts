/**
 * SkillsEngine — Discovers, matches, ranks, loads, and formats skill files
 * for injection into agent system prompts.
 *
 * Implements the matching algorithm in 07-skills.md:
 *  1. Load index from .saivage/skills/index.json
 *  2. Filter by target_agents (role)
 *  3. Score each skill by counting matching triggers
 *  4. Rank by score desc, then updated_at desc
 *  5. Select top N
 *  6. Load and format as delimited blocks
 */

import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { skillIndexSchema } from '../schemas/validators.js';
import type { SkillIndexEntry, SkillTrigger, TriggerType, AgentRole } from '../schemas/types.js';

// ── Types ─────────────────────────────────────────────────────

export interface MatchParams {
  /** The goal description (for keyword matching) */
  goalDescription: string;
  /** The card description (for keyword matching) */
  cardDescription: string;
  /** Card tags (for tag matching) */
  tags: string[];
  /** File paths relevant to the current context (for path matching) */
  filePaths: string[];
  /** Available tools in the agent session (for tool matching) */
  availableTools: string[];
  /** The agent role being invoked: 'planner' | 'executor' | 'reviewer' | 'analyst' */
  targetRole: string;
}

interface SkillEngineOptions {
  /** Path to the skills directory. Defaults to PROJECT_ROOT/.saivage/skills */
  skillsDir?: string;
  /** Maximum number of skills to select. Default 5. */
  topN?: number;
  /** Project root directory. Defaults to process.cwd(). */
  projectRoot?: string;
}

interface CacheEntry {
  content: string;
  loadedAt: number;
}

// ── Glob Pattern → Regex ──────────────────────────────────────

/**
 * Convert a glob pattern to a regex for matching file paths.
 *
 * Supports:
 *  - `**` — match any number of path segments (including none)
 *  - `*`  — match any characters except path separator
 *  - `?`  — match any single character except path separator
 *  - Literal characters are escaped and matched literally.
 *
 * Uses `sep` from node:path for cross-platform path separator matching.
 */
function globToRegex(pattern: string): RegExp {
  const escapedSep = sep === '\\' ? '\\\\' : sep;

  // Split on ** boundaries to handle them specially
  const parts: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    if (pattern.slice(i, i + 2) === '**') {
      parts.push('**');
      i += 2;
      // Skip trailing slash after ** (e.g. **/foo)
      if (pattern[i] === sep || pattern[i] === '/') {
        i += 1;
      }
    } else {
      // Collect literal segment up to next ** or end
      let seg = '';
      while (i < pattern.length && pattern.slice(i, i + 2) !== '**') {
        seg += pattern[i];
        i += 1;
      }
      parts.push(seg);
    }
  }

  // Build regex from parts
  let regexStr = '^';
  for (let j = 0; j < parts.length; j++) {
    const part = parts[j];
    if (part === '**') {
      // ** matches any number of path segments
      // If this is the last part (or the only pattern is **), it matches anything
      if (j === parts.length - 1) {
        regexStr += '.*';
      } else {
        regexStr += `(?:.*${escapedSep})?`;
      }
    } else {
      // Escape regex special chars, then replace glob wildcards
      let escaped = '';
      for (const ch of part) {
        if (ch === '*' && (j === 0 || escaped.length === 0 || escaped[escaped.length - 1] !== '\\')) {
          escaped += `[^${escapedSep}]*`;
        } else if (ch === '?' && (j === 0 || escaped.length === 0 || escaped[escaped.length - 1] !== '\\')) {
          escaped += `[^${escapedSep}]`;
        } else if ('.+^${}()|[]\\'.includes(ch)) {
          escaped += '\\' + ch;
        } else {
          escaped += ch;
        }
      }
      regexStr += escaped;
    }
  }
  regexStr += '$';

  return new RegExp(regexStr);
}

// ── SkillsEngine ──────────────────────────────────────────────

export class SkillsEngine {
  private readonly skillsDir: string;
  private readonly projectRoot: string;
  readonly topN: number;

  /** In-memory cache for the index */
  private _indexCache: SkillIndexEntry[] | null = null;

  /** In-memory cache for skill file contents */
  private _fileCache: Map<string, CacheEntry> = new Map();

  /** Cache TTL in ms (60 seconds) */
  private readonly _cacheTTL: number = 60_000;

  /** In-memory cache for default role instructions (.saivage/instructions/<role>.md) */
  private _defaultInstructionCache: Map<string, CacheEntry> = new Map();

  constructor(options?: SkillEngineOptions) {
    this.projectRoot = options?.projectRoot
      ? resolve(options.projectRoot)
      : process.cwd();
    this.skillsDir = options?.skillsDir
      ? resolve(options.skillsDir)
      : join(this.projectRoot, '.saivage', 'skills');
    this.topN = options?.topN ?? 5;
  }

  // ── Public Methods ──────────────────────────────────────────

  /**
   * Load and parse the skill index from .saivage/skills/index.json.
   * Returns empty array if the file doesn't exist.
   * Results are cached in memory for the process lifetime.
   *
   * @throws ZodError if the JSON is valid but fails schema validation
   * @throws Error if the file exists but contains invalid JSON
   */
  loadIndex(): SkillIndexEntry[] {
    if (this._indexCache !== null) {
      return this._indexCache;
    }

    const indexPath = join(this.skillsDir, 'index.json');

    if (!existsSync(indexPath)) {
      this._indexCache = [];
      return this._indexCache;
    }

    let raw: unknown;
    try {
      const text = readFileSync(indexPath, 'utf-8');
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `Failed to parse skill index at ${indexPath}: ${(err as Error).message}`,
      );
    }

    // Validate with Zod — throws on invalid data
    const parsed = skillIndexSchema.parse(raw);
    this._indexCache = parsed;
    return this._indexCache;
  }

  /**
   * Load a skill's file content by skill name.
   * Uses the index to resolve the file path, then reads the content.
   * Results are cached with a 60-second TTL.
   *
   * @throws Error if the skill name is not found in the index
   * @throws Error if the skill file does not exist
   */
  async getSkillFile(name: string): Promise<string> {
    // Check cache first
    const cached = this._fileCache.get(name);
    if (cached && Date.now() - cached.loadedAt < this._cacheTTL) {
      return cached.content;
    }

    // Look up the skill in the index
    const index = this.loadIndex();
    const entry = index.find((e) => e.name === name);
    if (!entry) {
      throw new Error(`Skill "${name}" not found in index`);
    }

    const filePath = join(this.skillsDir, entry.file);
    if (!existsSync(filePath)) {
      throw new Error(`Skill file not found: ${filePath}`);
    }

    const content = await readFile(filePath, 'utf-8');
    this._fileCache.set(name, { content, loadedAt: Date.now() });
    return content;
  }

  /**
   * Match skills against the provided context parameters.
   *
   * Algorithm (per 07-skills.md):
   *  1. Load index
   *  2. Filter by target_agents (role filtering)
   *  3. Score each skill: each matching trigger adds 1 to the score
   *  4. Rank: sort by score desc, then updated_at desc (most recent first)
   *  5. Return top N skills
   */
  async matchSkills(params: MatchParams): Promise<SkillIndexEntry[]> {
    const index = this.loadIndex();

    // Filter by target role
    const roleFiltered = index.filter((entry) =>
      entry.target_agents.includes(params.targetRole as AgentRole),
    );

    // Score each skill
    const scored = roleFiltered.map((entry) => {
      let score = 0;
      for (const trigger of entry.triggers) {
        if (this._triggerMatches(trigger, params)) {
          score += 1;
        }
      }
      return { entry, score };
    });

    // Filter out skills with score 0
    const withHits = scored.filter((s) => s.score > 0);

    // Rank: score desc, then updated_at desc
    withHits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.entry.updated_at.localeCompare(a.entry.updated_at);
    });

    // Top N
    const top = withHits.slice(0, this.topN);
    return top.map((s) => s.entry);
  }

  /**
   * Format an array of skill entries as delimited blocks for injection
   * into agent system prompts.
   *
   * Format:
   * ```
   * --- SKILL: <name> ---
   * <content>
   * --- END SKILL ---
   * ```
   *
   * Blocks are joined by double newlines. Returns empty string for
   * an empty array.
   */
  async formatSkills(skills: SkillIndexEntry[]): Promise<string> {
    if (skills.length === 0) return '';

    const blocks: string[] = [];
    for (const skill of skills) {
      const content = await this.getSkillFile(skill.name);
      blocks.push(`--- SKILL: ${skill.name} ---\n${content}\n--- END SKILL ---`);
    }
    return blocks.join('\n\n');
  }

  /**
   * Convenience method: matchSkills then formatSkills.
   */
  async selectAndFormat(params: MatchParams): Promise<string> {
    const matched = await this.matchSkills(params);
    return this.formatSkills(matched);
  }

  /**
   * Load the planner instructions file.
   *
   * This compatibility wrapper preserves the historical planner-specific API
   * while delegating to the role-generic instruction loader used by runtime.
   */
  async loadPlannerInstructions(customFilePath?: string): Promise<string> {
    return this.loadInstructions('planner', customFilePath);
  }

  /**
   * Load role default instructions from .saivage/instructions/<role>.md, or a
   * custom project-relative file when provided. Custom files are used for
   * planner card overrides; default role files are cached for the normal TTL.
   */
  async loadInstructions(role: AgentRole, customFilePath?: string): Promise<string> {
    if (customFilePath && customFilePath.trim() !== '') {
      return this._loadCustomInstructions(role, customFilePath.trim());
    }
    return this._loadDefaultInstructions(role);
  }

  /**
   * Load a custom instructions file. Always reads directly — no caching for
   * custom paths so per-card instruction edits are visible immediately.
   */
  private async _loadCustomInstructions(role: AgentRole, filePath: string): Promise<string> {
    const resolvedPath = resolve(this.projectRoot, filePath);

    if (!existsSync(resolvedPath)) {
      return '';
    }

    const content = await readFile(resolvedPath, 'utf-8');
    if (!content.trim()) {
      return '';
    }

    return this._formatInstructionBlock(role, content);
  }

  /**
   * Load the default instructions from .saivage/instructions/<role>.md.
   * Cached with the same TTL as skill files.
   */
  private async _loadDefaultInstructions(role: AgentRole): Promise<string> {
    const cached = this._defaultInstructionCache.get(role);
    if (cached && Date.now() - cached.loadedAt < this._cacheTTL) {
      return cached.content;
    }

    const instrPath = join(this.projectRoot, '.saivage', 'instructions', `${role}.md`);

    if (!existsSync(instrPath)) {
      this._defaultInstructionCache.set(role, { content: '', loadedAt: Date.now() });
      return '';
    }

    const content = await readFile(instrPath, 'utf-8');
    if (!content.trim()) {
      this._defaultInstructionCache.set(role, { content: '', loadedAt: Date.now() });
      return '';
    }

    const result = this._formatInstructionBlock(role, content);
    this._defaultInstructionCache.set(role, { content: result, loadedAt: Date.now() });
    return result;
  }

  private _formatInstructionBlock(role: AgentRole, content: string): string {
    const label = role.toUpperCase().replace(/_/g, ' ');
    return `--- ${label} INSTRUCTIONS ---
${content}
--- END ${label} INSTRUCTIONS ---`;
  }

  // ── Private Helpers ─────────────────────────────────────────

  /**
   * Check if a single trigger matches the current params.
   */
  private _triggerMatches(trigger: SkillTrigger, params: MatchParams): boolean {
    switch (trigger.type) {
      case 'keyword':
        return this._keywordMatches(trigger.pattern, params.goalDescription, params.cardDescription);
      case 'tool':
        return this._toolMatches(trigger.pattern, params.availableTools);
      case 'path':
        return this._pathMatches(trigger.pattern, params.filePaths);
      case 'tag':
        return this._tagMatches(trigger.pattern, params.tags);
      default:
        return false;
    }
  }

  /**
   * Keyword matching: case-insensitive substring match against
   * goalDescription OR cardDescription.
   */
  private _keywordMatches(pattern: string, goalDescription: string, cardDescription: string): boolean {
    const lower = pattern.toLowerCase();
    return (
      goalDescription.toLowerCase().includes(lower) ||
      cardDescription.toLowerCase().includes(lower)
    );
  }

  /**
   * Tool matching: exact, case-sensitive match against availableTools.
   */
  private _toolMatches(pattern: string, availableTools: string[]): boolean {
    return availableTools.includes(pattern);
  }

  /**
   * Path matching: glob match against filePaths.
   */
  private _pathMatches(pattern: string, filePaths: string[]): boolean {
    const regex = globToRegex(pattern);
    return filePaths.some((fp) => regex.test(fp));
  }

  /**
   * Tag matching: exact, case-sensitive match against tags array.
   */
  private _tagMatches(pattern: string, tags: string[]): boolean {
    return tags.includes(pattern);
  }
}
