import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { sanitizedCommandEnv } from './command-policy.js';
import { PublicationOutcomeUnknownError } from '../contracts/index.js';
import type { ManagedProcessScope, ProcessRunner } from './process-runner.js';
import {
  appendCardExecutions,
  type CardExecutionRow,
  type CardExecutionFile,
  type CardNativeExecutionBinding,
  type CardNativeExecutionFinish,
} from '../persistence/card-execution-log.js';
import {
  nativeGitEffectSchema as effect,
  gitOidSchema as oid,
  gitSelectionSchema as selection,
  gitCorrectionTaskSchema as correctionTask,
  nativeGitExecutionBindingSchema,
  gitPreservedSourceSchema as preservedSource,
} from '../schemas/git-source.js';

// Call-local observations, never a durable resume token or source authority.
const rebaseObservation = z.object({ starting_tip: oid, head_tip: oid }).strict();
const namespace = z.string().regex(/^refs\/saivage\/[a-zA-Z0-9/_-]+$/u);
const privateOwner = z
  .object({ namespace, card_id: z.string().regex(/^(?:project|card-[a-z]+(?:-[a-z]+){0,11})$/u) })
  .strict();
const source = z
  .object({ source_roots: z.array(z.string()).min(1), excluded_paths: z.array(z.string()).min(1) })
  .strict();
const common = {
  project_root: z.string().min(1),
  source,
  timeout_ms: z.number().int().min(1).max(120_000),
};
const nativeGitRequestSchema = z.discriminatedUnion('step', [
  z.object({ ...common, step: z.literal('commission'), expected: selection,
    owner: privateOwner, invocation_id: z.string().uuid() }).strict(),
  z
    .object({ ...common, step: z.literal('deliver'), expected: selection, parent: selection })
    .strict(),
  z
    .object({
      ...common,
      step: z.literal('preserveAndReturn'),
      expected: selection,
      parent: selection,
      task: correctionTask.nullable(),
    })
    .strict(),
  z
    .object({
      ...common,
      step: z.literal('captureRebase'),
      expected: selection,
      allow_owned_commits: z.boolean(),
      task: correctionTask,
      owner: privateOwner,
      invocation_id: z.string().uuid(),
    })
    .strict(),
  // Caller must publish the captured source successfully and retain settlement
  // authority before making this separate request. No helper chains these calls.
  z
    .object({
      ...common,
      step: z.literal('restoreRebaseAndReturn'),
      expected: selection,
      allow_owned_commits: z.boolean(),
      rebase_observation: rebaseObservation,
      task: correctionTask,
      preserved_source: preservedSource,
      owner: privateOwner,
      invocation_id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...common,
      step: z.literal('enter'),
      expected: selection,
      owner: privateOwner,
      invocation_id: z.string().uuid(),
      previous: z
        .object({ base_oid: oid, observed_tip: oid, last_delivered_child_tip: oid.nullable() })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      ...common,
      step: z.literal('prepareCandidate'),
      expected: selection,
      base_oid: oid,
      parent: selection,
    })
    .strict(),
  z
    .object({
      ...common,
      step: z.literal('verifyCorrection'),
      expected: selection,
      task: correctionTask,
    })
    .strict(),
  z
    .object({
      ...common,
      step: z.literal('inspect'),
      expected: selection,
      require_clean: z.boolean(),
      parent: selection.optional(),
    })
    .strict(),
  z.object({ ...common, step: z.literal('checkpoint'), expected: selection }).strict(),
  z
    .object({ ...common, step: z.literal('switch'), expected: selection, target: selection })
    .strict(),
]);
export type NativeGitRequest = z.infer<typeof nativeGitRequestSchema>;
const observation = selection
  .extend({
    object_format: z.enum(['sha1', 'sha256']),
    dirty: z.boolean(),
    tracked_paths: z.number().int().nonnegative(),
  })
  .strict();
type NativeGitObservation = z.infer<typeof observation>;
const nativeGitResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('commissioned'), source: selection, parent: selection,
    effects: z.array(effect) }).strict(),
  z
    .object({
      kind: z.literal('delivered'),
      observation,
      child: selection,
      parent_before: oid,
      parent_after: oid,
      effects: z.array(effect),
    })
    .strict(),
  z
    .object({
      kind: z.literal('returned'),
      observation,
      source: selection,
      task: correctionTask.nullable(),
      preserved_source: preservedSource.nullable(),
      artifacts: z.array(z.string()),
      effects: z.array(effect),
    })
    .strict(),
  z
    .object({
      kind: z.literal('captured'),
      rebase_observation: rebaseObservation,
      task: correctionTask,
      preserved_source: preservedSource,
      artifacts: z.array(z.string()),
      effects: z.array(effect),
    })
    .strict(),
  z
    .object({
      kind: z.literal('entered'),
      observation,
      base_oid: oid,
      retained_original_ref: z.string().nullable(),
      effects: z.array(effect),
    })
    .strict(),
  z
    .object({
      kind: z.literal('candidate'),
      observation,
      base_oid: oid,
      parent: selection,
      effects: z.array(effect),
    })
    .strict(),
  z
    .object({
      kind: z.literal('correction-required'),
      observation,
      task: correctionTask,
      effects: z.array(effect),
    })
    .strict(),
  z
    .object({
      kind: z.literal('correction-verified'),
      observation,
      base_oid: oid,
      effects: z.array(effect),
    })
    .strict(),
  z.object({ kind: z.literal('completed'), observation, effects: z.array(effect) }).strict(),
  z
    .object({
      kind: z.literal('refused'),
      reason: z.string().min(1).max(512),
      effects: z.array(effect),
      untouched_parent: selection.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('uncertain'),
      reason: z.string().min(1).max(512),
      effects: z.array(effect),
    })
    .strict(),
]);
export type NativeGitResult = z.infer<typeof nativeGitResultSchema>;

class NativeRefusal extends Error {}
class NativeUncertainty extends Error {}
type SourceLeaf = { mode: string; bytes: Buffer };
type TreeLeaf = { mode: string; oid: string };

interface GitCommandOptions {
  input?: string | Buffer;
  accepted?: readonly number[];
  mutation?: boolean;
  indexPath?: string;
}

/** Call-local domain sequencing; each command is owned by the existing runner. */
class GitWorkflow {
  readonly effects: z.infer<typeof effect>[] = [];
  private mutating = false;
  private readonly root: string;
  private lastStatus = 0;

  constructor(
    private readonly input: NativeGitRequest,
    private readonly command: (
      args: readonly string[],
      options: GitCommandOptions,
    ) => Promise<{ text: string; status: number }>,
    private readonly assertCurrent: () => void,
  ) {
    this.root = realpathSync(input.project_root);
  }

  private current<T>(value: T): T {
    this.assertCurrent();
    return value;
  }

  private async git(args: readonly string[], options: GitCommandOptions = {}): Promise<string> {
    this.assertCurrent();
    if (options.mutation) this.mutating = true;
    const result = this.current(await this.command(args, options));
    this.lastStatus = result.status;
    if (options.mutation) this.mutating = false;
    return result.text;
  }

  private async exactSelection(expected: z.infer<typeof selection>): Promise<void> {
    this.current(await this.git(['check-ref-format', expected.branch_ref]));
    if (
      this.current(
        await this.git(['rev-parse', '--verify', `${expected.branch_ref}^{commit}`]),
      ).trim() !== expected.observed_tip
    )
      throw new NativeRefusal('Exact branch tip no longer matches its source selection.');
  }

  private async switchTo(target: z.infer<typeof selection>): Promise<NativeGitObservation> {
    this.current(await this.exactSelection(target));
    this.current(
      await this.git(
        ['switch', '--no-overwrite-ignore', '--', target.branch_ref.slice('refs/heads/'.length)],
        { mutation: true },
      ),
    );
    this.effects.push('checkout-completed');
    const after = this.current(await this.inspect(target, false));
    if (after.dirty) throw new NativeRefusal('Protected switch left dirty source.');
    return after;
  }

