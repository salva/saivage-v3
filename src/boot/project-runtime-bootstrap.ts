import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Environment } from '../config/index.js';
import {
  publishInitialProjectCard,
  prepareInitialProjectDirectories,
  initializeConversation,
  saivageCardsRoot,
  type InitialProjectCardInput,
  readProjectCardOrAssertInitialPublicationAllowed,
  initializeAndValidateCurrentGeneratedState,
} from '../persistence/index.js';
import { globalAgentSessionId, canonicalValueSha256 } from '../schemas/index.js';
import { runGitWorkflow, nativeGitBranch, qualifyInitialGitDelivery } from '../runtime/git-workflow.js';
import type { ProcessRunner, ManagedProcessScope } from '../runtime/runtime-api.js';
import type { CardGitFacts } from '../schemas/git-source.js';

interface InitialProjectOwner {
  readonly runner: ProcessRunner;
  readonly parentScope: ManagedProcessScope;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export function assertInitialProjectPolicy(projectRoot: string, workflows: Environment['workflows']): void {
  const root = readProjectCardOrAssertInitialPublicationAllowed(projectRoot);
  if (!root) return;
  const policy = workflows.gitPolicy;
  if (policy === null) {
    if (root.git !== null) throw new Error('Retained native root cannot be admitted with Git workflow OFF.');
    return;
  }
  const branch = nativeGitBranch({ namespace: policy.private_ref_namespace, card_id: 'project' });
  if (!root.git || root.git.kind !== 'root' || root.git.policy_digest !== canonicalValueSha256(policy) ||
      root.git.branch_ref !== branch || root.git.parent.branch_ref !== `refs/heads/${policy.delivery_branch}`)
    throw new Error('Retained root source policy does not match commissioned native Git facts.');
}

export function preflightInitialProjectSource(projectRoot: string, workflows: Environment['workflows']): void {
  if (workflows.gitPolicy) qualifyInitialGitDelivery(projectRoot, workflows.gitPolicy);
}

function newProjectRootInput(projectRoot: string): InitialProjectCardInput {
  const title = basename(projectRoot) || 'saivage-project';
  return {
    title,
    bootstrap_content: `# Goal\n\nDefine and execute the ${title} project.\n\n# Instructions\n\nUse this root card as the canonical project objective and planning anchor.\n\n# Acceptance Criteria\n\n- The project objective is captured in the root card bootstrap record.\n- Child work is created under this project card.\n`,
  };
}

export async function publishInitialProjectRuntime(
  projectRoot: string,
  workflows: Environment['workflows'],
  owner: InitialProjectOwner,
): Promise<void> {
  owner.assertCurrent();
  if (readProjectCardOrAssertInitialPublicationAllowed(projectRoot) !== null)
    throw new Error('Initial publication requires an absent root, not retained-state adoption.');
  const policy = workflows.gitPolicy;
  const delivery = policy ? qualifyInitialGitDelivery(projectRoot, policy) : null;
  mkdirSync(saivageCardsRoot(projectRoot), { recursive: true });
  prepareInitialProjectDirectories(projectRoot, workflows.cardTypes.get('project')!);
  initializeConversation(projectRoot, globalAgentSessionId(workflows.analyst.name));
  let git: CardGitFacts | null = null;
  if (policy && delivery) {
    const invocationId = randomUUID();
    const result = await runGitWorkflow({ runner: owner.runner, parentScope: owner.parentScope,
      signal: owner.signal, assertCurrent: () => owner.assertCurrent(), invocationId, cardId: 'project',
      binding: { origin: 'bootstrap' }, request: { step: 'commission', project_root: projectRoot,
        timeout_ms: 120000, source: { source_roots: [...policy.source_roots], excluded_paths: [...policy.excluded_paths] },
        expected: delivery, owner: { namespace: policy.private_ref_namespace, card_id: 'project' }, invocation_id: invocationId } });
    owner.assertCurrent();
    if (result.kind !== 'commissioned') throw new Error(`Initial Git commissioning ${result.kind}; partial initialization is not resumable.`);
    git = { kind: 'root', policy_digest: canonicalValueSha256(policy), ...result.source,
      parent: result.parent, base_oid: result.parent.observed_tip, candidate: null, last_delivery: null, correction: null };
  }
  owner.assertCurrent();
  publishInitialProjectCard(
    projectRoot,
    newProjectRootInput(projectRoot),
    workflows.cardTypes.get('project')!,
    git,
  );
  assertInitialProjectPolicy(projectRoot, workflows);
  initializeAndValidateCurrentGeneratedState(projectRoot, workflows);
}
