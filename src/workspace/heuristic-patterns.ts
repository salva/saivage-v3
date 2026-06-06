/**
 * Heuristic prompt-injection pattern definitions and lazy compilation.
 */

import type { InjectionCategory, SensitivityLevel } from './heuristic-scanner.js';

/** A single compiled pattern with metadata. */
export interface Pattern {
  /** Unique human-readable id for reporting. */
  id: string;
  /** The compiled regex. */
  regex: RegExp;
  /** The category this pattern belongs to. */
  category: InjectionCategory;
  /** Minimum sensitivity level at which this pattern is active. */
  sensitivity: SensitivityLevel;
  /** 'low' | 'medium' | 'high' — how risky a match is. */
  severity: 'low' | 'medium' | 'high';
}

/** Raw pattern definition before compilation. */
interface PatternDef {
  id: string;
  /** The regex source string (no delimiters, no flags). */
  pattern: string;
  /** The category this pattern belongs to. */
  category: InjectionCategory;
  /** Regex flags string, e.g. 'i' for case-insensitive. */
  flags: string;
  sensitivity: SensitivityLevel;
  severity: 'low' | 'medium' | 'high';
}

// ── Pattern Definitions ───────────────────────────────────────

/**
 * All heuristic patterns categorised by the scanner categories.
 *
 * Every pattern is tagged with:
 *  - `sensitivity`: the minimum SensitivityLevel that enables it
 *  - `severity`: how dangerous a match on this pattern looks
 *
 * **'low' sensitivity** (exact, narrow, case-sensitive):
 *   Only matches high-confidence, literal strings.
 *   Good for: production environments that must avoid false positives.
 *
 * **'medium' sensitivity** (default, case-insensitive):
 *   Handles variations like "Ignore all previous instructions" and
 *   "ignore previous instructions" equally. Slightly broader patterns.
 *
 * **'high' sensitivity** (aggressive, broad):
 *   Matches partial phrases, loose word boundaries, and common
 *   injection fragments. Best for pre-screening before Layer 2.
 */