  private async checkpoint(before: NativeGitObservation): Promise<NativeGitObservation> {
    if (!before.dirty) return before;
    this.current(await this.git(['add', '--all', '--', '.'], { mutation: true }));
    this.effects.push('index-normalized');
    const tree = this.current(await this.git(['write-tree'])).trim();
    if (tree !== this.current(await this.git(['rev-parse', 'HEAD^{tree}'])).trim()) {
      this.current(
        await this.git(['commit', '--message', 'Saivage private source checkpoint'], {
          mutation: true,
        }),
      );
      this.effects.push('commit-completed');
    }
    const after = this.current(await this.inspect(before, true));
    if (after.dirty || this.current(await this.git(['rev-parse', 'HEAD^{tree}'])).trim() !== tree)
      throw new NativeRefusal('Checkpoint hooks changed source; return is not certified.');
    return after;
  }

  private async enter(
    input: Extract<NativeGitRequest, { step: 'enter' }>,
  ): Promise<NativeGitResult> {
    const names = nativeGitRefs(input.owner, input.invocation_id);
    this.current(await this.git(['check-ref-format', names.branch_ref]));
    if (input.previous === null) {
      // create-only update: collision fails, never enumerates or adopts a ref.
      this.current(
        await this.git(['update-ref', names.branch_ref, input.expected.observed_tip, ''], {
          mutation: true,
        }),
      );
      this.effects.push('branch-created');
      const after = this.current(
        await this.switchTo({
          branch_ref: names.branch_ref,
          observed_tip: input.expected.observed_tip,
        }),
      );
      return {
        kind: 'entered',
        observation: after,
        base_oid: input.expected.observed_tip,
        retained_original_ref: null,
        effects: [...this.effects],
      };
    }
    const original = { branch_ref: names.branch_ref, observed_tip: input.previous.observed_tip };
    const base = input.previous.last_delivered_child_tip ?? input.previous.base_oid;
    this.current(await this.exactSelection(original));
    this.current(await this.git(['merge-base', '--is-ancestor', base, original.observed_tip]));
    if (
      this.current(
        await this.git(['rev-list', '--min-parents=2', `${base}..${original.observed_tip}`]),
      ).trim()
    )
      throw new NativeRefusal('The original replay range must be linear.');
    this.current(await this.switchTo(original));
    this.current(
      await this.git(['update-ref', names.retention_ref, original.observed_tip, ''], {
        mutation: true,
      }),
    );
    this.effects.push('original-retained');
    if (this.current(await this.inspect(original, false)).dirty)
      throw new NativeRefusal('Retention hooks changed source before replay.');
    // Hooks remain enabled. Their presence prevents certifying an untouched failed
    // replay (a hook can modify the index/worktree independently of Git's merge).
    const hookPath = this.current(await this.git(['rev-parse', '--git-path', 'hooks'])).trim();
    const hookMayWrite = [
      'pre-rebase',
      'post-checkout',
      'post-rewrite',
      'reference-transaction',
      'pre-commit',
      'post-commit',
      'prepare-commit-msg',
      'commit-msg',
    ].some((name) => this.exactPathExists(resolve(this.root, hookPath, name)));
    const mergeAttributes = this.current(
      await this.git(['check-attr', '--all', '-z', '--stdin'], {
        input: this.current(await this.git(['ls-files', '-z'])),
      }),
    ).split('\0');
    const customMerge =
      !!this.current(
        await this.git(['config', '--get-regexp', '^merge\\..*\\.driver$'], {
          accepted: [0, 1],
        }),
      ).trim() ||
      !!this.current(
        await this.git(['config', '--get', 'merge.default'], { accepted: [0, 1] }),
      ).trim() ||
      mergeAttributes.some(
        (value, index) =>
          index % 3 === 1 &&
          value === 'merge' &&
          !['set', 'unset', 'unspecified', 'text', 'binary', 'union'].includes(
            mergeAttributes[index + 1]!,
          ),
      );
    this.current(
      await this.git(
        [
          'rebase',
          '--merge',
          '--no-autostash',
          '--no-update-refs',
          '--no-fork-point',
          '--reapply-cherry-picks',
          '--keep-empty',
          '--empty=keep',
          '--onto',
          input.expected.observed_tip,
          base,
          names.branch_ref.slice('refs/heads/'.length),
        ],
        { mutation: true, accepted: [0, 1] },
      ),
    );
    if (this.lastStatus === 0) {
      this.effects.push('rebase-completed');
      this.current(await this.exactSelection(input.expected));
      const tip = this.current(await this.git(['rev-parse', 'HEAD^{commit}'])).trim();
      const after = this.current(
        await this.inspect({ branch_ref: names.branch_ref, observed_tip: tip }, false),
      );
      this.current(
        await this.git(['merge-base', '--is-ancestor', input.expected.observed_tip, tip]),
      );
      if (after.dirty) throw new NativeRefusal('Rebase left dirty source.');
      return {
        kind: 'entered',
        observation: after,
        base_oid: input.expected.observed_tip,
        retained_original_ref: names.retention_ref,
        effects: [...this.effects],
      };
    }
    const state = join(this.root, '.git', 'rebase-merge');
    if (hookMayWrite || customMerge || !this.exactPathExists(state))
      throw new NativeUncertainty('Failed rebase is not a certified untouched native conflict.');
    const selected = (name: string) => readFileSync(join(state, name), 'utf8').trim();
    if (
      selected('head-name') !== names.branch_ref ||
      selected('orig-head') !== original.observed_tip ||
      selected('onto') !== input.expected.observed_tip ||
      !this.current(await this.git(['ls-files', '--unmerged', '-z'])).length
    )
      throw new NativeUncertainty(
        'Failed rebase identity or conflict does not match the original range.',
      );
    // This helper has admitted no agent or additional writer since the clean
    // switch. Only this exact native conflict with no executable hook path is
    // eligible for the untouched abort; timeout and other failures never reach it.
    this.current(await this.git(['rebase', '--abort'], { mutation: true }));
    this.effects.push('rebase-aborted');
    const after = this.current(await this.inspect(original, false));
    this.current(await this.exactSelection(input.expected));
    if (after.dirty)
      throw new NativeUncertainty('Rebase abort did not restore clean original source.');
    return {
      kind: 'correction-required',
      observation: after,
      task: {
        branch_ref: names.branch_ref,
        base_oid: base,
        original_tip: original.observed_tip,
        onto: input.expected,
        retained_original_ref: names.retention_ref,
      },
      effects: [...this.effects],
    };
  }

