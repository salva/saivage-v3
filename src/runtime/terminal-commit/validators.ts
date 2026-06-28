import { isAbsolute, relative, resolve } from 'node:path';
import type { CardLifecycleState, CardRecord } from '../../schemas/index.js';
import { cardLifecycleStateSchema } from '../../schemas/lifecycle.js';

export function pathIsInside(parentPath: string, candidatePath: string): boolean {
  const rel = relative(resolve(parentPath), resolve(candidatePath));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

export function validateTerminalOverlay(_previousCard: CardRecord, nextLifecycle: CardLifecycleState): string[] {
  const diagnostics: string[] = [];
  const parsed = cardLifecycleStateSchema.safeParse(nextLifecycle);
  if (!parsed.success) diagnostics.push(`Invalid lifecycle state: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);

  if (nextLifecycle.status === 'done') {
    if (nextLifecycle.error !== null) diagnostics.push("Done lifecycle must clear error.");
    if (nextLifecycle.completed_at === null) diagnostics.push("Done lifecycle requires completed_at.");
    switch (nextLifecycle.result.kind) {
      case 'executor_success':
      case 'planner_done':
      case 'reviewer_pass':
        break;
    }
  }
  if (nextLifecycle.status === 'failed' && (!nextLifecycle.error || nextLifecycle.completed_at === null)) {
    diagnostics.push('Failed lifecycle requires non-empty error and completed_at.');
  }
  if (nextLifecycle.status === 'failed') {
    switch (nextLifecycle.result.kind) {
      case 'executor_failure':
      case 'planner_failure':
        break;
    }
  }
  if (nextLifecycle.status === 'blocked' && (!nextLifecycle.error || nextLifecycle.completed_at !== null)) {
    diagnostics.push('Blocked lifecycle requires non-empty error and completed_at:null.');
  }
  if (nextLifecycle.status === 'needs_verification') {
    if (nextLifecycle.error !== null) diagnostics.push('Needs-verification lifecycle must clear error.');
    if (nextLifecycle.completed_at !== null) diagnostics.push('Needs-verification lifecycle must keep completed_at:null.');
  }

  return diagnostics;
}
