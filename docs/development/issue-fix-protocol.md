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

### Direct trivial fixes

Issue fixes go through this protocol, except a genuinely simple, clearly understood fix that
the acting `build` or `plan` primary does directly, without the protocol. The primary judges
triviality from the fix itself. A direct fix needs no plan, approval, score, threshold,
checklist, tracker entry, report, or protocol run. In case of doubt about triviality, impact,
remedy, or scope, use the full protocol. If a presumed trivial fix turns out to be uncertain
during direct work, stop direct implementation and continue under the full protocol. Report the
effects that already occurred, and do not invent an exemption record.

No content category is excluded by rule. The judgment rests on the actual impact, remedy, and
scope. A direct fix keeps focused validation, scoped commits, authentication and secret
protection, unrelated-work preservation, subject-specific rules, and the exact-model
author and reviewer pair for any model-facing or documentation wording. Direct work is not an
issue-team lifecycle.

For a clearly trivial direct wording fix, the acting primary assigns the appropriate author
and a distinct reviewer itself. The root OpenCode configuration explicitly allows `build` and
`plan` to invoke four subagents: `doc-developer`, `doc-reviewer`, `prompt-developer`, and
`prompt-reviewer`. It explicitly denies `code-developer`, `developer`, and `documenter` to both
primaries. This document grants no other direct subagent authority, so a direct source or
configuration change is made by the primary itself. Within a full issue run, the implementation
manager alone dispatches the authors and reviewers.

Inline model-facing wording inside an executable host follows the same author and reviewer pair.
Inline location alone does not make a change an issue run or a direct fix; the triviality test above
still decides it. The author returns the exact replacement text, and a distinct reviewer reviews that
text. A capable acting primary then applies the reviewed text verbatim, within its actual edit
authority. It does not reword the text, reformat it for meaning, or invent a replacement. The direct
route invokes no `code-developer`, and neither the author nor the reviewer edits the host.

Triviality does not widen edit authority. A `plan` primary does not gain permission to edit an
executable host because the fix is trivial. Where the acting primary lacks actual edit authority for
the host, it does not work around that restriction. It uses task-appropriate build or invocation
authority where that is available, or it reports the actual limitation and stops the application. This
section grants no permission, adds no workaround tool, and creates no categorical exclusion of inline
assets.

If the reviewed text conflicts with a host constraint or does not fit the host, the primary does not
silently rewrite it. It reports the mismatch and returns the wording through its own invocation to the
matching author, `doc-developer` or `prompt-developer`, for revised exact text. That revised text is
reviewed again before application.

Corrections keep their owners in a direct fix. A source-fact or logic finding is the acting primary's to
correct within its edit authority. A wording finding returns through the primary to the matching author,
and the primary applies the revised text verbatim. If a correction needs a changed design, or its scope
becomes uncertain, the full protocol applies. Each changed final input receives its affected validation
and a fresh review of the actual final input.