  private exactPathExists(path: string): boolean {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private eligible(path: string): boolean {
    const under = (root: string) => root === '.' || path === root || path.startsWith(`${root}/`);
    return (
      this.input.source.source_roots.some(under) && !this.input.source.excluded_paths.some(under)
    );
  }

  async inspect(
    expected: z.infer<typeof selection>,
    allowOwnedCommits: boolean,
    rebaseTask?: z.infer<typeof correctionTask>,
    completedCorrection?: z.infer<typeof correctionTask>,
  ): Promise<NativeGitObservation> {
    this.current(await this.git(['check-ref-format', expected.branch_ref]));
    // Exact metadata paths only; never walk .saivage or Git sibling refs.
    const gitDir = join(this.root, '.git');
    if (!lstatSync(gitDir).isDirectory() || lstatSync(gitDir).isSymbolicLink())
      throw new NativeRefusal('An ordinary project-root checkout is required.');
    if (
      realpathSync(this.current(await this.git(['rev-parse', '--show-toplevel'])).trim()) !==
        this.root ||
      resolve(this.root, this.current(await this.git(['rev-parse', '--git-common-dir'])).trim()) !==
        gitDir
    )
      throw new NativeRefusal('Linked worktrees and non-root checkouts are unsupported.');
    const index = lstatSync(join(gitDir, 'index'));
    if (!index.isFile() || index.isSymbolicLink())
      throw new NativeRefusal('A real ordinary Git index is required.');
    for (const name of [
      'rebase-merge',
      'rebase-apply',
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'BISECT_LOG',
    ])
      if (!(rebaseTask && name === 'rebase-merge') && this.exactPathExists(join(gitDir, name)))
        throw new NativeRefusal('A native Git operation is already active.');
    for (const name of ['core.sparseCheckout', 'core.sparseCheckoutCone'])
      if (
        this.current(
          await this.git(['config', '--bool', '--get', name], { accepted: [0, 1] }),
        ).trim() === 'true'
      )
        throw new NativeRefusal('Sparse checkouts are unsupported.');
    if (
      this.current(
        await this.git(['config', '--get', 'core.fsmonitor'], { accepted: [0, 1] }),
      ).trim()
    )
      throw new NativeRefusal(
        'Filesystem monitor hooks are unsupported for synchronous admission.',
      );
    if (this.current(await this.git(['rev-parse', '--shared-index-path'])).trim())
      throw new NativeRefusal('Split indexes are unsupported.');
    for (const name of ['core.filemode', 'core.symlinks'])
      if (
        this.current(
          await this.git(['config', '--bool', '--get', name], { accepted: [0, 1] }),
        ).trim() === 'false'
      )
        throw new NativeRefusal('Git must preserve executable bits and symlinks.');
    const autocrlf = this.current(
      await this.git(['config', '--get', 'core.autocrlf'], { accepted: [0, 1] }),
    ).trim();
    if (autocrlf !== '' && autocrlf !== 'false')
      throw new NativeRefusal('Git line-ending transformations are unsupported.');
    const objectFormat = this.current(await this.git(['rev-parse', '--show-object-format'])).trim();
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256')
      throw new NativeRefusal('Unsupported Git object format.');
    if (rebaseTask)
      this.current(await this.identifyRebase(rebaseTask, expected, allowOwnedCommits));
    const branch = rebaseTask
      ? rebaseTask.branch_ref
      : this.current(await this.git(['symbolic-ref', '--quiet', 'HEAD'])).trim();
    const tip = this.current(
      await this.git([
        'rev-parse',
        '--verify',
        `${rebaseTask ? rebaseTask.branch_ref : 'HEAD'}^{commit}`,
      ]),
    ).trim();
    if (branch !== expected.branch_ref)
      throw new NativeRefusal('Selected branch does not match its owner.');
    if (tip !== expected.observed_tip && !completedCorrection) {
      if (!allowOwnedCommits)
        throw new NativeRefusal('Selected tip does not match its published observation.');
      this.current(await this.git(['merge-base', '--is-ancestor', expected.observed_tip, tip]));
      if (
        this.current(
          await this.git(['rev-list', '--min-parents=2', `${expected.observed_tip}..${tip}`]),
        ).trim()
      )
        throw new NativeRefusal('Owned source advancement must be linear.');
    }
    const tracked = this.current(await this.git(['ls-files', '--stage', '-z']))
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const match = /^(\d{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/u.exec(entry);
        if (!match || (!rebaseTask && match[3] !== '0'))
          throw new NativeRefusal('Unmerged source index is unsupported for this step.');
        if (!['100644', '100755', '120000'].includes(match[1]!))
          throw new NativeRefusal('Submodules or unsupported source modes are present.');
        return match[4]!;
      });
    const flags = this.current(await this.git(['ls-files', '-v', '-z']))
      .split('\0')
      .filter(Boolean);
    if (flags.some((entry) => entry[0] !== 'H' && !(rebaseTask && entry[0] === 'M')))
      throw new NativeRefusal('Skip-worktree and assume-unchanged index entries are unsupported.');
    // Establish the generated-root ignore boundary before Git can enumerate new
    // source. Index names are canonical Git source selections, not a disk scan.
    this.current(await this.git(['check-ignore', '--quiet', '--no-index', '--', '.saivage/']));
    const added = this.current(await this.git(['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean);
    const paths = [
      ...new Set([
        ...tracked,
        ...added,
        ...(rebaseTask ? this.current(await this.treeLeaves(tip)).keys() : []),
      ]),
    ];
    if (paths.some((path) => !this.eligible(path)))
      throw new NativeRefusal(
        'Tracked or nonignored source lies outside the commissioned source selection.',
      );
    this.sourceLeaves(new Set(paths));
    if (paths.length) {
      const attributes = this.current(
        await this.git(['check-attr', '--all', '-z', '--stdin'], {
          input: `${paths.join('\0')}\0`,
        }),
      ).split('\0');
      for (let index = 0; index + 2 < attributes.length; index += 3)
        if (
          ['filter', 'working-tree-encoding', 'ident', 'text', 'eol'].includes(
            attributes[index + 1]!,
          ) &&
          !['unset', 'unspecified'].includes(attributes[index + 2]!)
        )
          throw new NativeRefusal('Selected source uses unsupported Git transformations.');
    }
    const dirty =
      this.current(
        await this.git([
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--ignore-submodules=none',
        ]),
      ).length !== 0;
    return observation.parse({
      branch_ref: branch,
      observed_tip: tip,
      object_format: objectFormat,
      dirty,
      tracked_paths: tracked.length,
    });
  }

  private async identifyRebase(
    task: z.infer<typeof correctionTask>,
    expected: z.infer<typeof selection>,
    allowOwnedCommits: boolean,
  ): Promise<z.infer<typeof rebaseObservation>> {
    if (expected.branch_ref !== task.branch_ref)
      throw new NativeRefusal('Current source owner differs from the correction branch.');
    this.current(await this.git(['check-ref-format', expected.branch_ref]));
    const nativeStart = this.current(
      await this.git(['rev-parse', '--verify', `${expected.branch_ref}^{commit}`]),
    ).trim();
    if (nativeStart !== expected.observed_tip) {
      if (!allowOwnedCommits)
        throw new NativeRefusal(
          'Native starting tip differs from published source without active ownership.',
        );
      this.current(
        await this.git(['merge-base', '--is-ancestor', expected.observed_tip, nativeStart]),
      );
      if (
        this.current(
          await this.git([
            'rev-list',
            '--min-parents=2',
            `${expected.observed_tip}..${nativeStart}`,
          ]),
        ).trim()
      )
        throw new NativeRefusal('Native starting tip is not a linear owned advancement.');
    }
    this.current(await this.exactSelection(task.onto));
    if (
      this.current(
        await this.git(['rev-parse', '--verify', `${task.retained_original_ref}^{commit}`]),
      ).trim() !== task.original_tip
    )
      throw new NativeRefusal('Retained original differs from the correction task.');
    const state = join(this.root, '.git', 'rebase-merge');
    if (!this.exactPathExists(state))
      throw new NativeRefusal('The exact correction rebase is not active.');
    for (const [name, value] of [
      ['head-name', task.branch_ref],
      ['orig-head', nativeStart],
      ['onto', task.onto.observed_tip],
    ])
      if (readFileSync(join(state, name!), 'utf8').trim() !== value)
        throw new NativeRefusal('Native rebase identity differs from the correction task.');
    this.current(await this.git(['merge-base', '--is-ancestor', task.base_oid, task.original_tip]));
    const headTip = this.current(await this.git(['rev-parse', 'HEAD^{commit}'])).trim();
    this.current(await this.git(['merge-base', '--is-ancestor', task.onto.observed_tip, headTip]));
    return { starting_tip: nativeStart, head_tip: headTip };
  }

  private captureIndex(owner: z.infer<typeof privateOwner>, invocationId: string): string {
    const parent = join(this.root, '.saivage', 'work', 'cards', owner.card_id, 'tmp');
    mkdirSync(parent, { recursive: true });
    const directory = join(parent, `native-git-${invocationId}`);
    mkdirSync(directory);
    this.effects.push('capture-work-allocated');
    return join(directory, 'index');
  }

  private async eligibleTree(tree: string): Promise<void> {
    const paths: string[] = [];
    for (const entry of this.current(await this.git(['ls-tree', '-r', '-z', tree]))
      .split('\0')
      .filter(Boolean)) {
      const match = /^(100644|100755|120000) blob [a-f0-9]+\t([\s\S]+)$/u.exec(entry);
      if (!match || !this.eligible(match[2]!))
        throw new NativeRefusal('Selected tree has unsupported or excluded source paths.');
      paths.push(match[2]!);
    }
    if (paths.length) {
      const attributes = this.current(
        await this.git(['check-attr', `--source=${tree}`, '--all', '-z', '--stdin'], {
          input: `${paths.join('\0')}\0`,
        }),
      ).split('\0');
      for (let index = 0; index + 2 < attributes.length; index += 3)
        if (
          ['filter', 'working-tree-encoding', 'ident', 'text', 'eol'].includes(
            attributes[index + 1]!,
          ) &&
          !['unset', 'unspecified'].includes(attributes[index + 2]!)
        )
          throw new NativeRefusal('Selected tree uses unsupported source transformations.');
    }
  }

  private async treeLeaves(tree: string): Promise<Map<string, TreeLeaf>> {
    const leaves = new Map<string, TreeLeaf>();
    for (const entry of this.current(await this.git(['ls-tree', '-r', '-z', tree]))
      .split('\0')
      .filter(Boolean)) {
      const match = /^(100644|100755|120000) blob ([a-f0-9]+)\t([\s\S]+)$/u.exec(entry);
      if (!match || !this.eligible(match[3]!))
        throw new NativeRefusal('Selected tree has unsupported or excluded leaves.');
      leaves.set(match[3]!, { mode: match[1]!, oid: match[2]! });
    }
    return leaves;
  }

  private async sourceMembership(start: string): Promise<Set<string>> {
    return new Set([
      ...this.current(await this.treeLeaves(start)).keys(),
      ...this.current(await this.git(['ls-files', '-z']))
        .split('\0')
        .filter(Boolean),
      ...this.current(await this.git(['ls-files', '--others', '--exclude-standard', '-z']))
        .split('\0')
        .filter(Boolean),
    ]);
  }

  // Never traverse a leaf (especially a symlink) to inspect an old descendant.
  private sourceLeaves(names: Set<string>): Map<string, SourceLeaf> {
    if ([...names].some((name) => !this.eligible(name)))
      throw new NativeRefusal('Source membership includes an excluded path.');
    const leaves = new Map<string, SourceLeaf>();
    for (const name of names) {
      const parts = name.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        let stat;
        try {
          stat = lstatSync(join(this.root, prefix));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
          throw error;
        }
        if (stat.isDirectory()) continue;
        if (i < parts.length) {
          if (!names.has(prefix))
            throw new NativeRefusal('Unselected leaf obstructs selected source.');
          break;
        }
        if (!stat.isFile() && !stat.isSymbolicLink())
          throw new NativeRefusal('Unsupported source leaf.');
        leaves.set(name, {
          mode: stat.isSymbolicLink() ? '120000' : stat.mode & 0o100 ? '100755' : '100644',
          bytes: stat.isSymbolicLink()
            ? readlinkSync(join(this.root, name), { encoding: 'buffer' })
            : readFileSync(join(this.root, name)),
        });
      }
    }
    return leaves;
  }

  private matchesBlob(actual: SourceLeaf, expected: TreeLeaf): boolean {
    return (
      actual.mode === expected.mode &&
      createHash(expected.oid.length === 64 ? 'sha256' : 'sha1')
        .update(`blob ${actual.bytes.length}\0`)
        .update(actual.bytes)
        .digest('hex') === expected.oid
    );
  }

  private async sourceMatchesTree(tree: string, names: Set<string>): Promise<void> {
    const expected = this.current(await this.treeLeaves(tree));
    const actual = this.sourceLeaves(names);
    if (
      actual.size !== expected.size ||
      [...expected].some(
        ([name, leaf]) => !actual.has(name) || !this.matchesBlob(actual.get(name)!, leaf),
      )
    )
      throw new NativeRefusal('Actual source differs from selected snapshot.');
  }

  private async indexMatchesTree(tree: string): Promise<void> {
    const expected = this.current(await this.treeLeaves(tree));
    const entries = this.current(await this.git(['ls-files', '--stage', '-z']))
      .split('\0')
      .filter(Boolean);
    if (
      entries.length !== expected.size ||
      entries.some((entry) => {
        const match = /^(100644|100755|120000) ([a-f0-9]+) 0\t([\s\S]+)$/u.exec(entry);
        const leaf = match && expected.get(match[3]!);
        return !leaf || leaf.mode !== match![1] || leaf.oid !== match![2];
      })
    )
      throw new NativeRefusal('Actual real index differs from selected tree.');
  }

  // Only enumerate containers that an exact selected leaf transition threatens.
  // Classify names before metadata/content, and never descend unknown subtrees.
  private async transitionObstructions(
    start: string,
    snapshot: string,
    membership: Set<string>,
  ): Promise<void> {
    const a = this.current(await this.treeLeaves(start)),
      b = this.current(await this.treeLeaves(snapshot));
    const selected = new Set([...a.keys(), ...b.keys()]);
    const prefixes = new Set<string>();
    for (const name of selected) {
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join('/'));
    }
    const roots = [...new Set([...selected, ...membership])].sort((x, y) => x.length - y.length);
    const checked: string[] = [];
    const visit = (name: string): void => {
      if (!this.eligible(name) || (!selected.has(name) && !prefixes.has(name)))
        throw new NativeRefusal('Uncaptured source obstructs a native transition.');
      const stat = lstatSync(join(this.root, name));
      if (stat.isDirectory()) {
        for (const child of readdirSync(join(this.root, name))) visit(`${name}/${child}`);
      } else {
        const leaf = this.sourceLeaves(new Set([name])).get(name);
        if (
          !leaf ||
          ![a.get(name), b.get(name)].some((entry) => entry && this.matchesBlob(leaf, entry))
        )
          throw new NativeRefusal('Transition leaf is not selected native source.');
      }
    };
    for (const name of roots) {
      if (checked.some((root) => name === root || name.startsWith(`${root}/`))) continue;
      const parts = name.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        let stat;
        try {
          stat = lstatSync(join(this.root, prefix));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
          throw error;
        }
        if (!stat.isDirectory() || i === parts.length) {
          visit(prefix);
          checked.push(prefix);
          break;
        }
      }
    }
  }

  private async preservation(
    input: Extract<NativeGitRequest, { step: 'captureRebase' | 'restoreRebaseAndReturn' }>,
  ): Promise<NativeGitResult> {
    const task = input.task;
    const names = nativeGitRefs(input.owner, input.invocation_id);
    if (names.branch_ref !== task.branch_ref)
      throw new NativeRefusal('Correction task does not belong to this private source owner.');
    const native = this.current(
      await this.identifyRebase(task, input.expected, input.allow_owned_commits),
    );
    const sourceTip = native.head_tip;
    this.current(await this.inspect(input.expected, input.allow_owned_commits, task));
    this.current(await this.eligibleTree(native.starting_tip));
    if (input.step === 'restoreRebaseAndReturn') {
      const snapshot = input.preserved_source;
      if (
        native.starting_tip !== input.rebase_observation.starting_tip ||
        native.head_tip !== input.rebase_observation.head_tip ||
        !snapshot.ref.startsWith(`${input.owner.namespace}/preserved/${input.owner.card_id}/`) ||
        sourceTip !== snapshot.source_tip ||
        this.current(
          await this.git(['rev-parse', '--verify', `${snapshot.ref}^{commit}`]),
        ).trim() !== snapshot.oid
      )
        throw new NativeRefusal('Published snapshot selection does not match the held source.');
      this.current(await this.eligibleTree(snapshot.oid));
    }
    const indexPath = this.captureIndex(input.owner, input.invocation_id);
    if (input.step === 'captureRebase') {
      const leaves = this.sourceLeaves(
        this.current(await this.sourceMembership(native.starting_tip)),
      );
      this.current(await this.git(['read-tree', '--empty'], { indexPath, mutation: true }));
      const entries: string[] = [];
      for (const [name, leaf] of leaves) {
        const blob = this.current(
          await this.git(['hash-object', '-w', '--stdin'], { input: leaf.bytes, mutation: true }),
        ).trim();
        entries.push(`${leaf.mode} ${blob} 0\t${name}\0`);
      }
      this.current(
        await this.git(['update-index', '-z', '--index-info'], {
          indexPath,
          mutation: true,
          input: entries.join(''),
        }),
      );
      const tree = this.current(
        await this.git(['write-tree'], { indexPath, mutation: true }),
      ).trim();
      this.current(await this.eligibleTree(tree));
      this.current(
        await this.sourceMatchesTree(
          tree,
          this.current(await this.sourceMembership(native.starting_tip)),
        ),
      );
      const snapshotOid = this.current(
        await this.git(
          ['commit-tree', tree, '-p', sourceTip, '-m', 'Saivage unfinished resolution source'],
          { mutation: true },
        ),
      ).trim();
      const snapshotRef = `${input.owner.namespace}/preserved/${input.owner.card_id}/${input.invocation_id}`;
      this.current(
        await this.git(['update-ref', snapshotRef, snapshotOid, ''], { mutation: true }),
      );
      this.effects.push('source-snapshot-retained');
      this.current(
        await this.sourceMatchesTree(
          tree,
          this.current(await this.sourceMembership(native.starting_tip)),
        ),
      );
      const after = this.current(
        await this.identifyRebase(task, input.expected, input.allow_owned_commits),
      );
      if (after.starting_tip !== native.starting_tip || after.head_tip !== native.head_tip)
        throw new NativeRefusal('Source moved during capture.');
      return {
        kind: 'captured',
        rebase_observation: native,
        task,
        preserved_source: {
          ref: snapshotRef,
          oid: snapshotOid,
          source_tip: sourceTip,
          kind: 'unfinished-resolution',
        },
        artifacts: [indexPath],
        effects: [...this.effects],
      };
    }
    const snapshot = input.preserved_source;
    // Fresh verification index, never the capture helper's artifact as authority.
    this.current(await this.git(['read-tree', snapshot.oid], { indexPath, mutation: true }));
    const membership = this.current(await this.sourceMembership(native.starting_tip));
    this.current(await this.sourceMatchesTree(snapshot.oid, membership));
    this.current(await this.transitionObstructions(native.starting_tip, snapshot.oid, membership));
    const snapshotTree = this.current(
      await this.git(['rev-parse', `${snapshot.oid}^{tree}`]),
    ).trim();
    this.current(await this.git(['read-tree', '--reset', '-i', snapshotTree], { mutation: true }));
    this.effects.push('index-normalized');
    // All hook-capable writes above are complete. No refresh/write-tree/private
    // index work may follow these final actual-use observations before abort.
    this.current(await this.indexMatchesTree(snapshot.oid));
    const finalNative = this.current(
      await this.identifyRebase(task, input.expected, input.allow_owned_commits),
    );
    if (
      finalNative.starting_tip !== native.starting_tip ||
      finalNative.head_tip !== native.head_tip ||
      this.current(await this.git(['rev-parse', '--verify', `${snapshot.ref}^{commit}`])).trim() !==
        snapshot.oid
    )
      throw new NativeRefusal('Source identity changed after index normalization.');
    this.current(
      await this.sourceMatchesTree(
        snapshot.oid,
        this.current(await this.sourceMembership(native.starting_tip)),
      ),
    );
    this.current(await this.transitionObstructions(native.starting_tip, snapshot.oid, membership));
    this.current(await this.git(['rebase', '--abort'], { mutation: true }));
    this.effects.push('rebase-aborted');
    this.current(
      await this.inspect({ branch_ref: task.branch_ref, observed_tip: native.starting_tip }, false),
    );
    this.current(await this.indexMatchesTree(native.starting_tip));
    this.current(
      await this.sourceMatchesTree(
        native.starting_tip,
        new Set(this.current(await this.treeLeaves(native.starting_tip)).keys()),
      ),
    );
    const union = new Set([
      ...this.current(await this.treeLeaves(native.starting_tip)).keys(),
      ...this.current(await this.treeLeaves(snapshot.oid)).keys(),
    ]);
    for (const name of this.current(await this.sourceMembership(native.starting_tip)))
      if (!union.has(name)) throw new NativeRefusal('Abort introduced unselected source.');
    this.current(await this.transitionObstructions(native.starting_tip, snapshot.oid, membership));
    // Native no-overlay restore updates the real index/path union, including
    // deletion of N paths absent from the snapshot. No manual untracked deletion.
    // A selected replacement leaf covers its selected old descendants. Passing
    // both to Git rejects the now-hidden descendant as an unmatched pathspec.
    // The bounded check above established every occupied descendant is selected.
    const restorePaths = [...union].filter(
      (name) => ![...union].some((prefix) => prefix !== name && name.startsWith(`${prefix}/`)),
    );
    this.current(
      await this.git(
        [
          '--literal-pathspecs',
          'restore',
          '--source',
          snapshot.oid,
          '--no-overlay',
          '--staged',
          '--worktree',
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        {
          mutation: true,
          input: `${restorePaths.join('\0')}\0`,
        },
      ),
    );
    this.effects.push('source-restored');
    const checkpoint = this.current(
      await this.checkpoint(
        this.current(
          await this.inspect(
            { branch_ref: task.branch_ref, observed_tip: native.starting_tip },
            false,
          ),
        ),
      ),
    );
    if (
      this.current(await this.git(['rev-parse', 'HEAD^{tree}'])).trim() !==
      this.current(await this.git(['rev-parse', `${snapshot.oid}^{tree}`])).trim()
    )
      throw new NativeUncertainty('Restored checkpoint differs from the preserved source.');
    const parent = this.current(await this.switchTo(task.onto));
    return {
      kind: 'returned',
      observation: parent,
      source: { branch_ref: checkpoint.branch_ref, observed_tip: checkpoint.observed_tip },
      task,
      preserved_source: snapshot,
      artifacts: [indexPath],
      effects: [...this.effects],
    };
  }

  async run(): Promise<NativeGitResult> {
    let untouchedParent: z.infer<typeof selection> | undefined;
    try {
      const input = this.input;
      if (input.step === 'captureRebase' || input.step === 'restoreRebaseAndReturn')
        return this.current(await this.preservation(input));
      const before = this.current(
        await this.inspect(
          input.expected,
          input.step === 'checkpoint' ||
            input.step === 'prepareCandidate' ||
            input.step === 'preserveAndReturn',
          undefined,
          input.step === 'verifyCorrection' ? input.task : undefined,
        ),
      );
      if (input.step === 'commission') {
        if (before.dirty) throw new NativeRefusal('Commissioning requires clean delivery source.');
        const branch = nativeGitRefs(input.owner, input.invocation_id).branch_ref;
        this.current(await this.git(['check-ref-format', branch]));
        this.current(await this.git(['show-ref', '--verify', '--quiet', branch], { accepted: [0, 1] }));
        if (this.lastStatus !== 1) throw new NativeRefusal('Commissioning private ref already exists.');
        this.current(await this.git(['update-ref', branch, input.expected.observed_tip, ''], { mutation: true }));
        this.effects.push('branch-created');
        const selected = { branch_ref: branch, observed_tip: input.expected.observed_tip };
        this.current(await this.exactSelection(selected));
        const after = this.current(await this.inspect(input.expected, false));
        if (after.dirty) throw new NativeRefusal('Commissioning hooks changed delivery source.');
        return { kind: 'commissioned', source: selected, parent: input.expected, effects: [...this.effects] };
      }
      if (input.step === 'deliver') {
        if (before.dirty)
          throw new NativeRefusal('Accepted source is dirty; delivery cannot checkpoint it.');
        this.current(await this.exactSelection(input.parent));
        this.current(
          await this.git([
            'merge-base',
            '--is-ancestor',
            input.parent.observed_tip,
            input.expected.observed_tip,
          ]),
        );
        const acceptedTree = this.current(
          await this.git(['rev-parse', `${input.expected.observed_tip}^{tree}`]),
        ).trim();
        this.current(await this.switchTo(input.parent));
        this.current(await this.exactSelection(input.expected));
        this.current(
          await this.git(
            [
              'merge',
              '--squash',
              '--no-overwrite-ignore',
              '--no-edit',
              input.expected.observed_tip,
            ],
            { mutation: true },
          ),
        );
        this.effects.push('squash-completed');
        if (
          this.current(await this.git(['write-tree'], { mutation: true })).trim() !== acceptedTree
        )
          throw new NativeRefusal('Squash did not materialize the accepted source tree.');
        this.current(await this.inspect(input.parent, false));
        this.current(await this.git(['diff-files', '--quiet', '--']));
        if (
          this.current(await this.git(['ls-files', '--others', '--exclude-standard', '-z'])).length
        )
          throw new NativeRefusal('Delivery has unstaged new source after squash.');
        // Commit only the real squash index. Never turn post-acceptance dirt
        // into a new candidate via the ordinary checkpoint/add-all path.
        if (this.current(await this.git(['rev-parse', 'HEAD^{tree}'])).trim() !== acceptedTree) {
          this.current(
            await this.git(['commit', '--message', 'Saivage accepted source delivery'], {
              mutation: true,
            }),
          );
          this.effects.push('commit-completed');
        }
        const committed = this.current(await this.inspect(input.parent, true));
        this.current(await this.exactSelection(input.expected));
        if (committed.dirty) throw new NativeRefusal('Delivery left dirty source.');
        if (this.current(await this.git(['rev-parse', 'HEAD^{tree}'])).trim() !== acceptedTree)
          throw new NativeRefusal('Delivery hooks changed the accepted source.');
        return {
          kind: 'delivered',
          observation: committed,
          child: input.expected,
          parent_before: input.parent.observed_tip,
          parent_after: committed.observed_tip,
          effects: [...this.effects],
        };
      }
      if (input.step === 'preserveAndReturn') {
        this.current(await this.exactSelection(input.parent));
        if (
          input.task &&
          (input.task.branch_ref !== input.expected.branch_ref ||
            input.task.onto.branch_ref !== input.parent.branch_ref ||
            input.task.onto.observed_tip !== input.parent.observed_tip)
        )
          throw new NativeRefusal('Return target differs from the pending correction task.');
        const saved = this.current(await this.checkpoint(before));
        const returned = this.current(await this.switchTo(input.parent));
        return {
          kind: 'returned',
          observation: returned,
          source: { branch_ref: saved.branch_ref, observed_tip: saved.observed_tip },
          task: input.task,
          preserved_source: null,
          artifacts: [],
          effects: [...this.effects],
        };
      }
      if (input.step === 'enter') {
        if (before.dirty)
          throw new NativeRefusal('Source entry requires a clean exact parent selection.');
        untouchedParent = input.expected;
        return this.current(await this.enter(input));
      }
      if (input.step === 'prepareCandidate') {
        this.current(await this.exactSelection(input.parent));
        if (input.base_oid !== input.parent.observed_tip)
          throw new NativeRefusal('Candidate base differs from the current parent source.');
        this.current(
          await this.git(['merge-base', '--is-ancestor', input.base_oid, before.observed_tip]),
        );
        const after = this.current(await this.checkpoint(before));
        this.current(await this.exactSelection(input.parent));
        return {
          kind: 'candidate',
          observation: after,
          base_oid: input.base_oid,
          parent: input.parent,
          effects: [...this.effects],
        };
      }
      if (input.step === 'verifyCorrection') {
        if (before.dirty || before.branch_ref !== input.task.branch_ref)
          throw new NativeRefusal('Correction requires clean source on the exact task branch.');
        this.current(await this.exactSelection(input.task.onto));
        if (
          this.current(
            await this.git([
              'rev-parse',
              '--verify',
              `${input.task.retained_original_ref}^{commit}`,
            ]),
          ).trim() !== input.task.original_tip
        )
          throw new NativeRefusal('Correction original retention no longer matches the task.');
        this.current(
          await this.git([
            'merge-base',
            '--is-ancestor',
            input.task.base_oid,
            input.task.original_tip,
          ]),
        );
        this.current(
          await this.git([
            'merge-base',
            '--is-ancestor',
            input.task.onto.observed_tip,
            before.observed_tip,
          ]),
        );
        if (
          this.current(
            await this.git([
              'rev-list',
              '--min-parents=2',
              `${input.task.onto.observed_tip}..${before.observed_tip}`,
            ]),
          ).trim()
        )
          throw new NativeRefusal('Corrected source must have a linear owned range.');
        return {
          kind: 'correction-verified',
          observation: before,
          base_oid: input.task.onto.observed_tip,
          effects: [],
        };
      }
      if (input.step === 'inspect') {
        if (input.parent) this.current(await this.exactSelection(input.parent));
        if (input.require_clean && before.dirty)
          throw new NativeRefusal('Selected source is dirty.');
        return { kind: 'completed', observation: before, effects: [] };
      }
      if (input.step === 'checkpoint') {
        const after = this.current(await this.checkpoint(before));
        return { kind: 'completed', observation: after, effects: [...this.effects] };
      }
      if (before.dirty) throw new NativeRefusal('Protected switch requires clean selected source.');
      const after = this.current(await this.switchTo(input.target));
      return { kind: 'completed', observation: after, effects: [...this.effects] };
    } catch (error) {
      if (!(error instanceof NativeRefusal) && !(error instanceof NativeUncertainty)) throw error;
      return {
        kind: error instanceof NativeUncertainty || this.mutating ? 'uncertain' : 'refused',
        reason: error.message,
        effects: [...this.effects],
        ...(!(error instanceof NativeUncertainty) && !this.mutating && untouchedParent
          ? { untouched_parent: untouchedParent }
          : {}),
      };
    }
  }
}

function readonlyGitQueries(root: string) {
  const deadline = performance.now() + 5000;
  return (args: string[], accepted = [0], input?: string): string => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new Error('Git source admission deadline expired.');
    const result = spawnSync('git', ['--no-optional-locks', '--no-lazy-fetch', ...args], {
      cwd: root,
      env: { ...sanitizedCommandEnv(), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      timeout: remaining,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
      input,
    });
    if (
      result.error ||
      result.signal ||
      result.status === null ||
      !accepted.includes(result.status)
    )
      throw new Error('Git source admission query failed.');
    return result.stdout;
  };
}

export function qualifyInitialGitDelivery(projectRoot: string, policy: {
  readonly delivery_branch: string;
  readonly private_ref_namespace: string;
  readonly source_roots: readonly string[];
  readonly excluded_paths: readonly string[];
}): z.infer<typeof selection> {
  const root = realpathSync(projectRoot);
  const query = readonlyGitQueries(root);
  const delivery = selection.parse({ branch_ref: `refs/heads/${policy.delivery_branch}`,
    observed_tip: query(['rev-parse', '--verify', `refs/heads/${policy.delivery_branch}^{commit}`]).trim() });
  assertCleanGitDelivery(root, delivery, policy);
  const branch = nativeGitBranch({ namespace: policy.private_ref_namespace, card_id: 'project' });
  if (query(['rev-parse', '--verify', '--quiet', branch], [0, 1]).trim())
    throw new Error('Initial Git private ref already exists; use separately configured fresh provisioning. No ref is adopted or removed.');
  return delivery;
}

/** Final global file admission: synchronous, read-only, and never source adoption. */
export function assertCleanGitDelivery(
  projectRoot: string,
  expected: z.infer<typeof selection>,
  sourcePolicy: {
    readonly source_roots: readonly string[];
    readonly excluded_paths: readonly string[];
  },
): void {
  const root = realpathSync(projectRoot);
  const query = readonlyGitQueries(root);
  const metadata = join(root, '.git');
  if (!lstatSync(metadata).isDirectory() || lstatSync(metadata).isSymbolicLink())
    throw new Error('Git source admission requires an ordinary checkout.');
  for (const name of [
    'rebase-merge',
    'rebase-apply',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
  ]) {
    try {
      lstatSync(join(metadata, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('Git source admission refuses an active native operation.');
  }
  if (
    realpathSync(query(['rev-parse', '--show-toplevel']).trim()) !== root ||
    resolve(root, query(['rev-parse', '--git-common-dir']).trim()) !== metadata
  )
    throw new Error('Git source admission requires the commissioned root checkout.');
  if (query(['config', '--get', 'core.fsmonitor'], [0, 1]).trim())
    throw new Error('Git source admission refuses filesystem monitor hooks.');
  for (const name of ['core.sparseCheckout', 'core.sparseCheckoutCone'])
    if (query(['config', '--bool', '--get', name], [0, 1]).trim() === 'true')
      throw new Error('Git source admission refuses sparse checkouts.');
  for (const name of ['core.filemode', 'core.symlinks'])
    if (query(['config', '--bool', '--get', name], [0, 1]).trim() === 'false')
      throw new Error('Git source admission requires native modes and symlinks.');
  const autocrlf = query(['config', '--get', 'core.autocrlf'], [0, 1]).trim();
  if (autocrlf && autocrlf !== 'false')
    throw new Error('Git source admission refuses transformations.');
  if (
    query(['symbolic-ref', '--quiet', 'HEAD']).trim() !== expected.branch_ref ||
    query(['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== expected.observed_tip
  )
    throw new Error('Global source effects require the exact commissioned delivery selection.');
  const index = lstatSync(join(metadata, 'index'));
  if (
    !index.isFile() ||
    index.isSymbolicLink() ||
    query(['rev-parse', '--shared-index-path']).trim()
  )
    throw new Error('Git source admission requires an ordinary real index.');
  const format = query(['rev-parse', '--show-object-format']).trim();
  if (format !== 'sha1' && format !== 'sha256') throw new Error('Unsupported Git object format.');
  const entries = query(['ls-files', '--stage', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = /^(100644|100755|120000) ([a-f0-9]+) 0\t([\s\S]+)$/u.exec(entry);
      if (!match)
        throw new Error('Git source admission refuses unsupported or unmerged index entries.');
      return { mode: match[1]!, oid: match[2]!, path: match[3]! };
    });
  if (
    entries.some(
      (entry) =>
        sourcePolicy.excluded_paths.some(
          (path) => entry.path === path || entry.path.startsWith(`${path}/`),
        ) ||
        !sourcePolicy.source_roots.some(
          (path) => path === '.' || entry.path === path || entry.path.startsWith(`${path}/`),
        ),
    )
  )
    throw new Error('Git source admission refuses tracked paths outside commissioned source.');
  if (
    query(['ls-files', '-v', '-z'])
      .split('\0')
      .filter(Boolean)
      .some((entry) => entry[0] !== 'H')
  )
    throw new Error('Git source admission refuses hidden index entries.');
  const tree = query(['ls-tree', '-r', '-z', expected.observed_tip]).split('\0').filter(Boolean);
  if (
    tree.length !== entries.length ||
    entries.some((entry, index) => tree[index] !== `${entry.mode} blob ${entry.oid}\t${entry.path}`)
  )
    throw new Error('Global source effects require a clean real index.');
  if (entries.length) {
    const attrs = query(
      ['check-attr', '--all', '-z', '--stdin'],
      [0],
      entries.map((entry) => entry.path).join('\0') + '\0',
    ).split('\0');
    for (let i = 0; i + 2 < attrs.length; i += 3)
      if (
        ['filter', 'working-tree-encoding', 'ident', 'text', 'eol'].includes(attrs[i + 1]!) &&
        !['unset', 'unspecified'].includes(attrs[i + 2]!)
      )
        throw new Error('Git source admission refuses transformations.');
  }
  query(['check-ignore', '--quiet', '--no-index', '--', '.saivage/']);
  if (query(['ls-files', '--others', '--exclude-standard', '-z']))
    throw new Error('Global source effects require clean nonignored source.');
  for (const entry of entries) {
    let path = root;
    const segments = entry.path.split('/');
    for (const segment of segments.slice(0, -1)) {
      path = join(path, segment);
      if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
        throw new Error('Global source effects require unchanged source containers.');
    }
    path = join(path, segments.at(-1)!);
    const stat = lstatSync(path);
    const mode = stat.isSymbolicLink()
      ? '120000'
      : stat.isFile()
        ? stat.mode & 0o111
          ? '100755'
          : '100644'
        : '';
    if (mode !== entry.mode)
      throw new Error('Global source effects require unchanged source modes.');
    const bytes = mode === '120000' ? Buffer.from(readlinkSync(path)) : readFileSync(path);
    const hash = createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (hash !== entry.oid) throw new Error('Global source effects require clean source bytes.');
  }
}

export function nativeGitBranch(owner: z.infer<typeof privateOwner>): string {
  privateOwner.parse(owner);
  return `refs/heads/saivage/${owner.namespace.slice('refs/saivage/'.length)}/${owner.card_id}`;
}

export function nativeGitRefs(
  owner: z.infer<typeof privateOwner>,
  invocationId: string,
): { branch_ref: string; retention_ref: string } {
  privateOwner.parse(owner);
  z.string().uuid().parse(invocationId);
  return {
    branch_ref: nativeGitBranch(owner),
    retention_ref: `${owner.namespace}/retained/${owner.card_id}/${invocationId}`,
  };
}

/** Actual owner checks are reconsumed after each await; no carried write token. */
export async function runGitWorkflow(input: {
  request: NativeGitRequest;
  runner: ProcessRunner;
  parentScope: ManagedProcessScope;
  invocationId: string;
  cardId: string;
  binding: CardNativeExecutionBinding;
  signal: AbortSignal;
  assertCurrent(): void;
}): Promise<NativeGitResult> {
  const { runner, signal } = input;
  const current = (): void => {
    signal.throwIfAborted();
    input.assertCurrent();
  };
  current();
  const request = nativeGitRequestSchema.parse(input.request);
  const binding = nativeGitExecutionBindingSchema.parse(input.binding);
  if ((request.step === 'commission') !== (binding.origin === 'bootstrap') ||
      (binding.origin === 'bootstrap' && input.cardId !== 'project'))
    throw new Error('Commissioning requires root bootstrap origin; other native steps require activation origin.');
  if ('invocation_id' in request && request.invocation_id !== input.invocationId)
    throw new Error('Native invocation identity mismatch.');
  if ('owner' in request && request.owner.card_id !== input.cardId)
    throw new Error('Native card identity mismatch.');
  const deadline = performance.now() + request.timeout_ms;
  let fatal = false;
  const failFatal = (error: unknown): void => {
    if (error instanceof PublicationOutcomeUnknownError) {
      fatal = true;
      runner.fatalPort.publicationOutcomeUnknown(error);
    }
  };
  const identity = () => ({
    row_id: randomUUID(),
    invocation_id: input.invocationId,
    card_id: input.cardId,
    timestamp: new Date().toISOString(),
  });
  const publish = (row: CardExecutionRow): void => {
    current();
    try {
      appendCardExecutions(request.project_root, input.cardId, [row]);
    } catch (error) {
      failFatal(error);
      throw error;
    }
  };
  const paths =
    request.step === 'captureRebase' || request.step === 'restoreRebaseAndReturn'
      ? [`.saivage/work/cards/${input.cardId}/tmp/native-git-${input.invocationId}/index`]
      : [];
  publish({
    ...identity(),
    kind: 'native_started',
    step: request.step,
    binding: input.binding,
    artifact_paths: paths,
  });
  const scope = runner.createDirectScope(
    input.parentScope,
    `native-git:${input.invocationId}`,
    'runtime_card',
  );
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      const report = await runner.closeAndTerminateDirectScope({
        directScope: scope,
        category: 'runtime_card',
        graceMs: 1000,
        reason: 'Native Git invocation ended.',
      });
      if (report.failed.length) throw new Error('Native command group containment is unconfirmed.');
    } catch (error) {
      failFatal(error);
      throw error;
    }
  };
  const command = async (
    args: readonly string[],
    options: GitCommandOptions,
  ): Promise<{ text: string; status: number }> => {
    current();
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new NativeUncertainty('Native Git invocation deadline expired.');
    const allowed = [...(options.accepted ?? [0])];
    const proc = runner.spawnCaptured({
      file: 'git',
      args,
      directScope: scope,
      category: 'runtime_card',
      ownerKind: 'runtime',
      ownerId: input.invocationId,
      cardId: input.cardId,
      cwd: request.project_root,
      env: {
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        ...(options.indexPath === undefined ? {} : { GIT_INDEX_FILE: options.indexPath }),
      },
      ...(options.input === undefined ? {} : { stdin: Buffer.from(options.input) }),
      onSpawn: (record) =>
        publish({
          ...identity(),
          kind: 'native_process_started',
          process_id: record.id,
          allowed_exit_codes: allowed,
          files: (['stdout', 'stderr'] as const).map((stream) => ({
            kind: 'capture',
            stream,
            path: relative(request.project_root, record[`${stream}_path`]),
          })),
        }),
    });
    // Keep this exact promise through external scope termination/retirement.
    const settlement = runner.waitForSettlement(proc.id).catch((error: unknown) => {
      failFatal(error);
      throw error;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let timedOut = false;
    try {
      const interrupted = new Promise<'interrupted'>((done) => {
        abort = () => done('interrupted');
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => {
          timedOut = true;
          done('interrupted');
        }, remaining);
        if (signal.aborted) abort();
      });
      const winner = await Promise.race([settlement.then(() => 'settled' as const), interrupted]);
      // An invalidated owner may only contain, never consume captures or continue.
      if (winner === 'interrupted') {
        await runner.kill(proc.id, {
          directScope: scope,
          category: 'runtime_card',
          graceMs: 1000,
          reason: timedOut ? 'Native Git deadline expired.' : 'Native Git owner interrupted.',
        });
      }
      const finished = (await settlement).record;
      current();
      const ev = finished.evidence;
      const natural =
        winner === 'settled' &&
        !timedOut &&
        (finished.status === 'exited' || finished.status === 'failed') &&
        ev.group === 'absent' &&
        ev.group_diagnostic === null &&
        ev.leader_error === null &&
        ev.leader_exit !== null &&
        ev.leader_exit.signal === null &&
        ev.leader_exit.exit_code !== null &&
        ev.stdout === 'eof' &&
        ev.stderr === 'eof' &&
        ev.stdout_error === null &&
        ev.stderr_error === null;
      const accepted = natural && allowed.includes(ev.leader_exit!.exit_code!);
      publish({
        ...identity(),
        kind: 'native_process_finished',
        process_id: finished.id,
        status: finished.status,
        disposition: accepted ? 'returned' : timedOut ? 'timed_out' : 'failed',
        leader_exit: ev.leader_exit,
        leader_error: ev.leader_error,
        interruption: null,
        timeout_reason: timedOut ? 'Native Git invocation deadline expired.' : null,
        process: {
          id: finished.id,
          group: ev.group,
          group_diagnostic: ev.group_diagnostic,
          stdout: ev.stdout,
          stderr: ev.stderr,
          stdout_error: ev.stdout_error,
          stderr_error: ev.stderr_error,
        },
      });
      runner.retireSettled(proc.id, scope);
      if (!natural)
        throw new NativeUncertainty(
          'Native Git command did not naturally settle with an allowed result.',
        );
      if (!accepted) {
        if (options.mutation)
          throw new NativeUncertainty('Native Git mutation failed; effects are not certified.');
        throw new NativeRefusal('Native Git inspection refused the selected repository or source.');
      }
      if (lstatSync(finished.stdout_path).size > 8 * 1024 * 1024)
        throw new NativeUncertainty('Native Git output exceeds its bound.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        readFileSync(finished.stdout_path),
      );
      return { text, status: ev.leader_exit!.exit_code! };
    } catch (error) {
      if (!fatal) failFatal(error);
      throw error;
    } finally {
      if (!fatal) {
        if (timer !== undefined) clearTimeout(timer);
        if (abort) signal.removeEventListener('abort', abort);
      }
    }
  };
  try {
    const result = await new GitWorkflow(request, command, current).run();
    current();
    if (result.kind === 'uncertain') {
      // Preserve the incomplete logical prefix: containment permits no new
      // artifact observation or source continuation after an uncertain command.
      await close();
      current();
      return result;
    }
    const facts: CardNativeExecutionFinish['facts'] = {
      source:
        result.kind === 'captured'
          ? {
              branch_ref: result.task.branch_ref,
              observed_tip: result.rebase_observation.starting_tip,
            }
          : result.kind === 'delivered'
            ? result.child
            : 'source' in result
              ? result.source
              : 'observation' in result
                ? {
                    branch_ref: result.observation.branch_ref,
                    observed_tip: result.observation.observed_tip,
                  }
                : null,
      parent:
        result.kind === 'delivered' || result.kind === 'returned'
          ? {
              branch_ref: result.observation.branch_ref,
              observed_tip: result.observation.observed_tip,
            }
          : 'parent' in result
            ? result.parent
            : 'task' in result && result.task
              ? result.task.onto
              : null,
      base_oid:
        result.kind === 'commissioned' ? result.parent.observed_tip : 'base_oid' in result
          ? result.base_oid
          : 'task' in result && result.task
            ? result.task.base_oid
            : null,
      original_tip: 'task' in result && result.task ? result.task.original_tip : null,
      retained_original_ref:
        'task' in result && result.task
          ? result.task.retained_original_ref
          : 'retained_original_ref' in result
            ? result.retained_original_ref
            : null,
      parent_before: result.kind === 'delivered' ? result.parent_before : null,
      preserved_source: 'preserved_source' in result ? result.preserved_source : null,
      rebase_observation: 'rebase_observation' in result ? result.rebase_observation : null,
    };
    const files: CardExecutionFile[] = [],
      absent: string[] = [];
    for (const path of paths) {
      try {
        const stat = lstatSync(join(request.project_root, path));
        if (!stat.isFile()) throw new Error('Selected native index is not a regular file.');
        files.push({
          kind: 'artifact',
          path,
          size: stat.size,
          observed_at: new Date().toISOString(),
          source: 'current',
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        absent.push(path);
      }
    }
    publish({
      ...identity(),
      kind: 'native_finished',
      outcome: result.kind,
      effects: result.effects,
      facts,
      disposition: 'returned',
      summary: `Native Git ${request.step}: ${result.kind}.`,
      interruption: null,
      timeout_reason: null,
      source_return:
        result.kind === 'returned' || result.kind === 'delivered' ? 'returned' : 'not_returned',
      files,
      absent_artifacts: absent,
      external_effects: 'unknown',
    });
    await close();
    current();
    return result;
  } catch (error) {
    if (fatal) throw error;
    failFatal(error);
    await close();
    throw error;
  }
}
