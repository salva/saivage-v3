# Issue-fix protocol

This is the complete development workflow for fixing Saivage v3 issues, including
bugs, regressions, review findings, design flaws, behavior gaps, and changes to this
workflow itself. It is a maintainer reference for contributors and for the agents
that carry out that workflow. It is not runtime operator behavior, not a Saivage
product feature, and not automatically injected into any agent.

[AGENTS.md](https://github.com/salva/saivage-v3/blob/master/AGENTS.md) remains the
higher authority for architecture, scope, documentation, commit, validation, and
safety rules. Where this document summarizes AGENTS, AGENTS governs. Nothing here
authorizes a deployment, a live service action, a Run, a reset, a migration, or a
credential change.

## Status and audience

- Maintainers read this document to understand, change, or audit the workflow.
- Each development role's own prompt body carries the procedure that role needs to
  act. A role does not need to load this document or the coordination skill to know
  its next step; a role-local body is a projection of the corresponding section here.
- The coordination skill is the main coordinator's entry point. It is concise and
  points here for detail.
- Changes to the protocol must update the affected role bodies and the coordination
  skill together. Independent composition review manages drift between them.
- Reading this document as an explicitly assigned authoring or review asset is
  normal work. It is not evidence that a worker was independent of it.

## Team and ownership

Every issue has one fixer, one designer/reviewer loop, and at most one implementation
manager holding the lock at a time.

| Role | Owns | Must not |
| --- | --- | --- |
| Batch coordinator (main primary agent) | Accepts the batch; assigns one unique working path per issue; launches and tracks one fixer per issue; records returned task IDs and dispositions in its own session context; decides when a waiting fixer may resume; runs aggregate acceptance once allowed. | Take over any issue's design, review, or implementation; launch developer or documenter; request manager implementation directly. |
| Fixer (`fixer`) | One issue end to end: designer and reviewer delegation, finding triage, design-value reassessment, final approval record, freshness decisions, implementation-manager delegation, read-only reconciliation, and reporting. Writes only ignored planning and review artifacts. | Edit implementation, run validation or generators, stage or commit, author model-facing wording, invoke `documenter` or `developer` directly, or run prompt review itself. |
| Designer (`designer`) | Writes and revises the issue's self-contained plan, including revisions prompted by review or implementation learning. | Approve its own plan or decide merit. |
| Reviewer (`reviewer`) | Adversarially reviews every current design or plan revision. When the manager assigns it, performs read-only prompt linkage and final whole-composition review of model-facing assets, using the explicit exact Sol override in a session distinct from the authoring documenter. | Edit any asset or take the fixer's merit decision. |
| Optional reviewer-2 (`reviewer-2`) | Only when a requester explicitly asks for it: the same design-review criteria, failure and reporting boundaries, and verdicts as `reviewer`. | Substitute for the mandated exact-Sol prompt review. |
| Implementation manager (`implementation-manager`) | The sole implementation orchestrator and the only agent that invokes `developer` or `documenter`. Holds the one lock covering all implementation mutation, validation, generated artifacts, staging, commits and stabilization. | Author implementation directly. |
| Developer (`developer`) | Leaf implementer of manager-assigned runtime, source, configuration, tooling, and navigation work. Supplies source facts. Mechanically applies reviewed inline model-facing wording. | Author model-facing wording, delegate, acquire or release locks, stage, or commit. |
| Documenter (`documenter`) | Manager-assigned documentation and model-facing prompt, skill, agent, and AGENTS wording, using the exact model `opencode-go/claude-haiku-5-5` without any variant, plus its own selfchecks. | Repair source, delegate, use shell or Lua or execute tools, build, validate, stage, commit, or invoke a reviewer. |

Each issue completes its own design and review loop. Issues that may collide can plan
and review concurrently; plan approval reserves no file or contract. Implementation
stays serialized by the single lock regardless of apparent independence. For a
one-issue batch, the primary agent is the one-item coordinator and drives the same
specialist workflow.

Model-facing assets are authored by the documenter and checked by a distinct reviewer
session that the manager invokes with the explicit exact override `openai/gpt-6.1-sol`.
Skills carry no model frontmatter; model selection stays in agent configuration.

## Role execution contracts

These sections give each role its standing local procedure. Their substance also
projects into that role's own prompt body, so a role never needs this document to act.

### Common obligations

- Know your position in the chain: coordinator, then fixer, then designer and reviewer,
  then the sole implementation manager, then developer or documenter. The manager
  alone invokes the exact-Sol prompt reviewer and the developer and documenter. Act
  only within your own inputs, outputs, and mutation boundary. On failure, never
  acquire another role's responsibility.
- Stop and report when a required tool, identity, or input is missing or materially
  inadequate. Do not guess.
- Distinguish absence of evidence from success. A missing result, a timeout, silence,
  or a cancellation is not settlement, approval, or passing validation.
- Report partial effects honestly: what changed, what did not, and what remains.
  Preserve unrelated work, including other sessions' files and locks. Never remove or
  take over a lock except through the boundaries in this document.
- Authentication and outbound confidentiality are absolute. Never print tokens,
  credentials, provider configuration, auth or environment files, or unredacted
  session exports.
- Uncertain publication of Saivage state is governed by the boundary in
  [Uncertain publication boundary](#uncertain-publication-boundary).

### Designer

- Inputs: the issue context and the absolute plan path from the fixer. For a revision,
  every confirmed material finding.
- Output: a self-contained plan at the issue's working path, containing every subject
  listed under design and plan requirements. An implementation-learning revision
  records that learning in the plan. Report limitations and blockers in the plan or
  your report.
- Mutation boundary: only the assigned ignored plan file under `docs/working/`. No
  tracked wording, source, configuration, or validation.
- You do not approve the plan or decide its merit. The fixer owns that decision.

### Reviewer and optional reviewer-2

- Inputs: the absolute current plan path. When the manager assigns prompt-asset review,
  the exact files or composition to inspect, plus the explicit model override it names.
- Read the complete plan and verify its claims against current code, docs, and AGENTS.
  Apply finding triage and design-value guidance from this document. Look for: durable
  format incompatibility and evidenced source applicability; correctness gaps and
  hidden assumptions; missed root causes and over-local fixes; contract mismatches and
  missing call-site updates; missing or stale documentation; missing validation
  proportional to the risk; unnecessary compatibility code, dead code, or excessive
  complexity; and over-scoped changes that bundle deferrable robustness.
- For prompt-asset review, review the actual final assets, the root configuration, the
  governing and shared instructions, and the relevant unchanged roles as one composed
  result. Check that each prompt gives useful direction, that its authority and
  linkage are accurate, that author and reviewer roles stay separate, and that no
  obsolete or contradictory instruction remains. A synthetic future composition must
  be labeled synthetic. It is not evidence of delivered behavior.
- Each finding states its severity, concrete evidence (file and line, or a quote), the
  affected requirement and its practical consequence, and a separately identified
  suggested correction. Do not raise speculative or preference-only nits.
- Write your complete review to the review artifact path the invoker specifies,
  normally a `review-round-<N>.md` file in the plan's directory under `docs/working/`.
  Files under `docs/working/` are the only files you may write. You do not edit the
  plan, prompt assets, source, or configuration, generate tests, or run mutating commands.
- Route findings by which review you performed. Two routes never mix:
  - **Design or plan review** (any plan review the fixer requests, including reviewer-2):
    return findings to the fixer. The fixer triages them and sends confirmed material
    findings to the designer for revision, then repeats the full review loop. You never
    send a design finding to an implementation worker.
  - **Manager-assigned implementation prompt-asset review:** return findings to the
    manager. Wording findings go to the manager, which routes them to `documenter`.
    Logic findings go to the manager, which routes them to `developer`.
- Finish with exactly one verdict on the last line:
  - `NO_MATERIAL_FINDINGS`: no material finding remains. Supported findings may be
    explicitly deferred under triage.
  - `MATERIAL_FINDING_FOUND`: at least one material finding remains.
  Missing evidence or failed tooling is reported as such. It is never approval.
- Reviewer-2 applies the same design-review criteria, failure and reporting boundaries,
  and verdicts. It is an optional, explicitly requested additional design reviewer. It
  never substitutes for ordinary `reviewer` review or for the mandated exact-Sol prompt
  review.

### Developer

- Inputs: the absolute approved plan path and the manager's assigned scope.
- Scope: runtime, schema, business logic, tests, fixtures, executable examples,
  tooling, navigation configuration, generators, and non-model-facing source comments.
  Documentation and model-facing wording are not developer-authored.
- Documentation and model-facing wording: apply the documenter's reviewed text verbatim,
  in the same coherent implementation unit as the code it describes, before validation
  and commit. For inline wording in an executable host, apply the reviewed exact text.
  Do not reword it, reformat it for meaning, or invent a replacement. If the reviewed
  text conflicts with a host constraint, report the mismatch instead of editing the wording.
- Mixed assignments: first settle and report the source facts the documenter needs,
  such as names, contracts, actual behavior, and file references. The manager then
  sequences the documenter's wording after those facts.
- A source gap the plan did not assign goes back to the manager for a separate developer
  assignment. Do not absorb it silently.
- Focused checks: run the focused checks needed to verify your own source changes, then
  report each command and its result. These checks inform progress. They never replace
  the manager-run required validation.
- Generation: do not run build or generated-artifact generation unless your assignment
  names it.
- Concurrency: develop concurrently only when the manager has assigned source-only work
  it has determined does not conflict. Settle every command you launched before reporting.
- Format and cutover: approved owner-local discriminator changes are yours to
  synchronize with producers, consumers, fixtures, and the format reference. Return a
  material format or cutover mismatch to design. Never silently normalize retained data.
- A plan that is materially wrong means a different design is needed. Stop. Do not
  improvise a replacement. Report back so the designer can revise and the reviewer can
  re-review before implementation continues.
- Mutation boundary: the source and configuration within your assignment only. You do
  not acquire locks, delegate, stage, commit, or push.

### Documenter

- Invocation: only by the implementation manager, with exact model
  `opencode-go/claude-haiku-5-5` and no variant. A coordinator, fixer, or other
  documenter never invokes it. The documenter never invokes a reviewer itself. The
  manager does.
- Inputs: the assigned facts and plan from the manager. Read the actual source to confirm
  each fact before wording it.
- Output: the exact replacement documentation or model-facing wording, with its selfchecks.
  Selfchecks are author checks, not independent review.
- Report partial wording and any facts you could not obtain. Await the manager. Route
  source gaps back through the manager.
- Mutation boundary: the assigned documentation and model-facing assets only. No source
  repair, delegation, shell, Lua, or execute use, builds, validation, staging, or commit.

## Working files

Create a unique working directory for each issue, such as `docs/working/<date>-<issue-slug>/`.
It holds the current design or plan and one file per adversarial review round.

- `docs/working/` is ignored and must not be committed. It is not canonical
  documentation.
- Keep every revised plan self-contained. Readers must not need earlier revisions.
- Keep reviews factual and actionable. Do not preserve weak critiques as required work.
- Ignored working artifacts are the only place for task-local semantic evidence.

## Design and plan requirements

Keep each design or plan concise, self-contained, and proportional to the risk. Cover
each subject below. A brief statement that a subject is not affected is enough when
it truly does not apply; do not repeat policy inventories or the review history.

- **Problem statement** with evidence and the affected user or runtime behavior.
- **Root-cause analysis**, or the best current hypothesis, and why the proposed
  layer owns the cause.
- **Scope and non-scope.** List non-essential robustness and rare edge cases as
  deferred follow-ups, unless deferral blocks the core fix or leaves the system unsafe.
- **Proposed design**, naming affected modules, contracts, APIs, and UI or runtime
  surfaces as applicable.
- **Explicit durable-format impact**, including "no impact." Name affected
  discriminators, source and cutover applicability, adoption consequences, and the
  [durable format reference](../architecture/durable-format-changes.md) updates
  required by the
  [AGENTS storage policy](https://github.com/salva/saivage-v3/blob/master/AGENTS.md#durable-format-versioning).
  Review durable shape and semantic incompatibility, justified bumps and grouping,
  and evidenced source applicability under the same policy. Reject equal-version or
  unreleased claims that are unsupported.
- **Alternatives**, including a broader or root-cause alternative when reasonable.
- **An ordered implementation plan** with three explicit sections:
  - Main work tasks.
  - Cleanup tasks for obsolete code, tests, fixtures, docs, and scripts.
  - Documentation-update tasks naming each main document to update and how. The
    main documents are `docs/spec/system-specification.md`,
    `docs/spec/operator-ui-needs.md`, `docs/spec/operator-ui-contracts.md`,
    `docs/architecture/system-architecture.md`, and `README.md`, as they apply.
    Documentation is implementation work, not a later phase. The working plan itself
    does not count.
- **Related stale main documentation** and scoped tasks to correct it.
- **Focused and broader validation** appropriate to the risk. Target the affected
  semantic owners and useful behavior, and broaden only for demonstrated
  cross-cutting risk. Do not use prose-regex assertions, repository-wide spelling
  bans, or unrelated test matrices as substitutes for semantic evidence.
- **Risks, rollback considerations, and unresolved questions.**

## Adversarial review and revision loop

The fixer uses `designer` for all plan authoring and `reviewer` for every review.

1. Ask `designer` to write or revise the self-contained plan at the issue's unique
   path. For revisions, pass every confirmed material finding.
2. Invoke `reviewer` on the complete current plan.
3. Triage every finding (see below).
4. When any finding is material, check whether the periodic design-value
   reassessment is due. If it is not due, revise and repeat directly. If it is due,
   continue to revision only on `WORTH_CONTINUING`.
5. When every finding is false, minor, or explicitly deferred and no confirmed
   material finding remains, run the mandatory final design-value reassessment.
   Review closure alone never authorizes freshness checking or implementation.

Invoke the designer with `subagent_type: "designer"`, the issue context and the
absolute plan path. Invoke the reviewer with `subagent_type: "reviewer"` and the
absolute current plan path. Save or summarize each review in the issue's working
directory.

### Finding triage

- **False:** disproved, speculative, preference-only, or contradicted by current
  requirements. Reject it. A finding is not false merely because it is out of scope.
- **Minor:** correct but too small to affect the plan. Note it without forcing
  another round.
- **Material:** real and significant enough to change the design or plan. Revise
  directly.
- **Deferred:** supported but outside the minimal coherent fix. Record a brief reason
  and any needed follow-up. Do not defer a defect that blocks the core fix or leaves
  it unsafe.

Accepting a defect does not accept its proposed remedy. Separate the evidence and the
violated requirement from the suggested correction. When an unsupported plan claim
causes the defect, narrow that claim if current requirements do not require the
stronger behavior. Do not weaken an actual requirement merely to close review.

### Design-value reassessment

The fixer owns this higher-level merit decision. The designer and reviewer do not.
Apply it at two points:

- **Periodically during revision.** Reassess immediately when findings recur, a
  revision widens or shifts scope, adds a material mechanism, or pulls a deferred or
  non-essential concern into the core change. Otherwise reassess no later than every
  second review round that has confirmed material findings since the last
  reassessment or full-loop restart. Run it after finding triage and before another
  designer revision.
- **After review closure.** Always reassess the complete closed plan before recording
  approval, checking freshness, or invoking `implementation-manager`. An earlier
  periodic result cannot satisfy this final gate.

Use a concise pass or fault decision, not a scorecard or a new approval artifact.
Confirm each of these:

- **Value and root cause.** Measured against the original evidenced need, the plan
  solves the issue at the layer that owns its root cause rather than compensating for
  a symptom or preserving a disproved premise. When an introduced mechanism creates
  the problem, first consider removing that mechanism before adding machinery to make
  it correct.
- **Net simplicity.** The result is cleaner and easier to understand and change. Its
  new mechanisms, states, contracts, coordination, and exceptions are not comparable
  to or worse than the complexity removed, unless concrete value clearly justifies them.
- **Project alignment.** The plan follows AGENTS, including clean architecture,
  fail-fast and singular-contract rules, and the prohibitions on compatibility paths
  and test-driven production complexity.
- **Scope discipline.** The plan is the minimal coherent safe fix. Deferred or
  non-essential robustness and rare-edge-case concerns remain deferred unless they
  block the core behavior or leave it unsafe.

Record one outcome with concise evidence:

- **`WORTH_CONTINUING`:** valid only at a due periodic gate while material findings
  remain. It permits the next designer revision and reviewer round. It cannot approve
  the plan, record an examined `HEAD`, run freshness, or authorize implementation. A
  material round where reassessment is not due follows the ordinary revision loop
  without a merit outcome.
- **`WORTH_IMPLEMENTING`:** valid only at the mandatory post-closure gate. It is the
  sole merit outcome that permits plan approval, freshness checking, and eventual
  manager delegation.
- **`REDESIGN_REQUIRED`:** the design is faulty but salvageable. Record the failed
  conditions and the precise constraints that could plausibly restore a worthwhile,
  compliant, root-cause design. Do not patch or partially implement the current plan.
  Give the complete issue, evidence, and constraints to `designer`, then restart the
  full designer and reviewer loop on a self-contained plan. Every redesigned plan is
  subject to the same periodic and final gates.
- **`ABANDONED`:** no credible compliant redesign is worthwhile. Examples are a
  disproved premise, necessary complexity that outweighs the concrete value, or an
  objective that conflicts with AGENTS. End the issue without freshness or
  implementation. Report the evidence, the failed conditions, and why precise
  constraints cannot save it. Do not relaunch it automatically.
- **`BLOCKED`:** evidence is insufficient, or an operator-owned product tradeoff
  prevents a reliable decision. Ask the user rather than guessing, abandoning, or
  implementing.

This reassessment judges the design's merit. The freshness gate below separately
judges whether repository changes invalidated an approved design.

### Escalation and blockers

- Ask the user when reassessment cannot resolve unclear scope, repeated disagreement,
  or a required tradeoff.
- Ask the owner before introducing stronger product guarantees or removing unrelated
  capabilities that are not already authorized. General slogans such as "fail fast,"
  "root cause," or "remove dead code" do not authorize those tradeoffs. Ordinary
  implementation choices within established requirements remain autonomous; this
  boundary does not require owner approval for every refactor.
- If required subagent tooling is unavailable, report `BLOCKED`. Never claim that a
  review or implementation passed. Proceed only if the user explicitly changes the
  workflow, or the change repairs the unavailable workflow itself.

## Batch launch and tracking

For a batch, the coordinator must:

1. Give each fixer a complete issue statement and a unique absolute working-plan path.
2. Launch independent initial Task calls concurrently, in the same orchestration turn
   or tool batch when supported, with `subagent_type: "fixer"`. Do not serialize
   design or review merely because issues may touch the same files.
3. Record, in coordinator session context and never in a repository file or registry:
   issue identity and summary, exact returned fixer task ID, plan path, latest
   disposition, and known implementation-lock ownership.
4. Handle each return independently. One issue's failure or cancellation does not
   cancel the others unless explicitly requested.

Awaiting each initial fixer in sequence defeats the batch contract. If concurrent Task
launch or exact returned-ID observation is unavailable, report the batch workflow as
blocked. Do not silently weaken it.

## Final approval and freshness gate

Only after review closes and the final reassessment returns `WORTH_IMPLEMENTING` may
the fixer record this approval in session or report state:

```text
Plan approval:
Review closure: <review verdict and round/review artifact>
Final merit outcome: WORTH_IMPLEMENTING
Supporting evidence: <concise evidence covering the four merit conditions>
Examined HEAD: <commit>
```

Immediately before every implementation-manager attempt, including every attempt
after lock waiting, the fixer performs a read-only semantic freshness check against:

- the current `HEAD`,
- commits made since its last approval or check,
- and current shared-worktree changes.

Compare the plan's assumptions, named files, contracts, call sites, cleanup,
documentation, and validation. Include affected durable contracts,
discriminator and reference changes, and release or cutover applicability. The
format reference helps the source comparison; it does not certify deployment.

- **`PLAN_STILL_VALID`:** intervening changes do not materially affect the root cause,
  the intended contract, the affected components or call sites, the ordered tasks, or
  the validation. Record the evidence and invoke the manager.
- **`PLAN_REVIEW_REQUIRED`:** a contract or assumption changed, a target was removed or
  substantially rewritten, planned changes conflict, the scope changed, or the
  validation or docs no longer establish correctness. Do not invoke the manager. Send
  the current evidence to `designer` and repeat the complete review and triage loop.
- **`BLOCKED`:** the shared workspace is broken, unclassified, or unsafe for a reliable
  check. Do not mutate or improvise.

A freshness-driven return to design invalidates the prior approval. A newly closed
revision needs a new final `WORTH_IMPLEMENTING` decision and approval record. A
successful check reserves nothing. The manager must still acquire the sole lock. If it
loses contention, the fixer waits and repeats freshness after its verified resume.

## Singular complete implementation boundary

Every approved fixer invokes Task with `subagent_type: "implementation-manager"` and
the absolute approved-plan path. No primary agent or fixer inspects the lock and
implements around it. The file `.opencode/locks/implementation-manager-working.md` is
the only serialization boundary.

The manager must:

1. Atomically acquire the lock before reading the implementation plan or making or
   delegating any implementation mutation. On contention, it edits and delegates
   nothing and returns the existing lock description.

   **Owner-override exception.** When the coordinator's initial assignment quotes an
   explicit project-owner instruction that an existing lock was wrongly acquired by an
   unrelated run and must be left untouched, the manager may proceed without acquiring
   it, under these exact conditions:
   - The coordinator guarantees that this is the sole writing agent until the run
     reports completion.
   - The stray lock file is never removed, modified, or taken over.
   - The manager captures pre-existing repository state first, stages only its plan's
     intended paths, preserves unrelated changes, and escalates rather than overwrites
     when unexpected concurrent modifications appear.
   - Before each new implementation attempt, the responsible fixer re-checks whether
     the stray lock was released. Once it is gone, normal acquisition resumes for
     every later run.

2. Capture pre-existing Git status and diff sufficiently to preserve unrelated work and
   to avoid staging or removing it.
3. Decompose the approved plan into developer and documenter assignments. Route
   runtime, source, configuration, and tooling work to `developer`. Route
   documentation and model-facing prompt, skill, agent, and AGENTS wording to
   `documenter`. For mixed work, settle the source facts first where needed, then
   author the wording from them. A source gap returns to the manager for a separate
   developer assignment.
   - Documenter authoring runs sequentially. Never run a documenter concurrently with
     another documenter or with any source worker. Never overlap documenter authoring
     with independent review of the same moving assets.
   - A concurrent developer group may launch only when every assignment is source-only
     and the manager has positively determined that the assignments do not conflict in
     files, contracts, generated outputs, validation side effects, or required order.
4. Await every developer and documenter and every command each launched. Reconcile
   each result and the combined repository state against the assigned scopes and the
   approved plan. No shared or integration validation, generation, staging, or commit
   may start until all workers and their launched commands have settled.
   - After documenter authoring changes prompt assets, the manager invokes `reviewer`
     with the explicit exact Sol override `openai/gpt-6.1-sol`, in a distinct session,
     for prompt linkage and composition review. After the last edits it repeats the
     final whole-composition review.
   - Findings return to `documenter` for wording, or to `developer` for logic, followed
     by affected validation and a repeated final review.
   - Include planned discriminator, producer, consumer, fixture, and reference
     synchronization in this reconciliation and in the completion report, without
     adding another gate or coordination mechanism.
5. Run all validation required by the plan, including focused and broad checks. Handle
   generated artifacts. Selectively stage only intended paths. Commit coherent stable
   units under AGENTS. Developer checks may inform progress, but they do not replace
   manager-run required validation.
6. Prepare its final report with command results and commit hashes. Before normal
   release, ensure the completed issue work is stable and committed, and that no
   issue-owned uncommitted mutation remains.
7. For partial completion, or for redesign-worthy learning after edits, validate and
   commit only coherent completed units. Then finish or remove only this run's
   incomplete, uncommittable changes, preserving pre-existing and unrelated work. If
   safe stabilization is impossible, retain the lock and escalate. Do not expose an
   unsafe worktree to another run. This step applies to known outcomes only, subject
   to the [uncertain publication boundary](#uncertain-publication-boundary).
8. Remove only the lock this run created, as the final mutation, then return the
   prepared report. If the run terminates abnormally, the lock may remain. No other
   agent removes it or takes it over. Do not perform this removal after an uncertain
   publication that the boundary below governs.

The lock spans tracked and main-document edits, generated outputs, mutating build,
test, and documentation commands, staging, commit hooks, commits, and final issue
cleanup. Concurrent developers stay inside one lock holder's single issue, and no
other issue's implementation may overlap.

### Uncertain publication boundary

Ordinary stabilization applies to known outcomes. Partial results from a known
failure, a known incomplete plan, or a known divergence are validated, committed, or
removed through steps 6 to 8 above.

AGENTS defines a stricter fatal boundary for Saivage persistence. Replacement, append,
truncation, and lifecycle-lock publication errors may be outcome-unknown. They
authorize no follow-up read, retry, rollback, replay, reconciliation, effect,
descriptor cleanup, or artifact inspection. Where a workflow operation publishes such
Saivage state and its outcome is uncertain, that AGENTS boundary governs in full.
Stabilization, reconciliation, reporting writes, and lock removal are not exceptions to
it. Report the known facts and the uncertainty, then escalate to the owner or operator.
Retain the lock. Do not repair, retry, or take over.

The boundary does not create a blanket fatal rule for ordinary development commands. A
failed build, test, documentation, or Git command with a known result is a known
partial outcome, handled by the normal stabilization steps. A development command
whose effect is initially indeterminate is reported as uncertain, never as success or
known partial, and every command launched is settled before reporting. The established
reconciliation and stabilization procedure may determine its facts through permitted
read-only inspection. Escalate to the owner or operator only when that uncertainty
cannot be resolved safely this way, or when safe stabilization cannot be established.
Do not perform any inspection after the AGENTS fatal boundary above applies.

### Interrupted owner continuation

An explicit project-owner authorization may permit the original implementation-manager
session to continue its interrupted attempt under its own still-held acquisition.

Before any continuation work, positively establish from retained session context and
independent coordinator or tool evidence:

- the exact original session identity and its acquisition. Matching lock text alone is
  insufficient;
- that the current lock still describes that acquisition;
- that the prior invocation, every delegated worker, and every launched command have
  settled. Cancellation, a timeout, silence, or a caller's assertion alone is not
  settlement evidence.

Do not overlap an active original child, launch a replacement manager, recreate or
remove the lock, or transfer ownership. If any required evidence is unavailable or
conflicting, remain `BLOCKED` with the lock untouched. Do not poll or retry.

Resume only that exact original manager session, and only after these conditions hold.
Reconcile the prior partial effects and the current repository state read-only against
the approved plan before any further delegation. A material divergence returns to the
designer and reviewer, not to improvised implementation.

Verify that the session's effective higher-priority instructions actually permit
continuation. Saving or reloading an agent file, or quoting this exception in a
lower-priority message, does not prove replacement of stored instructions. If that
cannot be established, report the instruction-loading blocker. Continuation then runs
under the same acquisition and the manager-assigned developer and documenter boundary,
with unchanged validation, stable-unit commit, stabilization, and final-release duties.

This exception neither authorizes another issue's parallel implementation nor changes
the stray-lock exception above.

## Lock contention and event-driven resume

A contender that returns without editing or delegating maps exactly to
`WAITING_FOR_IMPLEMENTATION_LOCK`. This is not a failure, not partial implementation,
not divergence, and not evidence that requires redesign. The fixer keeps issue
ownership. It must not poll, sleep, retry in the same turn, inspect, remove, or
classify the lock as stale, or launch another manager.

The coordinator may resume waiting fixers only after the known holder has returned,
released its lock, and reported a stable committed state. Several waiting fixers may be
resumed optimistically. One manager wins and the others wait again. This creates no
queue, scheduler, fairness promise, timer, watcher, or additional lock.

### Waiting nonce

On each waiting return, the fixer generates a fresh opaque continuity nonce, retains it
in its existing session context, and reports it. The coordinator records it with the
exact returned task ID and replaces any prior nonce for that issue. The nonce is session
correlation state, not a credential or durable state. Successful authorization consumes
it. Repeated waiting requires a new nonce. Cancellation or terminal failure discards it.

### Mandatory two-call resume handshake

Both calls use:

```text
subagent_type: "fixer"
task_id: "<exact recorded task ID>"
```

**Call 1, challenge.** The coordinator does not include the expected nonce. Its prompt
unconditionally forbids tools, edits, commands, and every mutation. It asks only for the
issue identity, the plan path, the prior `WAITING_FOR_IMPLEMENTATION_LOCK` disposition,
and the nonce retained in session context. If any value is unavailable, the fixer
returns `BLOCKED` without tools.

The coordinator independently verifies that the Task result's returned task ID is
byte-for-byte identical and that all retained values exactly match its record.

Any missing or mismatched value, task-ID mismatch, or tool use or mutation makes the
issue `BLOCKED`. Make no Call 2. An invalid ID may create a new session, but that session
cannot know the undisclosed nonce, and its output is never adopted.

**Call 2, authorization.** Only after Call 1 passes, invoke the same exact task ID again.
Authorize the read-only freshness gate and, only if the plan is still approved, manager
delegation. Before using any tool, the fixer confirms from its own context that the
immediately preceding handshake succeeded for the retained waiting episode. If that
context is absent, the result is `BLOCKED` without tools. The coordinator again verifies
the exact returned task ID. Successful authorization consumes the nonce.

## Handling manager returns

### Contention-only return

Map a manager return that acquired no lock, edited nothing, and delegated nothing to
`WAITING_FOR_IMPLEMENTATION_LOCK`. Do not revise or re-review solely because of
contention. Return control to the coordinator with a fresh nonce, and wait for the
event-driven resume.

### Acquired-lock return

The fixer performs read-only reconciliation only. It inspects the manager report, the
commit hashes, `HEAD`, status and diff, and the manager-supplied validation evidence. It
must not run any command that can mutate files, regenerate artifacts, stage, commit, or
finish implementation. Reconciliation never authorizes a follow-up action after an
uncertain publication that the [uncertain publication boundary](#uncertain-publication-boundary)
governs. Such a report is `BLOCKED`, and it is not a basis for further mutation.

- If the approved plan is fully executed with no divergence or redesign-worthy learning,
  and the repository is stable, report issue completion.
- If work remains, the run is partial, the implementation diverged, or learning changes
  the design, return the issue to `designer` and the complete adversarial review loop.
  Planning-file edits remain allowed. A later implementation attempt requires a new
  freshness check and a new manager lock.
- If the manager could not stabilize and retained the lock, report `BLOCKED`. No issue
  implementation resumes until explicit owner or operator verification and repair. The
  original interrupted holder may continue only through **Interrupted owner
  continuation**, not through the contention-only waiting handshake or a new manager
  attempt.

## Structured fixer dispositions

Every fixer return to a coordinator starts with exactly one of these dispositions:

- `COMPLETED`
- `ABANDONED`
- `WAITING_FOR_IMPLEMENTATION_LOCK`
- `BLOCKED`
- `FAILED`
- `CANCELLED`

A waiting return includes:

```text
Disposition: WAITING_FOR_IMPLEMENTATION_LOCK
Issue: <identifier and summary>
Plan: <absolute path>
Plan approval:
Review closure: <review verdict and round/review artifact>
Final merit outcome: WORTH_IMPLEMENTING
Supporting evidence: <concise evidence covering the four merit conditions>
Examined HEAD: <commit>
Implementation attempt: <number>
Lock holder: <verbatim or concise faithful existing lock description>
Continuity nonce: <fresh opaque value retained in this fixer session>
Work performed in this attempt: none
Resume condition: known lock-holder run has returned and released its lock
Coordinator action: retain this nonce with the exact fixer task ID, then use the two-call handshake; do not launch a replacement
```

The coordinator records each Call 1 result as:

```text
Requested task ID: <exact recorded ID>
Returned task ID: <Task result ID>
Continuity: CONFIRMED | BLOCKED
Prior issue from session context: <identifier or unavailable>
Prior plan from session context: <path or unavailable>
Prior disposition from session context: <WAITING_FOR_IMPLEMENTATION_LOCK or unavailable>
Retained nonce from session context: <opaque value or unavailable>
```

`CONFIRMED` requires no tool use or mutation, all four retained values matching, and
identical requested and returned IDs. It only makes Call 2 eligible. It does not
authorize freshness work by itself.

Before manager delegation after Call 2, record:

```text
Resume check: PLAN_STILL_VALID | PLAN_REVIEW_REQUIRED | BLOCKED
Previously examined HEAD: <commit>
Current HEAD: <commit>
Relevant intervening changes: <summary or none>
Decision and evidence: <reason>
```

A completed report includes the issue identity, the plan path, the unchanged successful
plan-approval block, files changed, manager-supplied validation results, commit hashes,
remaining work or divergence, and repository stability.

An `ABANDONED` report instead includes the review outcome, the merit evidence, the failed
conditions, why redesign cannot make the issue worthwhile, and any separate follow-up.
It claims no files changed, no validation, and no commits. Never imply that an abandoned
issue was implemented.

The fixer generates no new implementation evidence after the manager returns.

## Cancellation and error handling

- **Waiting fixer cancelled:** mark `CANCELLED`, discard its nonce, make no handshake
  call, and do not touch the lock. Other issues continue unless directed otherwise.
- **Call 1 mismatch, absence, or tool use:** mark `BLOCKED`, discard the nonce, and make
  no Call 2. Never adopt a replacement session.
- **Cancellation between calls:** discard the authorization and make no Call 2. Never
  reuse the nonce. Later continuation requires a fresh waiting disposition from the
  original session.
- **Call 2 ID or context mismatch:** mark `BLOCKED` before any freshness or
  implementation tool use, and never delegate from replacement-session output.
- **Design, review, or Task problem before implementation:** use `BLOCKED` for unavailable
  required tooling and `FAILED` for an actual issue-local failure. Other fixers may
  continue if the shared worktree is safe.
- **Design abandoned on merit:** return `ABANDONED` as an intentional terminal
  no-implementation decision, not `FAILED` or `CANCELLED`. The coordinator does not
  resume or replace it.
- **Acquired-lock error, partial result, or divergence:** the manager stabilizes coherent
  work before normal release, unless the [uncertain publication boundary](#uncertain-publication-boundary)
  applies. The fixer reconciles read-only, then either returns to
  design and review or reports failure. Other issues resume only when the report, the
  lock, and the repository state are all safe.
- **Manager cannot stabilize or terminates abnormally:** leave the lock in place. No
  contender removes or takes it over. Report a batch-level blocker that requires
  explicit owner or operator action. Only **Interrupted owner continuation** permits the
  same acquiring session to continue its interrupted attempt.
- **Coordinator cancellation:** stop launches and resumes. Cancel children only when
  explicitly requested and supported. Report all last dispositions and any active
  holder. Never remove another session's lock.
- **Unresumable task ID:** a Task error or failed challenge is `BLOCKED`. Do not
  automatically launch a replacement fixer.

## Post-batch aggregate validation

Only when every issue disposition is exactly `COMPLETED` or `ABANDONED`, no fixer has
pending implementation work, and the implementation lock is absent may the coordinator
run one final read-only or harmless aggregate validation to test batch coordination.
Any issue in `WAITING_FOR_IMPLEMENTATION_LOCK`, `BLOCKED`, `FAILED`, or `CANCELLED`
prevents it.

Aggregate validation never stages or commits. Any unexpected tracked or generated diff
fails the aggregate check and is reported. It is never repaired outside the manager
boundary.

For workflow changes that require Task continuity validation, run the plan's harmless
live smoke exactly as written. It uses concurrent synthetic fixer sessions, exact-ID
recording, a nonce-free and tool-free Call 1, and a verified same-ID Call 2, and it
checks for a mismatch safely. If Task concurrency, IDs, resume, nonce retention, or
tool-free evidence is unavailable, report workflow validation as `BLOCKED`. Do not
substitute a sequential, one-call, or text-only imitation.

## Prohibited mechanisms

Do not introduce any of the following:

- parallel issue-level implementation;
- multiple lock-holding managers;
- direct primary-agent or fixer implementation;
- extra locks, lock takeover, or stale-lock classification;
- polling, sleeps, retry timers, watchers, queues, or schedulers;
- registries, replacement fixers, or branches, worktrees, clones, or merge orchestration.

Do not run documenter authoring concurrently with any other worker. Do not run
concurrent developer assignments that overlap in files, contracts, outputs, validation
side effects, or ordering. Do not invoke `documenter` directly from a primary agent or
fixer.

## Final reporting

Report the issue or issues, the core design choice, the plan path or paths, the
adversarial review and final merit outcomes, material findings, the main documents and
files changed, documenter authorship and prompt-review evidence where model-facing
assets changed, manager-run validation commands and results, commit hashes, repository
stability, residual risks and follow-ups, and any abandoned, blocked, or cancelled
issues.

Do not commit `docs/working/` artifacts. After any change to skills or agent prompts,
tell the operator to restart OpenCode before relying on them. A running session does
not newly discover a changed file.
