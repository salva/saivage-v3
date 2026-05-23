import type { ControlActionSurface, NoteAuthor } from '../schemas/index.js';

export type ActorRole = NoteAuthor;
export type SafetyClass = 'read_only' | 'low' | 'high' | 'destructive' | 'deployment';
export type AuthzVerdict = 'allow' | 'deny' | 'preview_only';

export interface AuthzRule {
  actor: ActorRole | '*';
  surface: ControlActionSurface | '*';
  safety_class: SafetyClass;
  verdict: AuthzVerdict;
}

export const AUTHZ_RULES: AuthzRule[] = [
  { actor: 'user', surface: 'web-chat', safety_class: 'read_only', verdict: 'allow' },
  { actor: 'user', surface: 'web-chat', safety_class: 'low', verdict: 'allow' },
  { actor: 'user', surface: 'web-chat', safety_class: 'high', verdict: 'preview_only' },
  { actor: 'user', surface: 'web-chat', safety_class: 'destructive', verdict: 'preview_only' },
  { actor: 'user', surface: 'web-chat', safety_class: 'deployment', verdict: 'preview_only' },

  { actor: 'user', surface: 'telegram', safety_class: 'read_only', verdict: 'allow' },
  { actor: 'user', surface: 'telegram', safety_class: 'low', verdict: 'allow' },
  { actor: 'user', surface: 'telegram', safety_class: 'high', verdict: 'preview_only' },
  { actor: 'user', surface: 'telegram', safety_class: 'destructive', verdict: 'preview_only' },
  { actor: 'user', surface: 'telegram', safety_class: 'deployment', verdict: 'deny' },

  { actor: 'user', surface: 'rest', safety_class: 'read_only', verdict: 'allow' },
  { actor: 'user', surface: 'rest', safety_class: 'low', verdict: 'allow' },
  { actor: 'user', surface: 'rest', safety_class: 'high', verdict: 'allow' },
  { actor: 'user', surface: 'rest', safety_class: 'destructive', verdict: 'allow' },
  { actor: 'user', surface: 'rest', safety_class: 'deployment', verdict: 'preview_only' },

  { actor: 'user', surface: 'cli', safety_class: 'read_only', verdict: 'allow' },
  { actor: 'user', surface: 'cli', safety_class: 'low', verdict: 'allow' },
  { actor: 'user', surface: 'cli', safety_class: 'high', verdict: 'allow' },
  { actor: 'user', surface: 'cli', safety_class: 'destructive', verdict: 'allow' },
  { actor: 'user', surface: 'cli', safety_class: 'deployment', verdict: 'preview_only' },

  { actor: 'analyst', surface: 'web-chat', safety_class: 'read_only', verdict: 'allow' },
  { actor: 'analyst', surface: 'web-chat', safety_class: 'low', verdict: 'allow' },
  { actor: 'analyst', surface: 'web-chat', safety_class: 'high', verdict: 'preview_only' },
  { actor: 'analyst', surface: 'web-chat', safety_class: 'destructive', verdict: 'preview_only' },
  { actor: 'analyst', surface: 'web-chat', safety_class: 'deployment', verdict: 'deny' },

  { actor: 'analyst', surface: 'telegram', safety_class: 'read_only', verdict: 'allow' },
  { actor: 'analyst', surface: 'telegram', safety_class: 'low', verdict: 'allow' },
  { actor: 'analyst', surface: 'telegram', safety_class: 'high', verdict: 'preview_only' },
  { actor: 'analyst', surface: 'telegram', safety_class: 'destructive', verdict: 'deny' },
  { actor: 'analyst', surface: 'telegram', safety_class: 'deployment', verdict: 'deny' },

  { actor: 'analyst', surface: 'rest', safety_class: 'read_only', verdict: 'allow' },
  { actor: 'analyst', surface: 'rest', safety_class: 'low', verdict: 'allow' },
  { actor: 'analyst', surface: 'rest', safety_class: 'high', verdict: 'preview_only' },
  { actor: 'analyst', surface: 'rest', safety_class: 'destructive', verdict: 'deny' },
  { actor: 'analyst', surface: 'rest', safety_class: 'deployment', verdict: 'deny' },

  { actor: 'analyst', surface: 'cli', safety_class: 'read_only', verdict: 'allow' },
  { actor: 'analyst', surface: 'cli', safety_class: 'low', verdict: 'allow' },
  { actor: 'analyst', surface: 'cli', safety_class: 'high', verdict: 'preview_only' },
  { actor: 'analyst', surface: 'cli', safety_class: 'destructive', verdict: 'preview_only' },
  { actor: 'analyst', surface: 'cli', safety_class: 'deployment', verdict: 'deny' },

  { actor: 'planner', surface: 'runtime', safety_class: 'read_only', verdict: 'allow' },
  { actor: 'planner', surface: 'runtime', safety_class: 'low', verdict: 'allow' },
  { actor: 'planner', surface: 'runtime', safety_class: 'high', verdict: 'deny' },
  { actor: 'planner', surface: 'runtime', safety_class: 'destructive', verdict: 'deny' },
  { actor: 'planner', surface: 'runtime', safety_class: 'deployment', verdict: 'deny' },

  { actor: 'executor', surface: 'runtime', safety_class: 'read_only', verdict: 'allow' },
  { actor: 'executor', surface: 'runtime', safety_class: 'low', verdict: 'allow' },
  { actor: 'executor', surface: 'runtime', safety_class: 'high', verdict: 'deny' },
  { actor: 'executor', surface: 'runtime', safety_class: 'destructive', verdict: 'deny' },
  { actor: 'executor', surface: 'runtime', safety_class: 'deployment', verdict: 'deny' },

  { actor: 'reviewer', surface: 'runtime', safety_class: 'read_only', verdict: 'allow' },
  { actor: 'reviewer', surface: 'runtime', safety_class: 'low', verdict: 'allow' },
  { actor: 'reviewer', surface: 'runtime', safety_class: 'high', verdict: 'deny' },
  { actor: 'reviewer', surface: 'runtime', safety_class: 'destructive', verdict: 'deny' },
  { actor: 'reviewer', surface: 'runtime', safety_class: 'deployment', verdict: 'deny' },

  { actor: 'runtime', surface: 'runtime', safety_class: 'read_only', verdict: 'allow' },
  { actor: 'runtime', surface: 'runtime', safety_class: 'low', verdict: 'allow' },
  { actor: 'runtime', surface: 'runtime', safety_class: 'high', verdict: 'allow' },
  { actor: 'runtime', surface: 'runtime', safety_class: 'destructive', verdict: 'allow' },
  { actor: 'runtime', surface: 'runtime', safety_class: 'deployment', verdict: 'deny' },

  { actor: '*', surface: '*', safety_class: 'read_only', verdict: 'deny' },
  { actor: '*', surface: '*', safety_class: 'low', verdict: 'deny' },
  { actor: '*', surface: '*', safety_class: 'high', verdict: 'deny' },
  { actor: '*', surface: '*', safety_class: 'destructive', verdict: 'deny' },
  { actor: '*', surface: '*', safety_class: 'deployment', verdict: 'deny' },
];

export function evaluateAuthz(input: { actor: ActorRole; surface: ControlActionSurface; safety_class: SafetyClass }): AuthzVerdict {
  for (const rule of AUTHZ_RULES) {
    if ((rule.actor === '*' || rule.actor === input.actor)
      && (rule.surface === '*' || rule.surface === input.surface)
      && rule.safety_class === input.safety_class) {
      return rule.verdict;
    }
  }
  return 'deny';
}