Review of a replacement before it is applied is not review of its final composition. After the primary
integrates the text, the reviewer reviews the actual final result, including the applied host. For a
prompt asset, that final review is described under
[Documentation reviewer and prompt reviewer](#documentation-reviewer-and-prompt-reviewer): linkage,
positive sufficiency and whole-composition review, and a separately identified, unconditional clean-room
assessment. One invocation in a distinct session may perform both sequentially on the same final input
when its report identifies each activity.

## Team and ownership

Every issue has one issue fixer, one designer and design-reviewer loop, and at most
one implementation manager holding the lock at a time.

| Role | Owns | Must not |
| --- | --- | --- |
| Batch coordinator (main primary agent) | Accepts the batch; performs intake of each issue's existing tracker entry before launch; assigns one unique working path per issue; launches and tracks issue fixers one whole run at a time; records returned session IDs and dispositions in its own session context; applies each issue's factual lifecycle to the ignored tracker files at a quiescent boundary; decides when a waiting fixer may resume; runs aggregate acceptance once allowed. | Take over any issue's design, review, or implementation; invoke an issue designer, design reviewer, implementation author, or implementation reviewer for ordinary issue work; request manager implementation directly; write a tracker file while an issue call that could launch a manager is unsettled; move an entry to Done without its completion evidence. The exception is, for a clearly trivial direct wording fix, the author and reviewer pair under [Direct trivial fixes](#direct-trivial-fixes). |
| Issue fixer (`issue-fixer`) | One issue end to end: designer and design-reviewer delegation, finding triage, design-value reassessment, final approval record, freshness decisions, implementation-manager delegation, read-only reconciliation, and reporting, including the issue's tracker evidence. Writes only ignored planning and review artifacts. | Write `docs/working/todo.md` or `docs/working/done.md`; edit implementation or model-facing assets, run validation or generators, stage or commit, author wording, invoke any developer, documenter, or implementation reviewer, or run prompt or documentation review itself. |
| Issue designer (`issue-designer`) | Writes and revises the issue's self-contained plan, including revisions prompted by review or implementation learning. | Approve its own plan or decide merit. |
| Design reviewer (`design-reviewer`) | Adversarially reviews every current design or plan revision. Read-only apart from its assigned review artifact. | Edit any plan, asset, source, or configuration; take the issue fixer's merit decision; review implementation assets. |
| Optional secondary design reviewer (`design-reviewer-secondary`) | Only when a requester explicitly asks for it: the same design-review criteria, failure and reporting boundaries, and verdicts as `design-reviewer`. | Substitute for ordinary design review, or for any documentation or prompt review. |
| Implementation manager (`implementation-manager`) | The sole implementation orchestrator and the only agent that invokes implementation authors and reviewers. Holds the one lock covering all implementation mutation, validation, generated artifacts, staging, commits and stabilization. Under that lock it keeps only its own issue's existing factual tracker entry current, and never moves an entry to Done. | Author implementation or model-facing wording directly; write any tracker entry other than its own issue's factual status; delegate a tracker write. |
| Code developer (`code-developer`) | Leaf implementer of manager-assigned runtime, source, configuration, tooling, tests, fixtures, and navigation work. Supplies source facts. Mechanically applies reviewed inline wording. | Author documentation or model-facing wording, delegate, acquire or release locks, stage, or commit. |
| Documentation developer (`doc-developer`) | Ordinary documentation assigned by the implementation manager, or by the acting primary for a clearly trivial direct fix: facts, structure, clear progression, explanation, and reader usefulness. | Author model-facing instructions, delegate, use shell, Lua, or execute tools, build, validate, stage, commit, or invoke a reviewer. |
| Documentation reviewer (`doc-reviewer`) | Independent review of ordinary documentation for facts, quality, structure, and progression, invoked by the implementation manager or, for a direct fix, the acting primary. Read-only apart from its assigned review artifact. | Edit any asset; review model-facing instructions; take the author's role. |
| Prompt developer (`prompt-developer`) | Model-facing wording assigned by the implementation manager, or by the acting primary for a clearly trivial direct fix: instructions, prompts, templates and fragments, agent bodies and descriptions, skills, and AGENTS wording. | Author ordinary documentation, delegate, use shell, Lua, or execute tools, build, validate, stage, commit, or invoke a reviewer. |
| Prompt reviewer (`prompt-reviewer`) | Independent review of model-facing assets as one composed result, including the unconditional final clean-room pass, invoked by the implementation manager or, for a direct fix, the acting primary. Read-only apart from its assigned review artifact. | Edit any asset; review ordinary documentation as its only purpose; take the author's role. |

Model-facing assets are never authored by the same agent that reviews them. Ordinary
documentation is written by `doc-developer` and checked by `doc-reviewer`. Model-facing
instructions, prompts, templates, fragments, agent bodies, skills, and AGENTS wording
are written by `prompt-developer` and checked by `prompt-reviewer`, which the implementation
manager invokes with the explicit exact override `openai/gpt-6.1-sol`. For a clearly trivial
direct fix, the acting primary invokes the same pair the same way. Skills carry no model
frontmatter; model selection stays in agent configuration.

Each issue completes its own design and review loop, but the batch coordinator selects
only one whole issue-fixer run at a time. That run covers design, review, freshness,
manager handoff, and read-only reconciliation, and it is the unit of selection. Plan
approval reserves no file or contract and does not permit another issue to start.
Implementation stays serialized by the single lock. The coordinator's sequencing is
scheduling discipline, not a replacement for that lock. For a one-issue batch, the
primary agent is the one-item coordinator and drives the same specialist workflow.

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
| `doc-developer` | `opencode-go/claude-haiku-5-5`, no variant | `implementation-manager`; acting `build` or `plan` primary for a clearly trivial direct fix | Ordinary documentation. |
| `doc-reviewer` | `openai/gpt-6.1-sol`, explicit exact invocation | `implementation-manager`; acting `build` or `plan` primary for a clearly trivial direct fix | Ordinary documentation review. |
| `prompt-developer` | `opencode-go/claude-haiku-5-5`, no variant | `implementation-manager`; acting `build` or `plan` primary for a clearly trivial direct fix | Model-facing instruction and prompt assets. |
| `prompt-reviewer` | `openai/gpt-6.1-sol`, explicit exact invocation | `implementation-manager`; acting `build` or `plan` primary for a clearly trivial direct fix | Model-facing composition and clean-room review. |

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
| `fixer` | Pre-transition issue sessions keep their exact returned IDs and their stored procedure. | `issue-fixer` |
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

- Existing issue sessions keep their exact original IDs. Never replace a running fixer or
  designer to normalize its name.
- A changed agent file does not replace the body stored in a running session, and a catalog
  reload does not prove that a stored body was replaced. The new bodies describe fresh-session
  behavior. Shared instructions reach a running session by different routes. Global and upward
  `AGENTS.md` files and existing local configured instruction files are updated before that session's next model
  request, so their change can apply while its role body stays old. A nested `AGENTS.md` already
  discovered stays in the session's history and is not refreshed automatically. A skill already
  loaded keeps its earlier text, and a later permitted load can read the changed file. Neither an
  edit nor a read proves adoption, and a read grants no authority that the reader's effective
  instructions do not already give.
- A retained session whose stored procedure still carries a superseded mechanism (the
  continuity nonce, its challenge and authorization, cancelled-wait re-entry, or an exceptional
  lock recipe) continues only through an ordinary resume that forwards the owner's superseding
  direction, as described under [Ordinary resume](#ordinary-resume). Its stored body is not
  replaced. A conflict that the forwarded direction does not settle is reported as a blocker.
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
- Reports serve their recipient. A user reply gives the outcome and any action, decision, or
  blocker the user needs, and it lists paths only when the user needs them. An internal handoff
  gives the artifacts, the exact text when it must be applied elsewhere, review and validation
  evidence, commit references, effects, uncertainty, and the settlement facts the next role needs.
  State each fact once at its owning handoff, refer to the accessible artifact afterwards, and
  repeat a fact only when it changed or the recipient lacks it. Do not repeat fixed formal blocks.
- Uncertain publication of Saivage-owned state is governed by the boundary in
  [Uncertain publication boundary](#uncertain-publication-boundary).

### Issue designer

- Inputs: the issue context and the absolute plan path from the issue fixer. For a
  revision, every confirmed material finding.
- Output: a self-contained plan at the issue's working path that gives the design and the
  ordered implementation work it requires, as described under design and plan requirements.
  An implementation-learning revision records that learning in the plan. Report limitations
  and blockers in the plan or your report.
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
- Judge plan sufficiency by consequence. The test is whether the next role can implement the
  chosen design safely and verify the result from the plan and the named current sources.
  Raise a finding only for missing or wrong information that matters to that outcome, and state
  its practical consequence. Absent headings, a prescribed layout, an undeclared optional subject,
  or a missing statement that a subject is unaffected are not findings by themselves. Do not use
  the former subject checklist as the review standard.
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
  This includes every source producer, consumer, test, and fixture that a contract change
  in the assignment touches. Authoring documentation or model-facing wording is not
  code-developer work. Reporting the documentation impacts of a change, and mechanically
  applying reviewed wording that the manager supplies, are.
- Reviewed wording: when the manager supplies reviewed text from `doc-developer` or
  `prompt-developer`, apply it verbatim, in the same coherent implementation unit as the
  code it describes, before validation and commit. For inline wording in an executable
  host, apply the reviewed exact text. Do not reword it, reformat it for meaning, or
  invent a replacement. If the reviewed text conflicts with a host constraint, report the
  mismatch instead of editing the wording. Applying reviewed text is mechanical
  integration; it does not make you its author.
- Documentation and wording impacts: for an ordinary contract change or a mixed
  assignment, first settle and report the source facts an author needs, such as names,
  contracts, actual behavior, file references, and the exact documentation impacts. The
  manager assigns each impact to the matching author by consumption and sequences that
  author's wording after those facts. Your source phase ends at this handback. The manager
  completes and reconciles all required documentation in the same changeset before
  validation and commit, so a handback does not by itself finish the issue.
- A source gap the plan did not assign goes back to the manager for a separate developer
  assignment. Do not absorb it silently.
- Focused checks: run the focused checks needed to verify your own source changes, then
  report each command, its result, and the input scope it covered. The manager owns the
  integrated assurance. It may reuse your successful check when its relevant inputs are
  unchanged in the final result, or it may rerun the check, as
  [economical selection and reuse](../validation.md#economical-selection-and-reuse) directs.
- Generation: do not run build or generated-artifact generation unless your assignment
  names it.
- Concurrency: develop concurrently only when the manager has assigned source-only work
  it has determined does not conflict. Settle every command you launched before reporting.
- Format and cutover: for an approved owner-local discriminator change, synchronize the
  producers, consumers, and fixtures in your assignment under the AGENTS storage policy.
  Do not author durable-format-reference wording. Apply manager-supplied reviewed reference
  text only verbatim, under Reviewed wording, when the manager assigns it. Otherwise report
  the format facts to the manager. In either case, report the affected family and
  discriminator, old and new contracts, applicable source and cutover evidence, adoption
  consequences, and the exact references needing updates. Report unknown applicability as
  unknown and never invent it. Return a material format or cutover mismatch to design
  through the manager. Never silently normalize retained data.
- A plan that is materially wrong means a different design is needed. Stop. Do not
  improvise a replacement. Report back so the designer can revise and the reviewer can
  re-review before implementation continues.
- Logic findings from prompt or documentation review that concern executable source or
  configuration come to you through the manager. A design-level change never goes through
  you without the issue fixer's redesign loop.
- Mutation boundary: the source and configuration within your assignment only. You do
  not acquire locks, delegate, stage, commit, or push.

### Documentation developer and prompt developer

- Invocation: the implementation manager invokes them within an issue run. The acting
  `build` or `plan` primary invokes them only for a clearly trivial direct wording assignment,
  under [Direct trivial fixes](#direct-trivial-fixes). Both use exact model
  `opencode-go/claude-haiku-5-5` and no variant. A coordinator, issue fixer, designer,
  reviewer, or other author never invokes them. An author never invokes a reviewer itself;
  the invoking owner does.
- Choice: `doc-developer` writes ordinary documentation. `prompt-developer` writes
  model-facing instructions, prompts, templates and fragments, agent bodies and
  descriptions, skills, and AGENTS wording. Technical documentation about prompts is
  `doc-developer` work. See [Choosing the author and reviewer pair](#choosing-the-author-and-reviewer-pair).
- Inputs: the assigned facts, the plan or direct assignment, and the exact sections or files the
  invoking owner names (the implementation manager in an issue run, or the acting primary in a
  direct fix). Read the actual source to confirm each fact before wording it. For instructions,
  check the composition the text will join, not the text alone.
- Output: when the author edits the assigned file in place, the report names the files and
  sections changed, the sources read, the facts confirmed and not obtained, the links not
  verified, the selfchecks, and any text that belongs to the other pair. The file is the
  artifact, so the text is not echoed back. When the text must be applied elsewhere, such as
  an inline host, the author returns the exact replacement text with the same report. The
  route's mechanical applicator applies it verbatim: `code-developer` in an issue run, or the
  acting primary in a direct fix that has actual edit authority for the host. Selfchecks are author checks, not independent review.
- Report partial wording and any facts you could not obtain. Await the invoking owner. Route
  source gaps back through that owner.
- Mutation boundary: the assigned documentation or model-facing assets only. No source
  repair, delegation, shell, Lua, or execute use, builds, validation, staging, or commit.

### Documentation reviewer and prompt reviewer

- Inputs: the exact final assets or sections, the assignment, and, for prompt review,
  the root configuration, governing and shared instructions, and the relevant unchanged
  roles as one composed result. The invoking owner (the implementation manager, or the acting
  primary for a direct fix) names the explicit model override.
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
- Findings go to the invoking owner. In an issue run, the manager routes wording findings to
  the matching author and source-fact or logic findings in executable source or configuration to
  `code-developer`. In a direct fix, the acting primary routes wording findings back through
  itself to the matching author, and it makes any source-fact or logic correction itself within
  its actual edit authority. If that scope becomes uncertain, the full protocol applies. A finding
  that requires a changed design is reported as such: in an issue run the manager returns it to
  the issue fixer, and a direct fix routes it to the full protocol.
- Finish with exactly one verdict on the last line, as for design review.
- `prompt-reviewer` review of a changed prompt asset covers two final activities on the
  actual final composition, after the last relevant edit and including any inline
  integration: (a) linkage, positive-sufficiency, and whole-composition review; and (b) a
  separately identified, unconditional final clean-room assessment, which is required even
  when activity (a) found nothing. It is not an incremental findings check. One invocation
  in a session distinct from the author may perform both sequentially on the same final
  input, and its review must identify each activity. A second invocation is not required
  merely because there are two activities. An author's selfcheck, a generic passing
  verdict that does not identify the clean-room assessment, or a review of wording made
  before its inline integration does not complete either activity. A report that lacks
  this evidence is completed by an independent `prompt-reviewer` on the actual final input,
  never presumed passed. A later relevant change requires fresh review of the affected
  final composition and another clean-room assessment. Relevant changes include a
  correction, a validation-driven edit, an integration, and a change to shared or governing
  instructions, to the host, or to the configuration that affects the asset. The same
  activities apply when the acting primary runs an authorized trivial direct wording
  assignment.

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

Each design or plan is one self-contained document, concise and proportional to the risk.
Its content sets its structure: no headings or section order are required, and the document
never states that a subject is inapplicable. Readers must not need the review history, and
the document does not repeat policy inventories. It gives the next roles what they need to
implement and verify without guessing:

- the evidenced problem and its cause, and why the proposed layer owns that cause;
- the chosen design, with the decision-relevant alternatives and tradeoffs, and the risks,
  rollback considerations, and open questions that affect the decision or safe
  implementation;
- concrete, ordered, dependent work naming the affected owners and contracts, with every
  coordinated change a contract requires and the cleanup it makes obsolete;
- the documentation the work requires: each affected main document and its change, plus
  corrections to related stale main documentation. Documentation is implementation work,
  and the working plan itself does not count.

For a Saivage-owned durable contract, settle the consequences under the
[AGENTS storage policy](https://github.com/salva/saivage-v3/blob/master/AGENTS.md#durable-format-versioning)
and name the required updates to the
[durable format reference](../architecture/durable-format-changes.md). Reject equal-version or
unreleased claims that are unsupported. Defer non-essential robustness and rare edge cases
unless deferral blocks the core fix or leaves the system unsafe.

Validation follows the affected semantic owners and the economical selection in
[docs/validation.md](../validation.md#economical-selection-and-reuse). Broader checks are
justified only by a demonstrated cross-cutting risk. Substitute no prose-regex assertions,
repository-wide spelling bans, or unrelated test matrices for semantic evidence. Name the
prompt or documentation author and reviewer pair by purpose for any model-facing or
documentation wording.

## Native delegation and settlement

Development roles invoke one another through the exposed native subagent tool. The
published OpenCode V2 contract is in the [OpenCode tools documentation, Subagent section](https://opencode.ai/docs/tools/#subagent).
Its essentials: the caller supplies an agent ID, a short description, and a complete
prompt; the call returns a `sessionID`; a continuation names the same agent and passes
that exact `sessionID` to continue the same child conversation.

Published V2 behavior runs a subagent in the background. The call returns at once with
the session ID, and the parent receives a subagent message when the child goes idle and
again after each later round. Any delivery option, default, or wrapper detail belongs to
the tool contract that the calling session actually exposes. This document does not publish
a wrapper signature, assume a universal blocking or background default, or name a universal
tool namespace.

Settlement is separate from routing:

- A session ID is routing state. It is not a result, not approval, and not evidence that
  the child finished or that its work is safe.
- A worker's result is its substantive final report. For asynchronous delivery that report
  arrives with the round's completion or idle message. An idle message without the report
  does not prove success, command settlement, lock release, or repository stability.
- A settled synchronous return may carry both the routing ID and the report.
- A missing, partial, or ID-only result is unsettled. The caller takes no step that depends
  on it, reports it with the recorded session ID, and launches no replacement.
- Continuation is one ordinary call to the original agent identity with the exact recorded
  session ID, made only at an eligible boundary. It is not polling, a probe, or an ID
  comparison, and it approves nothing.

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

Invoke the issue designer through the exposed native subagent tool with agent
`issue-designer`, a short description, and a prompt giving the issue context and the
absolute plan path. Invoke the design reviewer with agent `design-reviewer` and a prompt
giving the absolute current plan path. Triage begins only after that round's substantive
report has returned, as [Native delegation and settlement](#native-delegation-and-settlement)
requires. Save or summarize each review in the issue's working directory. Pre-transition
sessions use their retained identities and recorded session IDs as described under
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
  fifth review round that has confirmed material findings since the last
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
- **`ABANDONED`:** an intentional terminal decision not to implement further issue scope,
  because no credible compliant redesign is worthwhile. Examples are a disproved premise,
  necessary complexity that outweighs the concrete value, or an objective that conflicts
  with AGENTS. Before any implementation it abandons the proposed fix. After stabilized
  partial delivery it abandons only the remainder the fixer identifies, and it is reached
  only at a gate of the complete designer and reviewer loop, never directly from a manager
  report. It is neither `COMPLETED`, a failure, nor a cancellation. Perform no further
  freshness check or implementation after the decision; this does not shortcut review.
  Report the evidence, the failed conditions, why precise constraints cannot save the
  remaining scope, and the delivered and abandoned scope separately. Do not relaunch it
  automatically.
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
2. Launch one new issue fixer at a time, with agent `issue-fixer` through the exposed native
   subagent tool. Its whole
   run is the unit of selection. Do not launch the next new issue, or resume any waiting
   fixer, while the selected fixer can still launch an implementation manager. Do not
   launch issue fixers in parallel. Plan approval, an apparently free lock, or an issue's
   apparent independence is not a reason to fan out, because the extra calls would only
   contend for the lock and waste work.
3. Record session-routing state only in coordinator session context, never in a repository
   file or registry: issue identity and summary, exact returned fixer session ID and its
   identity, plan path, latest disposition, known implementation-lock ownership, and any
   tracker facts still pending. Session IDs are routing state and are never tracker fields.
4. Handle each return before selecting the next run. One issue's failure or cancellation
   does not cancel the others unless explicitly requested, and it does not make other work
   eligible while settlement or shared-worktree safety is unknown.

Each selected run settles before the next one is chosen. Concurrent initial launches of
issue fixers are therefore not part of this workflow. If launching the selected fixer,
resuming it, or observing its exact returned session ID is unavailable, report the batch
workflow as blocked. Do not silently weaken it.

### Selecting the next run

Advance only on evidenced settlement:

- A `COMPLETED` issue advances only with its full evidence: the approval facts, manager
  validation, commit hashes, and stable read-only reconciliation.
- A partial or redesign return that continues the same fixer's design loop keeps that fixer
  selected until it returns.
- An `ABANDONED`, `BLOCKED`, `FAILED`, or `CANCELLED` return can allow the next run only
  after its launched calls have settled and the shared worktree is established safe. Such a
  return is never converted to success and is never retried automatically.
- Unknown settlement, a retained lock, a timeout, a missing result, or an unsafe worktree
  blocks every further implementation-capable launch and resume.
- Lock inspection, polling, sleeps, speculative manager calls, and new approval ceremonies do
  not establish eligibility.

At each eligible boundary the coordinator selects exactly one next run: either one new issue,
or one recorded waiting fixer whose known lock holder has returned, released its lock, and
reported a stable committed state, or one cancelled waiter whose owner has directed its
continuation, as described in
[Owner-directed continuation of a cancelled waiter](#owner-directed-continuation-of-a-cancelled-waiter).
It never selects two. The protocol sets no priority between new issues, waiting fixers, and
cancelled waiters. The selected fixer is resumed by one ordinary call, as described in
[Ordinary resume](#ordinary-resume), and the coordinator then awaits that entire run. Every other
waiter, cancelled waiters included, stays dormant, with its exact session ID and identity unchanged,
until a later eligible boundary. If the selected waiter's freshness check requires design review,
its own design and review loop continues, and no other waiter is selected in its place. Waiters
never race for the lock.

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
  holds no settled return for unrelated tracker work beyond the bounded update itself, and the
  next launch or resume waits until that update finishes.
- **Implementation manager.** Under the lock, keeps only its own issue's factual progress
  current, as described in
  [Singular complete implementation boundary](#singular-complete-implementation-boundary).
- **Issue fixer.** Never writes either file. It reports lifecycle evidence in its disposition,
  as described in [Structured fixer dispositions](#structured-fixer-dispositions).

Each role acts only on the tracker authority in its effective instructions: its stored body
together with the shared instructions that currently take effect for it, under their priority.
The shared todo skill describes the lifecycle but grants no write authority those effective
instructions do not give. A session that lacks an assigned action, or meets an unresolved
instruction conflict, reports the update as pending or blocked, and no other session takes it over. The adoption rules for running sessions are in
[Final reporting](#final-reporting).

Status may lag while the selected issue run is in progress. The coordinator applies each item's latest
evidenced state once, so no per-round notification, intermediate status gate, or queue is
needed. An issue is **Designed** only after its plan has passed review and the fixer has
recorded its approval; waiting for the lock is a note on that entry. The mapping from evidence
to status is defined in
[saivage-todo-protocol](https://github.com/salva/saivage-v3/blob/HEAD/.github/skills/saivage-todo-protocol/SKILL.md).

A completed issue moves its full entry to `done.md` only with its approved-plan record, the
manager's validation results, the commit hashes, and stable read-only reconciliation. If any
of that evidence is missing, the entry stays out of Done and the missing evidence is named.
An abandoned issue is kept as Analyzed, not recorded as Done. Its entry carries an explicit
terminal ABANDONED note giving the merit reason and the abandoned scope. If no implementation
occurred, the note says so. After partial delivery, the entry retains the delivered units,
validation and commit references, and it identifies the abandoned remainder, which is terminal
rather than pending work. Such an entry never claims whole-issue completion. Completion
records implementation only; aggregate workflow results are tracked separately. Session IDs remain session context and are never tracker fields.

## Final approval and freshness gate

Only after review closes and the final reassessment returns `WORTH_IMPLEMENTING` may
the issue fixer record approval in session or report state. The approval record holds the
review closure (verdict and round or review artifact), the final merit outcome
`WORTH_IMPLEMENTING`, concise evidence for the four merit conditions, and the examined `HEAD`.
Later reports refer to it when it is unchanged.

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
loses contention, the issue fixer waits and repeats freshness after its ordinary resume.

## Singular complete implementation boundary

Every approved issue fixer invokes `implementation-manager` through the exposed native
subagent tool, with agent `implementation-manager` and a prompt giving the absolute
approved-plan path, the tracker entry identifier and paths, and its approval facts. A returned
session ID does not settle that manager; its substantive report does. No primary agent or issue fixer inspects the lock and
implements around it. The file `.opencode/locks/implementation-manager-working.md` is
the only serialization boundary.

The manager must:

1. Atomically acquire the lock before reading the implementation plan or making or
   delegating any implementation mutation. On contention, it edits and delegates
   nothing and returns the existing lock description.

   A stray or unexplained lock, or any other unusual lock state, is not handled here. See
   [Unusual lock and settlement states](#unusual-lock-and-settlement-states).

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
     for prompt linkage and composition review. The final review after the last relevant
      edit, including any inline integration, must identify both final activities on the
      actual final composition: the whole-composition review and the separately identified
      unconditional clean-room assessment. One such invocation may perform both when its
      review identifies each; no second invocation is added for that reason alone.
     Ordinary documentation changes go to `doc-reviewer`.
     No review is added to unchanged text or to an asset outside the assignment.
   - Findings return to the matching author, `doc-developer` or `prompt-developer`, for
     wording, or to `code-developer` for logic in source or configuration. Each return is
     followed by affected validation and fresh review of the actual final input. For a
      prompt asset, that review is the final activities above, including the clean-room
      assessment, and the same applies after any later relevant shared or governing
      instruction, host, or configuration change. For ordinary documentation, the fresh
      review is by `doc-reviewer`; no prompt clean-room assessment is added.
   - A finding that requires a changed design is not implemented by any worker. The
     manager returns it to the original issue fixer for the full redesign loop.
   - Include planned discriminator, producer, consumer, fixture, and reference
     synchronization in this reconciliation and in the completion report, without
     adding another gate or coordination mechanism.
5. Run all validation required by the plan, including focused and broad checks. Handle
   generated artifacts. Selectively stage only intended paths. Commit coherent stable
   units under AGENTS. Developer checks inform progress. The manager owns integrated assurance:
   it may reuse a successful developer check whose relevant inputs are unchanged in the final
   result, and it reruns or adds checks as [economical selection and reuse](../validation.md#economical-selection-and-reuse)
   directs.
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

### Unusual lock and settlement states

A stray or unexplained lock, a retained lock whose holder cannot be accounted for, an unsettled
prior call, or an unsafe worktree is not an ordinary state. No role classifies it, removes or
modifies the lock, takes it over, repairs the worktree, continues an interrupted attempt, or
starts another manager around it. This includes a manager that could not stabilize and kept the
lock. Stop, report the facts as they are known, and ask the owner or operator. Do not poll or
retry.

No procedure in this protocol authorizes exceptional lock handling. A later exceptional operation
needs a separately scoped owner decision, and it is a different subject from this protocol's
normal acquisition, waiting, and release.

## Lock contention and event-driven resume

A contender that returns without editing or delegating maps exactly to
`WAITING_FOR_IMPLEMENTATION_LOCK`. This is not a failure, not partial implementation,
not divergence, and not evidence that requires redesign. The issue fixer keeps issue
ownership. It must not poll, sleep, retry in the same turn, inspect, remove, or
classify the lock as stale, or launch another manager.

Coordinator sequencing prevents most contention, but unexpected contention can still occur,
for example from a run outside the coordinator's sequence. The lock therefore remains the
only safety boundary, and every contender follows this section.

The coordinator selects a waiting fixer, or a cancelled waiter whose owner has directed its
continuation, only at an eligible boundary: the known holder has returned, released its lock, and
reported a stable committed state, and no other run is selected. It selects one waiter. Waiters
are not resumed optimistically as a group, because the losers would only wait again. Selection
creates no queue, scheduler, fairness promise, timer, watcher, or additional lock. A resumed
fixer that loses contention again returns another waiting disposition, and the coordinator
selects again only at a later eligible boundary.

### Ordinary resume

The coordinator resumes the selected fixer with one ordinary continuation call through the exposed
native subagent tool. It names the identity recorded at launch as the agent and passes the exact
recorded session ID as `sessionID`. These are illustrative arguments, not a callable namespace:

```text
agent: "<the identity recorded at launch>"
description: "<continuation label>"
prompt: "<continuation prompt>"
sessionID: "<exact recorded session ID>"
```

The prompt asks the fixer to continue the named issue from its plan at the recorded absolute
path, and gives the tracker entry identifier and paths. For a cancelled waiter, it also states
that the earlier waiting episode was cancelled and forwards the owner's continuation instruction
verbatim. It supplies no freshness conclusion and no approval.

The resume is not a challenge, an identity proof, or an entry call. The coordinator does not
compare the returned session ID or any value with a record, and it does not verify that the reply is
the original fixer's own report. The recorded session ID is ordinary tool routing, and this protocol
claims no wrong-session containment from it. The continuation's substantive report, not its session
ID, is its result. A tool or host failure, or an unusable session ID, is an ordinary blocker: report
it, guess no IDs, and launch no replacement fixer.

A retained session whose stored procedure still carries a superseded mechanism (the continuity
nonce, its challenge and authorization, cancelled-wait re-entry, or an exceptional lock recipe)
also needs the owner's superseding direction in the same resume message. The coordinator quotes
that direction verbatim from its session context. This delivers existing owner authority; it is
not a new proof, and the session's stored body is not changed. If the owner's direction is not
in session context verbatim, the coordinator does not resume that session and asks the owner.

The fixer runs its own freshness gate before any manager attempt, under
[Final approval and freshness gate](#final-approval-and-freshness-gate). A resume approves nothing
and turns no old evidence into current evidence.

### Owner-directed continuation of a cancelled waiter

Cancellation is effective at once. A cancelled waiter makes no manager call, stops launches and
resumes, and does not touch the lock. It keeps its exact session ID, issue identity, plan path, and
last known facts, including the approval facts and the cumulative prior manager effects. Cancellation
alone never resumes the issue.

Continuation requires an explicit project-owner instruction to continue this cancelled issue. An
earlier implementation authorization does not satisfy it. The selected run needs the same evidence
as any waiter: every earlier call has settled, the shared worktree is safe and stable, the manager
lock is released, and the known lock holder has returned and reported a stable committed state. A
holder settlement that occurred during the cancellation satisfies this, so no new contention or
holder event is needed. The owner instruction bypasses none of these conditions. If any condition is
unknown, the entry is blocked. Do not poll, probe, or send a speculative manager call to establish
it. At the selection boundary, apply any still-pending cancellation note first, under
[Tracker lifecycle ownership](#tracker-lifecycle-ownership).

The selected cancelled waiter then receives the [ordinary resume](#ordinary-resume), with the
owner's instruction forwarded verbatim and the cancelled episode stated. It is not a separate entry
call, a preparatory call, or a waiting report. Its freshness gate runs before any manager attempt. The
earlier approval is historical: a plan revised after approval, or one sent back to design, needs a
new approval under the complete loop. Prior manager effects remain in the fixer's reports, and the
resumed run's reports add to them.

## Handling manager returns

### Contention-only return

Map a manager return that acquired no lock, edited nothing, and delegated nothing to
`WAITING_FOR_IMPLEMENTATION_LOCK`. Do not revise or re-review solely because of
contention. Return a waiting disposition. The coordinator resumes the fixer with an ordinary call
at a later eligible boundary.

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
  implementation resumes until explicit owner or operator verification and repair. No waiting
  resume, new manager attempt, or interrupted-holder continuation proceeds around that lock. Stop
  and ask, under [Unusual lock and settlement states](#unusual-lock-and-settlement-states).

## Structured fixer dispositions

Every issue fixer return to a coordinator starts with exactly one of these dispositions:

- `COMPLETED`
- `ABANDONED`
- `WAITING_FOR_IMPLEMENTATION_LOCK`
- `BLOCKED`
- `FAILED`
- `CANCELLED`

A waiting return reports, once and without a fixed template:

- the issue identifier and summary, and the plan path;
- the approval facts (in full, or by reference to the earlier report of this run when unchanged),
  and the implementation attempt number;
- the lock holder as the manager described it, verbatim or faithfully concise;
- `Work performed in this attempt: none`;
- the cumulative prior manager effects, with their delivered units, commit hashes, validation
  results with failures and limits, and remaining scope, or `none`;
- the tracker evidence: the entry identifier or `unavailable`, with the lifecycle `Designed` for the
  approved plan. Waiting is a note on that entry, not a separate status;
- the resume condition: the known lock holder has returned, released its lock, and reported stable
  committed state, after which the coordinator may select this fixer for an ordinary resume.

The return carries no challenge result, nonce, or other continuity value. The coordinator keeps the
fixer's session ID in its session context as routing state.

Before any manager delegation, record the resume check:

```text
Resume check: PLAN_STILL_VALID | PLAN_REVIEW_REQUIRED | BLOCKED
Previously examined HEAD: <commit>
Current HEAD: <commit>
Relevant intervening changes: <summary or none>
Decision and evidence: <reason>
```

A completed report includes the issue identity, the plan path, the approval facts (in full, or by
reference to the earlier report of this run when unchanged), files changed, manager-supplied
validation results, commit hashes, remaining work or divergence, and repository stability.

An `ABANDONED` report instead includes the issue identity and plan path, the review outcome,
the merit evidence, the failed conditions, why redesign cannot make the remaining scope
worthwhile, and any separate follow-up. It states whether the decision abandons the whole
proposed fix before implementation or only the identified remainder after stabilized partial
delivery. Delivered and abandoned scope are reported separately; partial delivery never means
the issue or the original plan was completed. The report gives the actual effects of every
attempt, taken from the manager's final reports and the fixer's read-only reconciliation rather
than only the final round or attempt: changed files, completed units, commit hashes,
manager-supplied validation results with their failures and limits, remaining scope, repository
stability, and lock release status. It states that there were no implementation changes,
validation, or commits only when that is true of the whole implementation history. Design review
and planning activity are not implementation validation. Its `Tracker evidence` line supports
Analyzed with a terminal ABANDONED note, never Done. Abandonment authorizes no cleanup, no
reverting of coherent delivered units, no additional validation by the fixer, and no lock release.

The issue fixer generates no new implementation evidence after the manager returns. It never
writes `todo.md` or `done.md`, before or after the return. Every disposition report carries a
`Tracker evidence` line naming the entry identifier, the lifecycle state the evidence supports,
the manager's applied or pending tracker status when a manager ran, and any pending correction.
The coordinator uses that line at its next safe boundary.

## Cancellation and error handling

- **Waiting fixer cancelled:** mark `CANCELLED` and do not touch the lock. Retain the issue
  identity, plan path, and last known facts, including cumulative prior manager effects, so that
  an owner-directed ordinary resume has them. Cancellation alone never resumes the issue. Other
  issues continue unless directed otherwise.
- **Resume without usable context or task:** mark `BLOCKED`. Name the missing fact, guess no IDs,
  adopt no other session's output, and launch no replacement fixer.
- **Design, review, or delegation problem before implementation:** use `BLOCKED` for unavailable
  required tooling and `FAILED` for an actual issue-local failure. Other fixers may
  continue if the shared worktree is safe.
- **Design abandoned on merit:** return `ABANDONED` as an intentional terminal decision not to
  implement further scope, before implementation or for an identified remainder after
  stabilized partial delivery, not `FAILED` or `CANCELLED`. It reaches the fixer's
  disposition only through the complete designer and reviewer loop. Abandonment does not
  waive a blocker: an unsafe worktree, an unsettled manager, or an outcome-unknown Saivage
  publication remains `BLOCKED` and is never concealed. The coordinator does not resume or
  replace it.
- **Acquired-lock error, partial result, or divergence:** the manager stabilizes coherent
  work before normal release, unless the [uncertain publication boundary](#uncertain-publication-boundary)
  applies. The issue fixer reconciles read-only, then either returns to design and review
  or reports failure. Other issues resume only when the report, the lock, and the
  repository state are all safe.
- **Manager cannot stabilize or terminates abnormally:** leave the lock in place. No
  contender removes or takes it over. Report a batch-level blocker that requires
  explicit owner or operator action. Stop and ask under
  [Unusual lock and settlement states](#unusual-lock-and-settlement-states); no role continues
  the interrupted attempt.
- **Coordinator cancellation:** stop launches and resumes. Cancel children only when
  explicitly requested and supported. Report all last dispositions and any active
  holder. Never remove another session's lock.
- **Unusable session ID:** a delegation error or failed ordinary resume is `BLOCKED`. Do not
  automatically launch a replacement fixer.
- **Missing or ID-only result:** a launched or continued fixer, designer, reviewer, or manager that
  returns no substantive report, or only its session ID, is unsettled. It makes no further launch or
  resume eligible. Report it as `BLOCKED` with its recorded session ID, and do not replace it.

## Post-batch aggregate validation

Only when every issue disposition is exactly `COMPLETED` or `ABANDONED`, no issue fixer has
pending implementation work, and the implementation lock is absent may the coordinator
run one final read-only or harmless aggregate validation to test batch coordination.
Any issue in `WAITING_FOR_IMPLEMENTATION_LOCK`, `BLOCKED`, `FAILED`, or `CANCELLED`
prevents it.

Aggregate validation never stages or commits. Any unexpected tracked or generated diff
fails the aggregate check and is reported. It is never repaired outside the manager
boundary.

Scenario evidence is reported separately from implementation completion. The plan's offline
waiting, resume, cancellation, and freshness scenarios, and the source validation, are reported as
what they are. Static scenario evidence does not establish live delegation behavior, host adoption, or
lock contention, and unavailable live evidence is reported as unavailable, never certified by
silence. No delegation smoke, real cancellation, lock contention, or manager call is run merely to test
the wording.

## Prohibited mechanisms

Do not introduce any of the following:

- parallel issue-level implementation;
- concurrent initial launch or optimistic resume of several issue fixers, or resumption of a
  waiting fixer while the selected run can still launch a manager;
- multiple lock-holding managers;
- implementation by a primary agent within a full issue run. A clearly trivial direct fix outside
  the protocol is the separate route under [Direct trivial fixes](#direct-trivial-fixes);
- implementation by an issue fixer, in any circumstance;
- extra locks, lock takeover, or stale-lock classification;
- lock-bypass, sole-writer, or presence-recheck recipes for a stray lock or an interrupted holder;
- a nonce, challenge, or returned-ID comparison gate on resuming a fixer;
- polling, sleeps, retry timers, watchers, queues, or schedulers;
- registries, replacement fixers, aliases, dispatch fallbacks, loaders, or branches,
  worktrees, clones, or merge orchestration.

Permitted concurrency is narrow: a manager's positively nonconflicting source-only
`code-developer` group. It is not live issue fanout. Do not run documentation or prompt authoring
concurrently with any other worker. Do not run concurrent developer assignments that overlap in
files, contracts, outputs, validation side effects, or ordering. Do not invoke `code-developer`,
`doc-developer`, `prompt-developer`, `doc-reviewer`, `prompt-reviewer`, or a retained developer or
documenter profile from an issue fixer or designer. Within an issue run only the implementation
manager invokes them. The acting `build` or `plan` primary may invoke only the four wording roles,
and only for a clearly trivial direct wording fix.

## Final reporting

Reporting has two registers, matched to the recipient.

**Internal evidence handoffs** (worker to manager, manager to fixer, fixer to coordinator, and the
coordinator's own record) carry what the next role needs to review, apply, validate, or decide: the
issue and plan paths, the tracker entry identifier with the status applied or pending, the review and
final merit outcomes, material findings, files changed and commit references, manager-assured
validation commands with results and input scope (and whether each was reused or newly run), prompt-review
evidence where model-facing assets changed, retained-profile identities where a session used one,
repository stability, delegation receipts, and cumulative delivery with its failures, limits, and
remaining or abandoned scope. Give each fact once at its owning handoff. Refer to the accessible
artifact or report afterwards, and repeat a fact only when it changed or the recipient lacks it. A
reference never hides adverse evidence: a later report that points back to an earlier one still states
any failure, limit, or abandonment the reader needs to decide, and it never implies whole-issue
completion.

**The user reply** states the outcome, and any action, decision, or blocker the user needs. It lists
paths or file lists only when the user needs them for that decision or action. For an abandoned or
partly delivered issue, it reports the delivered scope and the abandoned remainder separately, and it
never omits partial delivery that the reports show. The coordinator also reports each selected run in
order, the boundary evidence used before each launch or resume, and each dormant waiter by identifier
only. For each owner-directed continuation of a cancelled waiter, it reports the owner instruction
received, the cancellation evidence, and the resume result. Facts that the resumed run carries from
earlier reports are reported as historical, never as new lock contention or fresh freshness evidence.
Session IDs remain session context and are not written to tracker or repository files.

Do not commit `docs/working/` artifacts. A change to agent bodies in source describes
fresh-session behavior. Ordinary, authorized fresh development sessions use the new profiles
without a separate adoption approval. A running session keeps the stored agent body it already
has, and a changed agent file is not a replacement for that body. Shared instructions reach a
running session by their own routes, as the
[OpenCode instructions documentation](https://opencode.ai/docs/instructions) describes. Global
and upward `AGENTS.md` files and existing local configured instruction files are updated before the session's
next model request, so such a change can apply while the stored body stays old. A nested
`AGENTS.md` already discovered is not refreshed automatically. If compaction or a revert removes
that entry from history, a later read can load it again. An already-loaded skill keeps its
earlier text; a session whose role permits it may later load the changed skill and consume the
updated text. None of these routes replaces the stored body or expands a narrower effective
permission. Effective authority is the stored body together with the shared instructions that
currently take effect, under their priority. A missing allowance for a tracker action is reported
as pending or blocked, never handed to another session. Consumption and adoption are separate
facts, and a file edit alone proves neither; a read grants no authority the reader's effective
instructions lack. Claim receipt or consumption only with evidence that supports that specific
claim, and do not claim adoption unless consumption or a replaced body was observed. Source
completion does not require delivery evidence from a running session. Do not restart OpenCode,
switch running sessions, or replace stored instructions to force adoption. An effective instruction
conflict is reported as a blocker; it is not repaired by restarting or altering a session. Actual
deployment, service operations, and other separately controlled live actions keep their own
distinct approval.
The current stored implementation manager does not launch the canonical leaves merely to
manufacture execution evidence, so their live invocation remains untested and must be
disclosed as such.
