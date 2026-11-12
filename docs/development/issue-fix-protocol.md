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
- This document is the design source for the development roles. Each role's own prompt
  body carries the procedure that role needs to act. A role does not need to load this
  document or the coordination skill to know its next step; a role-local body is a
  projection of the corresponding section here.
- The coordination skill is the main coordinator's entry point. It is concise and
  points here for detail.
- Changes to the protocol must update the affected role bodies and the coordination
  skill together. Independent composition review manages drift between them.
- Reading this document as an explicitly assigned authoring or review asset is
  normal work. It is not evidence that a worker was independent of it.
- Canonical identities for new work are described below. Sessions and profiles that
  predate them are described under [Canonical roles and transition](#canonical-roles-and-transition).

## Applicability in this development realm

This workflow governs development tooling: how maintainers and development agents
change Saivage v3's documentation, OpenCode agent profiles, skills, and prompt
assets, and its source and configuration. The obligations below always bind:
ownership, the implementation lock, authentication and outbound secret
non-disclosure, preservation of unrelated work, validation proportional to the
change, and commit scope.

Saivage runtime contracts, such as card, record, conversation, API, provider, and
garbage-collection rules, and the persistence rules for Saivage-owned state, apply to
an issue only when its subject actually touches those surfaces. They are not universal
checks for every development role, and an ordinary inspectable Git or tooling failure
is not governed by the Saivage persistence boundary. AGENTS states the rules; this
document does not paste their inventories into each role.

The Saivage-core prohibition on compatibility code does not forbid the owner's
explicitly requested retention of independently registered OpenCode role profiles.
Those profiles are development configuration, not product code, shims, or loaders.

## Team and ownership

Every issue has one issue fixer, one designer and design-reviewer loop, and at most
one implementation manager holding the lock at a time.

| Role | Owns | Must not |
| --- | --- | --- |
| Batch coordinator (main primary agent) | Accepts the batch; performs intake of each issue's existing tracker entry before launch; assigns one unique working path per issue; launches and tracks one issue fixer per issue; records returned task IDs and dispositions in its own session context; applies each issue's factual lifecycle to the ignored tracker files at a quiescent boundary; decides when a waiting fixer may resume; runs aggregate acceptance once allowed. | Take over any issue's design, review, or implementation; invoke an issue designer, design reviewer, implementation author, or implementation reviewer for ordinary issue work; request manager implementation directly; write a tracker file while an issue call that could launch a manager is unsettled; move an entry to Done without its completion evidence. The only exception is the bounded passive aggregate check in [Post-batch aggregate validation](#post-batch-aggregate-validation). |
| Issue fixer (`issue-fixer`) | One issue end to end: designer and design-reviewer delegation, finding triage, design-value reassessment, final approval record, freshness decisions, implementation-manager delegation, read-only reconciliation, and reporting, including the issue's tracker evidence. Writes only ignored planning and review artifacts. | Write `docs/working/todo.md` or `docs/working/done.md`; edit implementation or model-facing assets, run validation or generators, stage or commit, author wording, invoke any developer, documenter, or implementation reviewer, or run prompt or documentation review itself. |
| Issue designer (`issue-designer`) | Writes and revises the issue's self-contained plan, including revisions prompted by review or implementation learning. | Approve its own plan or decide merit. |
| Design reviewer (`design-reviewer`) | Adversarially reviews every current design or plan revision. Read-only apart from its assigned review artifact. | Edit any plan, asset, source, or configuration; take the issue fixer's merit decision; review implementation assets. |
| Optional secondary design reviewer (`design-reviewer-secondary`) | Only when a requester explicitly asks for it: the same design-review criteria, failure and reporting boundaries, and verdicts as `design-reviewer`. | Substitute for ordinary design review, or for any documentation or prompt review. |
| Implementation manager (`implementation-manager`) | The sole implementation orchestrator and the only agent that invokes implementation authors and reviewers. Holds the one lock covering all implementation mutation, validation, generated artifacts, staging, commits and stabilization. Under that lock it keeps only its own issue's existing factual tracker entry current, and never moves an entry to Done. | Author implementation or model-facing wording directly; write any tracker entry other than its own issue's factual status; delegate a tracker write. |
| Code developer (`code-developer`) | Leaf implementer of manager-assigned runtime, source, configuration, tooling, tests, fixtures, and navigation work. Supplies source facts. Mechanically applies reviewed inline wording. | Author documentation or model-facing wording, delegate, acquire or release locks, stage, or commit. |
| Documentation developer (`doc-developer`) | Manager-assigned ordinary documentation: facts, structure, clear progression, explanation, and reader usefulness. | Author model-facing instructions, delegate, use shell, Lua, or execute tools, build, validate, stage, commit, or invoke a reviewer. |
| Documentation reviewer (`doc-reviewer`) | Manager-assigned independent review of ordinary documentation for facts, quality, structure, and progression. Read-only apart from its assigned review artifact. | Edit any asset; review model-facing instructions; take the author's role. |
| Prompt developer (`prompt-developer`) | Manager-assigned model-facing wording: instructions, prompts, templates and fragments, agent bodies and descriptions, skills, and AGENTS wording. | Author ordinary documentation, delegate, use shell, Lua, or execute tools, build, validate, stage, commit, or invoke a reviewer. |
| Prompt reviewer (`prompt-reviewer`) | Manager-assigned independent review of model-facing assets as one composed result, including the unconditional final clean-room pass. Read-only apart from its assigned review artifact. | Edit any asset; review ordinary documentation as its only purpose; take the author's role. |

Model-facing assets are never authored by the same agent that reviews them. Ordinary
documentation is written by `doc-developer` and checked by `doc-reviewer`. Model-facing
instructions, prompts, templates, fragments, agent bodies, skills, and AGENTS wording
are written by `prompt-developer` and checked by `prompt-reviewer`, which the manager
invokes with the explicit exact override `openai/gpt-6.1-sol`. Skills carry no model
frontmatter; model selection stays in agent configuration.

Each issue completes its own design and review loop. Issues that may collide can plan
and review concurrently; plan approval reserves no file or contract. Implementation
stays serialized by the single lock regardless of apparent independence. For a
one-issue batch, the primary agent is the one-item coordinator and drives the same
specialist workflow.

## Canonical roles and transition

### Canonical identities for new work

Issues started after this revision use the identities below. Each is an independently
registered profile with its own complete body.

| ID | Model | Invoked by | Purpose |
| --- | --- | --- | --- |
| `issue-fixer` | `openai/gpt-6.1-sol` | Batch coordinator | One issue end to end, as in the table above. |
| `issue-designer` | `openai/gpt-6-astra` | `issue-fixer` | Self-contained plan authoring and revision. |
| `design-reviewer` | `openai/gpt-6.1-sol` | `issue-fixer` | Every design or plan revision. |
| `design-reviewer-secondary` | `nvidia/z-ai/glm-5.2` | `issue-fixer`, only when explicitly requested | Optional extra design review. |
| `implementation-manager` | Unchanged | `issue-fixer` | Sole lock holder and implementation orchestrator. |
| `code-developer` | `openai/gpt-6.1-sol` | `implementation-manager` | Source, configuration, tooling, tests, and mechanical integration. |
| `doc-developer` | `opencode-go/claude-haiku-5-5`, no variant | `implementation-manager` | Ordinary documentation. |
| `doc-reviewer` | `openai/gpt-6.1-sol`, explicit exact invocation | `implementation-manager` | Ordinary documentation review. |
| `prompt-developer` | `opencode-go/claude-haiku-5-5`, no variant | `implementation-manager` | Model-facing instruction and prompt assets. |
| `prompt-reviewer` | `openai/gpt-6.1-sol`, explicit exact invocation | `implementation-manager` | Model-facing composition and clean-room review. |

Only the primary batch coordinator may load the coordination skill. No other role loads
it or this document to act. Every leaf denies delegation, staging, commits, and lock
ownership.

### Retained profiles

The following profiles remain registered, byte-for-byte, with their bodies, frontmatter,
permissions, and effective paths unchanged. They are retained because running sessions
and in-flight issues depend on them. They are not aliases and are not dispatched
through any fallback.

| Retained profile | Purpose now | Canonical successor for new work |
| --- | --- | --- |
| `fixer` | Pre-transition issue sessions keep their exact returned IDs and nonce state. | `issue-fixer` |
| `designer` | Pre-transition design revisions. | `issue-designer` |
| `reviewer` | Pre-transition design review, and bootstrap prompt or documentation review. | `design-reviewer`, `doc-reviewer`, `prompt-reviewer` |
| `reviewer-2` | Pre-transition optional design review. | `design-reviewer-secondary` |
| `developer` | Pre-transition and bootstrap source work. | `code-developer` |
| `documenter` | Pre-transition and bootstrap documentation and prompt authoring. | `doc-developer`, `prompt-developer` |

`implementation-manager` keeps its ID. Its future body selects the canonical children
above. Its effective permissions keep its existing child allowances (`developer`,
`documenter`, and `reviewer`) and add the five canonical implementation children. Those
old allowances are retained authorization, not a fallback path in the new body.

Operational rules for the transition:

- Existing issue sessions keep their exact original IDs and nonce state. Never replace a
  running fixer or designer to normalize its name.
- Changing an agent file does not replace the instructions stored in a running session.
  The new bodies describe fresh-session behavior. A catalog reload does not prove that a
  stored body was replaced.
- Old-ID prescriptions are removed only from updated canonical guidance. Preserved role
  bodies and historical reports keep their original identities. Nothing claims the old
  identities were removed or automatically redirected.
- Retirement of retained profiles is a later, owner-controlled decision made after
  active-session dependency evidence and explicit approval. There is no automatic cleanup,
  sunset timer, or inference from this revision that retirement is authorized.

### Finite bootstrap for the refinement that introduces these roles

The refinement that adds the canonical identities is itself implemented with the current
stored identities. That sequencing is a documented, finite bootstrap, not a permanent
alternative workflow:

- The `documenter` (exact `opencode-go/claude-haiku-5-5`, no variant) authors both
  ordinary documentation and model-facing assets, each under a separate, explicit
  assignment. Sections are sequential; no two authors edit a moving file.
- The `reviewer` supplies distinct exact-Sol review, using `openai/gpt-6.1-sol` in a
  session separate from the author, within the scope the manager assigns. It is reported
  as the `reviewer` identity, not as `doc-reviewer` or `prompt-reviewer`. This
  implementation-review authority belongs to the retained profile only for this bootstrap.
  It is not carried into `design-reviewer`, whose canonical procedure is design-only.
- The `developer` applies source, configuration, and native frontmatter changes.
- The current `implementation-manager` runs under its stored body and its existing child
  allowances.
- A target role need not exist to author the document that defines it.

The current bootstrap manager cannot launch the new canonical leaves merely to test them.
Their live invocation is unobserved until a later, genuinely approved assignment runs
under a fresh manager. That adoption limitation is disclosed rather than hidden by a
synthetic lockless manager or a permanent bootstrap fallback.

### Delivery evidence

Delivery of a role change is evidenced by what is observable on the host:

- the effective project catalog body and rules for the affected profile, as returned by
  the installed OpenCode CLI, with the response location verified;
- a fresh session's pre-read procedure and tool summaries;
- an available execution trace and the exact session role and model evidence.

A byte-exact full system or catalog capture is not required where the host does not
expose one. Report what was observed and what was not. A self-report alone never
certifies permissions. A catalog alone never proves that a provider executed a given
role. Do not invent a new endpoint, export secrets, or repeatedly query surfaces that
are unavailable. Earlier evidence that lacked such a capture is not a successful
capture, and it is not relabeled as one.

## Choosing the author and reviewer pair

Classify an asset by its **purpose and consumption**, not by its topic or file extension.

- **Ordinary documentation** is read by people to understand, use, or change the
  system. It uses `doc-developer` and `doc-reviewer`.
- **Model-facing wording** directs model behavior when it is consumed as an instruction.
  It uses `prompt-developer` and `prompt-reviewer`. This includes instructions embedded
  in Markdown or executable hosts, agent bodies and descriptions, prompt templates and
  fragments, skills, and AGENTS wording.
- **Technical documentation about prompts** explains prompt behavior to maintainers and
  is read by people. It is documentation. The role bodies projected from this protocol
  are model-facing instruction and are prompt work.
- **Mixed assets** have sections of both purposes. The manager assigns exact sections to
  each pair and runs them sequentially. No two authors edit a moving file.

A documentation-only change uses the documentation pair. An instruction-only change uses
the prompt pair. Do not add automatic double review of every asset, and do not treat a
design review as a substitute for either pair.

The pair reviews for different purposes:

- `doc-reviewer` checks ordinary-documentation facts against actual source, quality,
  structure, clear progression, reader usefulness, and link correctness.
- `prompt-reviewer` checks positive sufficiency for the role's standing procedure,
  clutter, linkage, whole-composition consistency, current contracts, and retention or
  re-entry in stored sessions. After the last relevant prompt edit it always performs an
  unconditional final clean-room review.

## Role execution contracts

These sections give each role its standing local procedure. Their substance also
projects into that role's own prompt body, so a role never needs this document to act.

### Common obligations

- Know your position in the chain: batch coordinator, then issue fixer, then issue
  designer and design reviewer, then the sole implementation manager, then code,
  documentation, or prompt authors and reviewers. The manager alone invokes the
  implementation authors and reviewers. Act only within your own inputs, outputs, and
  mutation boundary. On failure, never acquire another role's responsibility.
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
- Uncertain publication of Saivage-owned state is governed by the boundary in
  [Uncertain publication boundary](#uncertain-publication-boundary).

### Issue designer

- Inputs: the issue context and the absolute plan path from the issue fixer. For a
  revision, every confirmed material finding.
- Output: a self-contained plan at the issue's working path, containing every subject
  listed under design and plan requirements. An implementation-learning revision records
  that learning in the plan. Report limitations and blockers in the plan or your report.
- Mutation boundary: only the assigned ignored plan file under `docs/working/`. No
  tracked wording, source, configuration, or validation.
- You do not approve the plan or decide its merit. The issue fixer owns that decision.

### Design reviewers

- Inputs: the absolute current plan path. Design reviewers never review implementation
  or model-facing assets; that work belongs to `doc-reviewer` and `prompt-reviewer`.
- Read the complete plan and verify its claims against current code, docs, and AGENTS.
  Apply finding triage and design-value guidance from this document. Look for: durable
  format incompatibility and evidenced source applicability; correctness gaps and hidden
  assumptions; missed root causes and over-local fixes; contract mismatches and missing
  call-site updates; missing or stale documentation; missing validation proportional to
  the risk; unnecessary compatibility code, dead code, or excessive complexity; and
  over-scoped changes that bundle deferrable robustness.
- Each finding states its severity, concrete evidence (file and line, or a quote), the
  affected requirement and its practical consequence, and a separately identified
  suggested correction. Do not raise speculative or preference-only nits.
- Write your complete review to the review artifact path the invoker specifies,
  normally a `review-round-<N>.md` file in the plan's directory under `docs/working/`.
  Files under `docs/working/` are the only files you may write. You do not edit the
  plan, prompt assets, source, or configuration, generate tests, or run mutating
  commands.
- Design or plan review findings return to the issue fixer. The fixer triages them and
  sends confirmed material findings to the issue designer for revision, then repeats the
  full review loop. You never send a design finding to an implementation worker, and
  you never author a replacement design.
- Finish with exactly one verdict on the last line:
  - `NO_MATERIAL_FINDINGS`: no material finding remains. Supported findings may be
    explicitly deferred under triage.
  - `MATERIAL_FINDING_FOUND`: at least one material finding remains.
  Missing evidence or failed tooling is reported as such. It is never approval.
- `design-reviewer-secondary` applies the same design-review criteria, failure and
  reporting boundaries, and verdicts. It is an optional, explicitly requested additional
  design reviewer. It never substitutes for ordinary `design-reviewer` review or for any
  documentation or prompt review.

### Code developer

- Inputs: the absolute approved plan path and the manager's assigned scope.
- Scope: runtime, schema, business logic, tests, fixtures, executable examples,
  tooling, navigation configuration, generators, and non-model-facing source comments.
  Documentation and model-facing wording are not code-developer work.
- Reviewed wording: apply the reviewed text from `doc-developer` or `prompt-developer`
  verbatim, in the same coherent implementation unit as the code it describes, before
  validation and commit. For inline wording in an executable host, apply the reviewed
  exact text. Do not reword it, reformat it for meaning, or invent a replacement. If the
  reviewed text conflicts with a host constraint, report the mismatch instead of editing
  the wording.
- Mixed assignments: first settle and report the source facts the author needs, such as
  names, contracts, actual behavior, and file references. The manager then sequences the
  author's wording after those facts.
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
- Logic findings from prompt or documentation review that concern executable source or
  configuration come to you through the manager. A design-level change never goes through
  you without the issue fixer's redesign loop.
- Mutation boundary: the source and configuration within your assignment only. You do
  not acquire locks, delegate, stage, commit, or push.

### Documentation developer and prompt developer

- Invocation: only by the implementation manager, with exact model
  `opencode-go/claude-haiku-5-5` and no variant. A coordinator, issue fixer, designer,
  reviewer, or other author never invokes them. An author never invokes a reviewer
  itself. The manager does.
- Choice: `doc-developer` writes ordinary documentation. `prompt-developer` writes
  model-facing instructions, prompts, templates and fragments, agent bodies and
  descriptions, skills, and AGENTS wording. Technical documentation about prompts is
  `doc-developer` work. See [Choosing the author and reviewer pair](#choosing-the-author-and-reviewer-pair).
- Inputs: the assigned facts, the plan, and the exact sections or files the manager
  names. Read the actual source to confirm each fact before wording it. For instructions,
  check the composition the text will join, not the text alone.
- Output: the exact replacement documentation or model-facing wording, with its
  selfchecks. Selfchecks are author checks, not independent review.
- Report partial wording and any facts you could not obtain. Await the manager. Route
  source gaps back through the manager.
- Mutation boundary: the assigned documentation or model-facing assets only. No source
  repair, delegation, shell, Lua, or execute use, builds, validation, staging, or commit.

### Documentation reviewer and prompt reviewer

- Inputs: the exact final assets or sections, the assignment, and, for prompt review,
  the root configuration, governing and shared instructions, and the relevant unchanged
  roles as one composed result. The manager names the explicit model override when one is
  required.
- Documentation review checks facts against the actual source, quality, structure, clear
  progression, reader usefulness, and link correctness. It does not review model-facing
  instruction sufficiency.
- Prompt review checks that each prompt gives useful, positive direction for its
  standing procedure; that clutter, duplicated policy, and inventories are absent where
  the role does not need them; that names, paths, IDs, and links resolve; that author and
  reviewer roles stay separate; that no obsolete or contradictory instruction remains;
  and that retained or stored sessions are not stranded. A synthetic future composition
  must be labeled synthetic. It is not evidence of delivered behavior.
- Each finding states its severity, concrete evidence (file and line, or a quote), the
  affected requirement and its practical consequence, and a separately identified
  suggested correction. Do not raise speculative or preference-only nits.
- Write only the assigned review artifact. You do not edit assets, source, or
  configuration, generate tests, or run mutating commands.
- Wording findings go to the manager, which routes them to the matching author. Logic
  findings in executable source or configuration go to the manager, which routes them to
  `code-developer`. A finding that requires a changed design is reported as such, and the
  manager returns it to the issue fixer.
- Finish with exactly one verdict on the last line, as for design review.
- `prompt-reviewer` always performs an unconditional final clean-room review after the
  last relevant prompt edit, against the actual final composition.

## Working files

Create a unique working directory for each issue, such as `docs/working/<date>-<issue-slug>/`.
It holds the current design or plan and one file per adversarial review round.

- `docs/working/` is ignored and must not be committed. It is not canonical
  documentation.
- `docs/working/todo.md` and `docs/working/done.md` are the ignored issue lifecycle
  records. Their writers and timing are described in
  [Batch launch and tracking](#batch-launch-and-tracking) and
  [Singular complete implementation boundary](#singular-complete-implementation-boundary).
  They are never staged or committed.
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
- **Durable-format impact**, including "no impact." For a development-tooling plan that
  touches no Saivage-owned durable contract, state "no impact" briefly. Where a plan does
  touch such a contract, name affected discriminators, source and cutover applicability,
  adoption consequences, and the
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

The issue fixer uses `issue-designer` for all plan authoring and `design-reviewer` for
every design review.

1. Ask the issue designer to write or revise the self-contained plan at the issue's
   unique path. For revisions, pass every confirmed material finding.
2. Invoke the design reviewer on the complete current plan.
3. Triage every finding (see below).
4. When any finding is material, check whether the periodic design-value
   reassessment is due. If it is not due, revise and repeat directly. If it is due,
   continue to revision only on `WORTH_CONTINUING`.
5. When every finding is false, minor, or explicitly deferred and no confirmed
   material finding remains, run the mandatory final design-value reassessment.
   Review closure alone never authorizes freshness checking or implementation.

Invoke the issue designer with `subagent_type: "issue-designer"`, the issue context and
the absolute plan path. Invoke the design reviewer with `subagent_type: "design-reviewer"`
and the absolute current plan path. Save or summarize each review in the issue's working
directory. Pre-transition sessions use their retained identities as described under
[Retained profiles](#retained-profiles).

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

The issue fixer owns this higher-level merit decision. The designer and reviewer do not.
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
  Give the complete issue, evidence, and constraints to the issue designer, then restart
  the full designer and reviewer loop on a self-contained plan. Every redesigned plan is
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

1. Before launch, find or add the issue's existing tracker entry (see
   [Tracker lifecycle ownership](#tracker-lifecycle-ownership)). Give each issue fixer a
   complete issue statement, a unique absolute working-plan path, and the entry identifier
   with the tracker paths.
2. Launch independent initial Task calls concurrently, in the same orchestration turn
   or tool batch when supported, with `subagent_type: "issue-fixer"`. Do not serialize
   design or review merely because issues may touch the same files.
3. Record task-continuity state only in coordinator session context, never in a repository
   file or registry: issue identity and summary, exact returned fixer task ID and its
   identity, plan path, latest disposition, known implementation-lock ownership, and any
   tracker facts still pending. Task IDs, nonces, and handshake records are never tracker
   fields.
4. Handle each return independently. One issue's failure or cancellation does not
   cancel the others unless explicitly requested.

Awaiting each initial fixer in sequence defeats the batch contract. If concurrent Task
launch or exact returned-ID observation is unavailable, report the batch workflow as
blocked. Do not silently weaken it.

### Tracker lifecycle ownership

`docs/working/todo.md` and `docs/working/done.md` record each issue's lifecycle. Only these
roles write them, each limited to facts it observed:

- **Batch coordinator.** Performs intake before launching a new issue. It finds the existing
  entry by identifier and merges into it, keeping that identifier, or adds the entry as Open
  or Analyzed when none exists. At a quiescent boundary it then applies each affected issue's
  latest evidenced lifecycle once. The boundary requires that every previously launched or
  resumed issue call has settled (a returned waiting fixer counts as settled; a fixer that
  could still launch a manager does not), and that no implementation manager is active or
  retains the lock. Settlement comes from task results and reports. The coordinator does not
  inspect or poll the lock to create the boundary. If ownership or settlement is unknown, it
  keeps the facts in session context, reports the update as pending, and edits nothing. It
  does not delay an independent return or an initial design launch.
- **Implementation manager.** Under the lock, keeps only its own issue's factual progress
  current, as described in
  [Singular complete implementation boundary](#singular-complete-implementation-boundary).
- **Issue fixer.** Never writes either file. It reports lifecycle evidence in its disposition,
  as described in [Structured fixer dispositions](#structured-fixer-dispositions).

Each role acts only on the tracker authority in its own effective instructions. The shared
todo skill describes the lifecycle but grants no write authority a session's stored body does
not give it. A session that lacks an assigned action reports the update as pending or blocked,
and no other session takes it over. The adoption rules for running sessions are in
[Final reporting](#final-reporting).

Status may lag while issue work runs concurrently. The coordinator applies each item's latest
evidenced state once, so no per-round notification, intermediate status gate, or queue is
needed. An issue is **Designed** only after its plan has passed review and the fixer has
recorded its approval; waiting for the lock is a note on that entry. The mapping from evidence
to status is defined in
[saivage-todo-protocol](https://github.com/salva/saivage-v3/blob/HEAD/.github/skills/saivage-todo-protocol/SKILL.md).

A completed issue moves its full entry to `done.md` only with its approved-plan record, the
manager's validation results, the commit hashes, and stable read-only reconciliation. If any
of that evidence is missing, the entry stays out of Done and the missing evidence is named.
An abandoned issue is kept as Analyzed with an explicit terminal no-implementation note, not
recorded as Done. Completion records implementation only; aggregate workflow results are
tracked separately. Task IDs, nonces, and handshake records remain session context and are
never tracker fields.

## Final approval and freshness gate

Only after review closes and the final reassessment returns `WORTH_IMPLEMENTING` may
the issue fixer record this approval in session or report state:

```text
Plan approval:
Review closure: <review verdict and round/review artifact>
Final merit outcome: WORTH_IMPLEMENTING
Supporting evidence: <concise evidence covering the four merit conditions>
Examined HEAD: <commit>
```

Immediately before every implementation-manager attempt, including every attempt
after lock waiting, the issue fixer performs a read-only semantic freshness check against:

- the current `HEAD`,
- commits made since its last approval or check,
- and current shared-worktree changes.

Compare the plan's assumptions, named files, contracts, call sites, cleanup,
documentation, and validation. Include affected durable contracts,
discriminator and reference changes, and release or cutover applicability, where the
plan touches them. The format reference helps the source comparison; it does not
certify deployment.

- **`PLAN_STILL_VALID`:** intervening changes do not materially affect the root cause,
  the intended contract, the affected components or call sites, the ordered tasks, or
  the validation. Record the evidence and invoke the manager.
- **`PLAN_REVIEW_REQUIRED`:** a contract or assumption changed, a target was removed or
  substantially rewritten, planned changes conflict, the scope changed, or the
  validation or docs no longer establish correctness. Do not invoke the manager. Send
  the current evidence to the issue designer and repeat the complete review and triage
  loop.
- **`BLOCKED`:** the shared workspace is broken, unclassified, or unsafe for a reliable
  check. Do not mutate or improvise.

A freshness-driven return to design invalidates the prior approval. A newly closed
revision needs a new final `WORTH_IMPLEMENTING` decision and approval record. A
successful check reserves nothing. The manager must still acquire the sole lock. If it
loses contention, the issue fixer waits and repeats freshness after its verified resume.

## Singular complete implementation boundary

Every approved issue fixer invokes Task with `subagent_type: "implementation-manager"` and
the absolute approved-plan path. No primary agent or issue fixer inspects the lock and
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
   - Before each new implementation attempt, the responsible issue fixer re-checks whether
     the stray lock was released. Once it is gone, normal acquisition resumes for
     every later run.
    - As sole writer under this exception, the run also carries the factual tracker duties
      in this section.

2. Capture pre-existing Git status and diff sufficiently to preserve unrelated work and
   to avoid staging or removing it. This includes any existing tracker-file changes, which
   are preserved and never staged.
3. Before any implementation delegation, read the todo protocol and the fresh exact entry for
   the identifier the issue fixer forwarded. Set that entry to In progress, link the approved
   plan, and note the implementing manager role. A missing, ambiguous, or unmatched identifier
   is a blocker: invent no entry, make no tracker edit, and stop before delegation.
   Then decompose the approved plan into assignments. Route runtime, source, configuration,
   and tooling work to `code-developer`. Route ordinary documentation to `doc-developer`,
   with `doc-reviewer`. Route model-facing instructions, prompts, templates and fragments,
   agent bodies and descriptions, skills, and AGENTS wording to `prompt-developer`, with
   `prompt-reviewer`. Mixed work is split into exact sections, each sent to its own pair.
   Settle the source facts first where needed, then author the wording from them. A source
   gap returns to the manager for a separate `code-developer` assignment.
   - A documentation or prompt author (`doc-developer` or `prompt-developer`) runs
     sequentially. Never run one concurrently with another author or with any source
     worker. Never overlap authoring with independent review of the same moving assets.
   - A concurrent `code-developer` group may launch only when every assignment is
     source-only and the manager has positively determined that the assignments do not
     conflict in files, contracts, generated outputs, validation side effects, or
     required order.
4. Await every developer, author, and reviewer and every command each launched.
   Reconcile each result and the combined repository state against the assigned scopes
   and the approved plan. No shared or integration validation, generation, staging, or
   commit may start until all workers and their launched commands have settled.
   - After a prompt author changes prompt assets, the manager invokes `prompt-reviewer`
     with the explicit exact Sol override `openai/gpt-6.1-sol`, in a distinct session,
     for prompt linkage and composition review. After the last edits it repeats the
     final whole-composition review. Ordinary documentation changes go to `doc-reviewer`.
     No review is added to unchanged text or to an asset outside the assignment.
   - Findings return to the matching author, `doc-developer` or `prompt-developer`, for
     wording, or to `code-developer` for logic in source or configuration. Each return is
     followed by affected validation and a repeated final review.
   - A finding that requires a changed design is not implemented by any worker. The
     manager returns it to the original issue fixer for the full redesign loop.
   - Include planned discriminator, producer, consumer, fixture, and reference
     synchronization in this reconciliation and in the completion report, without
     adding another gate or coordination mechanism.
5. Run all validation required by the plan, including focused and broad checks. Handle
   generated artifacts. Selectively stage only intended paths. Commit coherent stable
   units under AGENTS. Developer checks may inform progress, but they do not replace
   manager-run required validation.
6. Prepare its final report with command results and commit hashes. Before normal
   release, ensure the completed issue work is stable and committed, and that no
   issue-owned uncommitted mutation remains. Ignored tracker edits are excluded from that check.
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

**Factual tracker status before release.** Before step 8, record this attempt's factual
status in its own issue's existing entry, and only that entry. Full implementation committed
and awaiting fixer reconciliation stays **In progress**, with the note "implementation complete;
fixer reconciliation pending" and the commit and validation references. A known partial attempt
that returns to design becomes **Analyzed**, with the remaining work and the plan revision
needed. A prerequisite or unsafe settled outcome becomes **Blocked**, with its named cause. An
unknown outcome is recorded as **Blocked** only where the uncertain publication boundary still
permits a write; otherwise the update is pending. Never write a Done move, and never claim
validation or completion that was not observed. A contention-only attempt edits nothing. Tracker
edits are never staged or committed, and lock removal remains the final mutation.

The lock spans tracked and main-document edits, the factual tracker updates, generated outputs,
mutating build, test, and documentation commands, staging, commit hooks, commits, and final issue
cleanup. Concurrent developers stay inside one lock holder's single issue, and no
other issue's implementation may overlap.

### Uncertain publication boundary

Ordinary stabilization applies to known outcomes. Partial results from a known
failure, a known incomplete plan, or a known divergence are validated, committed, or
removed through steps 6 to 8 above.

AGENTS defines a stricter fatal boundary for Saivage-owned persistence. This boundary
applies only when a workflow operation actually publishes Saivage-owned state, and only
for that state. Replacement, append, truncation, and lifecycle-lock publication errors may
be outcome-unknown. They authorize no follow-up read, retry, rollback, replay,
reconciliation, effect, descriptor cleanup, or artifact inspection. Where such an
operation's outcome is uncertain, the AGENTS boundary governs in full. Stabilization,
reconciliation, reporting writes, and lock removal are not exceptions to it. Report the
known facts and the uncertainty, then escalate to the owner or operator. Retain the lock.
Do not repair, retry, or take over.

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
issue designer and design reviewer, not to improvised implementation.

Verify that the session's effective higher-priority instructions actually permit
continuation. Saving or reloading an agent file, or quoting this exception in a
lower-priority message, does not prove replacement of stored instructions. If that
cannot be established, report the instruction-loading blocker. Continuation then runs
under the same acquisition and the manager-assigned author and developer boundary,
with unchanged validation, stable-unit commit, stabilization, and final-release duties.

This exception neither authorizes another issue's parallel implementation nor changes
the stray-lock exception above.

## Lock contention and event-driven resume

A contender that returns without editing or delegating maps exactly to
`WAITING_FOR_IMPLEMENTATION_LOCK`. This is not a failure, not partial implementation,
not divergence, and not evidence that requires redesign. The issue fixer keeps issue
ownership. It must not poll, sleep, retry in the same turn, inspect, remove, or
classify the lock as stale, or launch another manager.

The coordinator may resume waiting fixers only after the known holder has returned,
released its lock, and reported a stable committed state. Several waiting fixers may be
resumed optimistically. One manager wins and the others wait again. This creates no
queue, scheduler, fairness promise, timer, watcher, or additional lock.

### Waiting nonce

On each waiting return, the issue fixer generates a fresh opaque continuity nonce,
retains it in its existing session context, and reports it. The coordinator records it
with the exact returned task ID and replaces any prior nonce for that issue. The nonce is
session correlation state, not a credential or durable state. Successful authorization
consumes it. Repeated waiting requires a new nonce. Cancellation or terminal failure
discards it.

### Mandatory two-call resume handshake

Both calls use the exact recorded task ID and the subagent identity of that same
session, which is `issue-fixer` for a new issue or the retained `fixer` for a
pre-transition session:

```text
subagent_type: "<the session's own identity>"
task_id: "<exact recorded task ID>"
```

**Call 1, challenge.** The coordinator does not include the expected nonce. Its prompt
unconditionally forbids tools, edits, commands, and every mutation. It asks only for the
issue identity, the plan path, the prior `WAITING_FOR_IMPLEMENTATION_LOCK` disposition,
and the nonce retained in session context. If any value is unavailable, the issue fixer
returns `BLOCKED` without tools.

The coordinator independently verifies that the Task result's returned task ID is
byte-for-byte identical and that all retained values exactly match its record.

Any missing or mismatched value, task-ID mismatch, or tool use or mutation makes the
issue `BLOCKED`. Make no Call 2. An invalid ID may create a new session, but that session
cannot know the undisclosed nonce, and its output is never adopted.

**Call 2, authorization.** Only after Call 1 passes, invoke the same exact task ID again.
Authorize the read-only freshness gate and, only if the plan is still approved, manager
delegation. Before using any tool, the issue fixer confirms from its own context that the
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

The issue fixer performs read-only reconciliation only. It inspects the manager report,
the commit hashes, `HEAD`, status and diff, and the manager-supplied validation evidence.
It must not run any command that can mutate files, regenerate artifacts, stage, commit,
or finish implementation. Reconciliation never authorizes a follow-up action after an
uncertain publication that the [uncertain publication boundary](#uncertain-publication-boundary)
governs. Such a report is `BLOCKED`, and it is not a basis for further mutation.

- If the approved plan is fully executed with no divergence or redesign-worthy learning,
  and the repository is stable, report issue completion.
- If work remains, the run is partial, the implementation diverged, or learning changes
  the design, return the issue to the issue designer and the complete adversarial review
  loop. Planning-file edits remain allowed. A later implementation attempt requires a new
  freshness check and a new manager lock.
- A design or logic finding that requires a changed design follows the same route:
  manager to issue fixer, then the designer and design reviewer loop. It never becomes a
  reviewer-authored redesign or an improvised implementation.
- If the manager could not stabilize and retained the lock, report `BLOCKED`. No issue
  implementation resumes until explicit owner or operator verification and repair. The
  original interrupted holder may continue only through **Interrupted owner
  continuation**, not through the contention-only waiting handshake or a new manager
  attempt.

## Structured fixer dispositions

Every issue fixer return to a coordinator starts with exactly one of these dispositions:

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
Tracker evidence: <entry identifier or unavailable>; lifecycle Designed with the approved plan above
Resume condition: known lock-holder run has returned and released its lock
Coordinator action: retain this nonce with the exact fixer task ID, then use the two-call handshake; do not launch a replacement
```

The waiting return's tracker evidence is `Designed` only because it carries the approval block
above. Waiting itself is a note on the entry, not a separate status. The coordinator records the
Call 1 result as:

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

The issue fixer generates no new implementation evidence after the manager returns. It never
writes `todo.md` or `done.md`, before or after the return. Every disposition report carries a
`Tracker evidence` line naming the entry identifier, the lifecycle state the evidence supports,
the manager's applied or pending tracker status when a manager ran, and any pending correction.
The coordinator uses that line at its next safe boundary.

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
  applies. The issue fixer reconciles read-only, then either returns to design and review
  or reports failure. Other issues resume only when the report, the lock, and the
  repository state are all safe.
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

Only when every issue disposition is exactly `COMPLETED` or `ABANDONED`, no issue fixer has
pending implementation work, and the implementation lock is absent may the coordinator
run one final read-only or harmless aggregate validation to test batch coordination.
Any issue in `WAITING_FOR_IMPLEMENTATION_LOCK`, `BLOCKED`, `FAILED`, or `CANCELLED`
prevents it. The same gate governs the passive role checks below.

### Passive role checks

When the approved plan requires them, the coordinator may run fresh passive checks of
`issue-designer`, `design-reviewer`, an explicitly requested `design-reviewer-secondary`,
and `implementation-manager`, through the edges those roles already allow, and of the
main-only skill access through the build and plan primaries. These checks are the only
coordinator-initiated invocations of those roles outside ordinary issue work. They are
governed as follows:

- Each invocation is a fresh session with no tools, no edits, no lock acquisition, and no
  delegation. The manager session only explains its decisions. It reads no plan, acquires
  no lock, and delegates nothing.
- They never launch implementation leaves directly: no `code-developer`, `doc-developer`,
  `prompt-developer`, `doc-reviewer`, `prompt-reviewer`, or retained developer or
  documenter profile. Only the implementation manager invokes those roles.
- They add no new validation gate, issue disposition, or approval. Their observations
  are evidence about role availability and boundary behavior, not issue outcomes. A
  voluntary refusal is not proof of a permission boundary; effective deny and catalog
  evidence provides that.
- They never substitute for issue design review, implementation review, or manager
  delegation.

Aggregate validation never stages or commits. Any unexpected tracked or generated diff
fails the aggregate check and is reported. It is never repaired outside the manager
boundary.

For workflow changes that require Task continuity validation, run the plan's harmless
live smoke exactly as written. It uses concurrent synthetic issue-fixer sessions,
exact-ID recording, a nonce-free and tool-free Call 1, and a verified same-ID Call 2, and
it checks for a mismatch safely. If Task concurrency, IDs, resume, nonce retention, or
tool-free evidence is unavailable, report workflow validation as `BLOCKED`. Do not
substitute a sequential, one-call, or text-only imitation.

## Prohibited mechanisms

Do not introduce any of the following:

- parallel issue-level implementation;
- multiple lock-holding managers;
- direct primary-agent or issue-fixer implementation;
- extra locks, lock takeover, or stale-lock classification;
- polling, sleeps, retry timers, watchers, queues, or schedulers;
- registries, replacement fixers, aliases, dispatch fallbacks, loaders, or branches,
  worktrees, clones, or merge orchestration.

Do not run documentation or prompt authoring concurrently with any other worker. Do not
run concurrent developer assignments that overlap in files, contracts, outputs,
validation side effects, or ordering. Do not invoke `code-developer`, `doc-developer`,
`prompt-developer`, `doc-reviewer`, `prompt-reviewer`, or a retained developer or
documenter profile directly from a primary agent, issue fixer, or designer. Only the
implementation manager invokes them.

## Final reporting

Report the issue or issues, the core design choice, the plan path or paths, the tracker entry
identifiers with the lifecycle applied or pending, the adversarial review and final merit
outcomes, material findings, the main documents and files changed, the author and reviewer identities used for documentation and model-facing
assets, prompt-review evidence where model-facing assets changed, manager-run validation
commands and results, commit hashes, repository stability, residual risks and follow-ups,
and any abandoned, blocked, or cancelled issues. When a session used a retained profile
rather than a canonical identity, say so.

Do not commit `docs/working/` artifacts. A change to agent bodies in source describes
fresh-session behavior. Ordinary, authorized fresh development sessions use the new profiles
without a separate adoption approval. A running session keeps the stored agent body it already
has, and a changed agent file is not a replacement for that body. A shared skill is different:
a running session whose role permits it may later load the changed skill file, so it can
consume the updated shared guidance. That consumption does not replace the stored body, and it
does not expand a narrower effective permission. The session's stored authority still decides
what it may do, so a missing allowance for a tracker action is reported as pending or blocked,
never handed to another session. Consumption and adoption are separate facts; a file edit alone
proves neither. The final report must not claim that a running session has adopted the change
unless it observed the consumption or the replaced body. Do not restart OpenCode, switch running
sessions, or replace stored instructions to force adoption. Actual deployment, service
operations, and other separately controlled live actions keep their own distinct approval.
The current stored implementation manager does not launch the canonical leaves merely to
manufacture execution evidence, so their live invocation remains untested and must be
disclosed as such.