const PATTERN_DEFS: PatternDef[] = [
  // ── instruction_override ──────────────────────────────────

  // low: exact high-confidence strings (case-sensitive)
  {
    id: 'ovr-exact-1',
    pattern: 'ignore previous instructions',
    flags: '',
    category: 'instruction_override',
    sensitivity: 'low',
    severity: 'high',
  },
  {
    id: 'ovr-exact-2',
    pattern: 'override system prompt',
    flags: '',
    category: 'instruction_override',
    sensitivity: 'low',
    severity: 'high',
  },
  {
    id: 'ovr-exact-3',
    pattern: 'disregard all prior',
    flags: '',
    category: 'instruction_override',
    sensitivity: 'low',
    severity: 'high',
  },
  {
    id: 'ovr-exact-4',
    pattern: 'disregard all previous instructions',
    flags: '',
    category: 'instruction_override',
    sensitivity: 'low',
    severity: 'high',
  },

  // medium: case-insensitive variations (default)
  {
    id: 'ovr-med-1',
    pattern: 'ignore\\s+(?:all\\s+)?(?:previous|prior|above)\\s+instructions?',
    flags: 'i',
    category: 'instruction_override',
    sensitivity: 'medium',
    severity: 'high',
  },
  {
    id: 'ovr-med-2',
    pattern: 'override\\s+(?:the\\s+)?(?:system(?:\\s+prompt)?|instructions?)',
    flags: 'i',
    category: 'instruction_override',
    sensitivity: 'medium',
    severity: 'high',
  },
  {
    id: 'ovr-med-3',
    pattern: 'disregard\\s+(?:all\\s+)?(?:prior|previous)\\s+(?:instructions?|directives?)',
    flags: 'i',
    category: 'instruction_override',
    sensitivity: 'medium',
    severity: 'high',
  },
  {
    id: 'ovr-med-4',
    pattern: 'forget\\s+(?:all|your|the)\\s+(?:previous|prior)\\s+(?:instructions?|training|rules?)',
    flags: 'i',
    category: 'instruction_override',
    sensitivity: 'medium',
    severity: 'high',
  },
  {
    id: 'ovr-med-5',
    pattern: 'do not follow\\s+(?:your|the)\\s+(?:instructions?|rules?|system\\s+prompt)',
    flags: 'i',
    category: 'instruction_override',
    sensitivity: 'medium',
    severity: 'medium',
  },

  // high: aggressive partial matches
  {
    id: 'ovr-high-1',
    pattern: 'ignore\\s+(?:all\\s+)?(?:the\\s+)?(?:above|previous|prior|before)',
    flags: 'i',
    category: 'instruction_override',
    sensitivity: 'high',
    severity: 'medium',
  },
  {
    id: 'ovr-high-2',
    pattern: 'override\\s+(?:the\\s+)?system',
    flags: 'i',
    category: 'instruction_override',
    sensitivity: 'high',
    severity: 'medium',
  },
  {
    id: 'ovr-high-3',
    pattern: '(?:from now on|starting now)\\s+you\\s+are\\s+(?:a|an|the|now|no longer)',
    flags: 'i',
    category: 'instruction_override',
    sensitivity: 'high',
    severity: 'low',
  },

  // ── role_hijacking ────────────────────────────────────────

  // low
  {
    id: 'role-exact-1',
    pattern: 'you are now',
    flags: '',
    category: 'role_hijacking',
    sensitivity: 'low',
    severity: 'medium',
  },
  {
    id: 'role-exact-2',
    pattern: 'pretend to be',
    flags: '',
    category: 'role_hijacking',
    sensitivity: 'low',
    severity: 'medium',
  },
  {
    id: 'role-exact-3',
    pattern: 'act as',
    flags: '',
    category: 'role_hijacking',
    sensitivity: 'low',
    severity: 'medium',
  },

  // medium
  {
    id: 'role-med-1',
    pattern: 'you\\s+are\\s+now\\s+(?:acting\\s+as|a(?:n)?\\s)',
    flags: 'i',
    category: 'role_hijacking',
    sensitivity: 'medium',
    severity: 'medium',
  },
  {
    id: 'role-med-2',
    pattern: 'pretend\\s+(?:that\\s+)?(?:you\\s+are|to\\s+be)\\s+(?:a(?:n)?|the)\\s',
    flags: 'i',
    category: 'role_hijacking',
    sensitivity: 'medium',
    severity: 'medium',
  },
  {
    id: 'role-med-3',
    pattern: 'act\\s+as\\s+(?:if\\s+you\\s+are|though\\s+you\\s+were|a(?:n)?\\s)',
    flags: 'i',
    category: 'role_hijacking',
    sensitivity: 'medium',
    severity: 'medium',
  },
  {
    id: 'role-med-4',
    pattern: 'your\\s+(?:new\\s+)?role\\s+is',
    flags: 'i',
    category: 'role_hijacking',
    sensitivity: 'medium',
    severity: 'medium',
  },
  {
    id: 'role-med-5',
    pattern: 'assume\\s+(?:the|a)\\s+(?:role|identity|persona)\\s+of',
    flags: 'i',
    category: 'role_hijacking',
    sensitivity: 'medium',
    severity: 'medium',
  },
  // "impersonate a ..." / "emulate a ..." — caught at medium
  {
    id: 'role-med-6',
    pattern: '(?:impersonate|emulate|mimic|simulate)\\s+(?:a|an|the)\\s',
    flags: 'i',
    category: 'role_hijacking',
    sensitivity: 'medium',
    severity: 'medium',
  },

  // high
  {
    id: 'role-high-1',
    pattern: 'you\\s+are\\s+(?:now\\s+)?(?:a|an|the)\\s+(?:different|new)\\s+(?:AI|assistant|agent|model|bot|system)',
    flags: 'i',
    category: 'role_hijacking',
    sensitivity: 'high',
    severity: 'medium',
  },
  {
    id: 'role-high-2',
    pattern: '(?:impersonate|emulate|mimic|simulate)\\s+\\w',
    flags: 'i',
    category: 'role_hijacking',
    sensitivity: 'high',
    severity: 'low',
  },

  // ── tool_use_direction ────────────────────────────────────

  // low: exact high-confidence strings (case-sensitive)
  {
    id: 'tool-exact-1',
    pattern: 'call the tool',
    flags: '',
    category: 'tool_use_direction',
    sensitivity: 'low',
    severity: 'medium',
  },
  {
    id: 'tool-exact-2',
    pattern: 'use the function',
    flags: '',
    category: 'tool_use_direction',
    sensitivity: 'low',
    severity: 'medium',
  },
  {
    id: 'tool-exact-3',
    pattern: 'execute the command',
    flags: '',
    category: 'tool_use_direction',
    sensitivity: 'low',
    severity: 'medium',
  },

  // medium: verb + determiner + ONE intermediate word + tool/function/command
  // This avoids matching "Call the function with params" (no intermediate word)
  // while catching "Call the write_file tool", "Invoke the shell tool", etc.
  {
    id: 'tool-med-1',
    pattern: '(?:call|use|invoke|run|execute)\\s+(?:the|a)\\s+\\w+\\s+(?:tool|function|command|utility|method|endpoint|API|script|binary|program|shell)\\b',
    flags: 'i',
    category: 'tool_use_direction',
    sensitivity: 'medium',
    severity: 'medium',
  },
  // Also catch imperative directing: "you must call the tool", "please use the function"
  {
    id: 'tool-med-2',
    pattern: '(?:you\\s+(?:must|have to|should|need to|will)|please|now)\\s+(?:call|use|run|execute|invoke)\\s+(?:the|a)\\s+(?:tool|function|command)',
    flags: 'i',
    category: 'tool_use_direction',
    sensitivity: 'medium',
    severity: 'medium',
  },

  // high: broad patterns
  {
    id: 'tool-high-1',
    pattern: '(?:you must|you have to|you should|please)\\s+(?:call|use|run|execute|invoke)\\s+(?:the|a)',
    flags: 'i',
    category: 'tool_use_direction',
    sensitivity: 'high',
    severity: 'low',
  },
  {
    id: 'tool-high-2',
    pattern: 'using\\s+(?:the\\s+)?(?:tool|function|command)\\s+(?:named|called|labeled)',
    flags: 'i',
    category: 'tool_use_direction',
    sensitivity: 'high',
    severity: 'low',
  },
  // Direct verb+determiner+target (no intermediate word) — catches at high only
  {
    id: 'tool-high-3',
    pattern: '(?:call|use|invoke|run|execute)\\s+(?:the|a)\\s+(?:tool|function|command|utility|method)\\b',
    flags: 'i',
    category: 'tool_use_direction',
    sensitivity: 'high',
    severity: 'low',
  },

  // ── secret_exfiltration ───────────────────────────────────

  // low
  {
    id: 'secr-exact-1',
    pattern: 'output the system prompt',
    flags: '',
    category: 'secret_exfiltration',
    sensitivity: 'low',
    severity: 'high',
  },
  {
    id: 'secr-exact-2',
    pattern: 'reveal your instructions',
    flags: '',
    category: 'secret_exfiltration',
    sensitivity: 'low',
    severity: 'high',
  },
  {
    id: 'secr-exact-3',
    pattern: 'print the API key',
    flags: '',
    category: 'secret_exfiltration',
    sensitivity: 'low',
    severity: 'high',
  },

  // medium
  {
    id: 'secr-med-1',
    pattern: '(?:output|reveal|print|show|display|echo|dump)\\s+(?:the|your|all)\\s+(?:system\\s+prompt|instructions?|API\\s+keys?|secrets?|credentials?|tokens?|password)',
    flags: 'i',
    category: 'secret_exfiltration',
    sensitivity: 'medium',
    severity: 'high',
  },
  {
    id: 'secr-med-2',
    pattern: '(?:tell me|show me|give me|provide)\\s+(?:the|your|all)\\s+(?:system\\s+prompt|instructions?|API\\s+keys?|secrets?|credentials?|tokens?)',
    flags: 'i',
    category: 'secret_exfiltration',
    sensitivity: 'medium',
    severity: 'high',
  },
  {
    id: 'secr-med-3',
    pattern: 'what\\s+(?:is|are)\\s+(?:your|the)\\s+(?:system\\s+prompt|instructions?|API\\s+keys?|secrets?)',
    flags: 'i',
    category: 'secret_exfiltration',
    sensitivity: 'medium',
    severity: 'medium',
  },
  {
    id: 'secr-med-4',
    pattern: 'repeat\\s+(?:back\\s+)?(?:the|your)\\s+(?:system\\s+prompt|instructions?|rules?)',
    flags: 'i',
    category: 'secret_exfiltration',
    sensitivity: 'medium',
    severity: 'high',
  },
  {
    id: 'secr-med-5',
    pattern: '(?:leak|exfiltrate|steal|extract)\\s+(?:the|your|all)\\s+(?:secrets?|keys?|tokens?|credentials?|data)',
    flags: 'i',
    category: 'secret_exfiltration',
    sensitivity: 'medium',
    severity: 'high',
  },

  // high
  {
    id: 'secr-high-1',
    pattern: '(?:output|reveal|print|show|display|dump)\\s+(?:everything|all|any)\\s+(?:you|your)',
    flags: 'i',
    category: 'secret_exfiltration',
    sensitivity: 'high',
    severity: 'medium',
  },
  {
    id: 'secr-high-2',
    pattern: 'what\\s+(?:are|is)\\s+your\\s+(?:prompt|system|instructions?)',
    flags: 'i',
    category: 'secret_exfiltration',
    sensitivity: 'high',
    severity: 'medium',
  },
  {
    id: 'secr-high-3',
    pattern: 'send\\s+(?:me|us|this)\\s+(?:the|your)\\s+(?:system\\s+)?(?:prompt|instructions?|config)',
    flags: 'i',
    category: 'secret_exfiltration',
    sensitivity: 'high',
    severity: 'medium',
  },

  // ── destructive_commands ──────────────────────────────────

  // low
  {
    id: 'dest-exact-1',
    pattern: 'delete all files',
    flags: '',
    category: 'destructive_commands',
    sensitivity: 'low',
    severity: 'high',
  },
  {
    id: 'dest-exact-2',
    pattern: 'drop table',
    flags: '',
    category: 'destructive_commands',
    sensitivity: 'low',
    severity: 'high',
  },

  // medium
  {
    id: 'dest-med-1',
    pattern: 'rm\\s+(?:-r[a-z]*f[a-z]*|-rf|[a-z]*rf)',
    flags: 'i',
    category: 'destructive_commands',
    sensitivity: 'medium',
    severity: 'high',
  },
  {
    id: 'dest-med-2',
    pattern: '(?:delete|remove|wipe|erase|nuke|destroy)\\s+(?:all|every|the|my|your)\\s+(?:files?|director(?:y|ies)|data|database|disk|drive)',
    flags: 'i',
    category: 'destructive_commands',
    sensitivity: 'medium',
    severity: 'high',
  },
  {
    id: 'dest-med-3',
    pattern: 'drop\\s+(?:table|database|schema|collection)',
    flags: 'i',
    category: 'destructive_commands',
    sensitivity: 'medium',
    severity: 'high',
  },
  {
    id: 'dest-med-4',
    pattern: '(?:format|fdisk|mkfs)\\s+(?:the\\s+)?(?:drive|disk|partition|volume)',
    flags: 'i',
    category: 'destructive_commands',
    sensitivity: 'medium',
    severity: 'high',
  },
  {
    id: 'dest-med-5',
    pattern: '(?:shutdown|halt|reboot|poweroff)\\s+(?:now|the|this)?',
    flags: 'i',
    category: 'destructive_commands',
    sensitivity: 'medium',
    severity: 'medium',
  },
  {
    id: 'dest-med-6',
    pattern: '(?:fork\\s+bomb|: ?\\(\\)\\s*\\{|dd\\s+if=)',
    flags: 'i',
    category: 'destructive_commands',
    sensitivity: 'medium',
    severity: 'high',
  },

  // high
  {
    id: 'dest-high-1',
    pattern: 'rm\\s+',
    flags: 'i',
    category: 'destructive_commands',
    sensitivity: 'high',
    severity: 'low',
  },
  {
    id: 'dest-high-2',
    pattern: 'chmod\\s+(?:777|000|-R\\s+777)',
    flags: 'i',
    category: 'destructive_commands',
    sensitivity: 'high',
    severity: 'medium',
  },
  {
    id: 'dest-high-3',
    pattern: '>\\s*/dev/(?:null|zero|sd[a-z]|nvme)',
    flags: 'i',
    category: 'destructive_commands',
    sensitivity: 'high',
    severity: 'high',
  },
  {
    id: 'dest-high-4',
    pattern: 'curl.*\\|\\s*(?:ba)?sh',
    flags: 'i',
    category: 'destructive_commands',
    sensitivity: 'high',
    severity: 'medium',
  },

  // ── self_labeled_injection ────────────────────────────────

  // low
  {
    id: 'self-exact-1',
    pattern: 'BEGIN INJECTION',
    flags: '',
    category: 'self_labeled_injection',
    sensitivity: 'low',
    severity: 'high',
  },
  {
    id: 'self-exact-2',
    pattern: 'PROMPT INJECTION',
    flags: '',
    category: 'self_labeled_injection',
    sensitivity: 'low',
    severity: 'high',
  },
  {
    id: 'self-exact-3',
    pattern: 'SYSTEM OVERRIDE',
    flags: '',
    category: 'self_labeled_injection',
    sensitivity: 'low',
    severity: 'high',
  },

  // medium
  {
    id: 'self-med-1',
    pattern: '(?:begin|start)\\s+(?:of\\s+)?(?:injection|attack|exploit|payload|hack)',
    flags: 'i',
    category: 'self_labeled_injection',
    sensitivity: 'medium',
    severity: 'high',
  },
  {
    id: 'self-med-2',
    pattern: '(?:prompt|system|instruction)\\s+(?:injection|attack|override|hijack|exploit)',
    flags: 'i',
    category: 'self_labeled_injection',
    sensitivity: 'medium',
    severity: 'high',
  },
  {
    id: 'self-med-3',
    pattern: '(?:end|close)\\s+(?:of\\s+)?(?:injection|attack|exploit|payload|hack)',
    flags: 'i',
    category: 'self_labeled_injection',
    sensitivity: 'medium',
    severity: 'medium',
  },
  {
    id: 'self-med-4',
    pattern: '(?:jailbreak|prompt\\s*hack|prompt\\s*leak)',
    flags: 'i',
    category: 'self_labeled_injection',
    sensitivity: 'medium',
    severity: 'high',
  },

  // high
  {
    id: 'self-high-1',
    pattern: '\\[\\[INJECT(?:ION)?\\]\\]',
    flags: 'i',
    category: 'self_labeled_injection',
    sensitivity: 'high',
    severity: 'high',
  },
  {
    id: 'self-high-2',
    pattern: '<\\|?INJECT(?:ION)?\\|?>',
    flags: 'i',
    category: 'self_labeled_injection',
    sensitivity: 'high',
    severity: 'high',
  },
  {
    id: 'self-high-3',
    pattern: '(?:DAN|STAN|DUDE)\\s+(?:mode|prompt|jailbreak)',
    flags: 'i',
    category: 'self_labeled_injection',
    sensitivity: 'high',
    severity: 'medium',
  },
  {
    id: 'self-high-4',
    pattern: 'token\\s*(?:smuggling|injection|overflow|stuffing)',
    flags: 'i',
    category: 'self_labeled_injection',
    sensitivity: 'high',
    severity: 'medium',
  },
];


function compile(defs: PatternDef[]): Pattern[] {
  const out: Pattern[] = [];
  for (const def of defs) {
    try {
      out.push({
        id: def.id,
        regex: new RegExp(def.pattern, def.flags),
        category: def.category,
        sensitivity: def.sensitivity,
        severity: def.severity,
      });
    } catch (err) {
      throw new Error(
        `Invalid regex for pattern "${def.id}": ${(err as Error).message}`,
      );
    }
  }
  return out;
}

let compiledPatterns: Pattern[] | null = null;

export function getCompiledPatterns(): Pattern[] {
  compiledPatterns ??= compile(PATTERN_DEFS);
  return compiledPatterns;
}

export const PATTERNS_BY_CATEGORY: Record<
  InjectionCategory,
  { id: string; pattern: string; flags: string; sensitivity: SensitivityLevel; severity: 'low' | 'medium' | 'high' }[]
> = {
  instruction_override: [],
  role_hijacking: [],
  tool_use_direction: [],
  secret_exfiltration: [],
  destructive_commands: [],
  self_labeled_injection: [],
};

for (const def of PATTERN_DEFS) {
  PATTERNS_BY_CATEGORY[def.category].push({
    id: def.id,
    pattern: def.pattern,
    flags: def.flags,
    sensitivity: def.sensitivity,
    severity: def.severity,
  });
}
