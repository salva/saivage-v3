---
name: saivage-prompt-authoring
description: 'Mandatory workflow for any agent authoring, editing, or reviewing prompts, templates, composed fragments, or agent instructions: src/config/system-templates/**/prompts/**, .github/agents/**, .github/prompts/**, .github/skills/**/SKILL.md, AGENTS.md, and authorized project prompt overrides. Use to clarify task direction, consolidate instructions safely, validate actual composition, and perform a final clean-room review.'
---

# Saivage Prompt Authoring

Any agent authoring, editing, or reviewing model-facing instructions must follow
this workflow. The paths in the description are examples, not an allowlist;
inline/generated prompt text and other instruction files also qualify. Project
overrides require existing authorization. Follow `AGENTS.md` and higher-priority
instructions: this skill waives no review, validation, or safety obligation. Also
use `opencode-skill-authoring` for skill changes. Issue-team agents
do not load the issue-fix coordination skill; the main batch coordinator alone uses
it, and its maintainer reference is `docs/development/issue-fix-protocol.md`. Keep ordinary notes
concise in the normal report; required issue plans remain under `docs/working/`.
This is a development workflow, not registration or automatic selection in
Saivage's runtime skill catalog.

## 1. Establish purpose and effective context

Identify today's task, desired outcome, acceptance/completion criteria, and actual
callers and audiences before changing wording. Trace selected templates,
substitutions, included fragments, composition order/instruction hierarchy, role
and current-node text, handoff/correction messages, and authoritative generated
tool/result contracts. Distinguish fixed instructions, current facts, procedures,
quoted data, and examples.

Inspect delivery frequency and lifetime: initialization/shared context versus
every turn/node, recipients, new sessions, re-entry, compaction/truncation, and
what actually survives. Follow actual consumers, not filenames or assumed memory.
For Saivage runtime prompts, consult [Prompt handling](../../../docs/architecture/prompts.md)
and its owning source; for development-agent instructions, trace the actual host's
loading/composition path without inventing wire ordering.

## 2. Draft concise, explicit task direction

Put outcomes and constraints first. Keep each part useful to the current task and
prioritize instructions rather than accumulating equally emphatic rules. Connect
the objective to allowed next actions, relevant evidence/work product, and
decision/completion conditions where needed. State what changes the decision, not
just outcome labels. Make justified no-action/no-change, stop/ask, or
evidence-qualified retry explicit when relevant; prescribe neither busywork nor
arbitrary budgets, mandatory records, or a universal four-field template.

Assign reusable method to the effective role/shared owner and the present task
delta to the node/request. Explain functional responsibility and authority: which
context is advisory, what supports consequential claims, and what authorizes action
or acceptance. Distinguish observed facts, hypotheses, proposals, drafts, and
accepted evidence. Require task-relevant evidence without weakening exhaustive
criteria or other real requirements.

Make current-node completion actionable: once its work and real gates are met,
name the supported submission/handoff rather than only describing readiness.
Separate downstream acceptance from this node's obligations. For genuine unmet
gates or refused results, direct useful corrective work from the actual diagnostic
and current contract, not speculative preflight or repeated readiness polishing.

Remove redundant persona/identity and boilerplate only where they add no functional
value. Identity/model mentions are potential redundancy, not blanket bans; retain
role identity and distinctions that orient behavior or authority. Make output and
completion criteria proportionate rather than automatically elaborate. Use
authoritative generated schemas for tool names, parameters, and result contracts;
add needed behavioral guidance without copying schema definitions. Separate future
requested behavior from retrospective history. Use few justified examples, labeled
non-exhaustive where appropriate so they do not narrow valid behavior.

Classify each asset by purpose and consumption, not topic or extension. The
invoking owner (the issue-run manager or the acting primary for a direct trivial
fix) invokes the named author and reviewer in distinct sessions.

- Ordinary documentation, including technical documentation about prompts, is `doc-developer` work reviewed by `doc-reviewer`.
- Model-facing wording is `prompt-developer` work reviewed by `prompt-reviewer`. The author checks the composition and supplies exact replacement text for any separate applicator. Selfchecks are not independent review.
- The applicator applies reviewed wording verbatim and neither authors nor rewords it: `code-developer` in an issue run, or the acting primary in a direct wording assignment when it has actual edit authority for the host.
- Mixed assets are split into exact sections run sequentially. No double review is added automatically.
- Skills carry no model frontmatter. The canonical `prompt-developer` and `prompt-reviewer` bodies carry their complete procedure, so they do not require loading this skill.

## 3. Consolidate at the correct delivery owner

Remove redundancy across the assembled result, not only within one file. Keep
repeated current-node context a concise task delta without deleting needed
direction. Make handoff/recovery/correction additive: preserve what happened and
relevant accepted evidence, put present work at its current owner, and couple
correction guidance to actual diagnostics/current contracts. Resolve overlapping
or conflicting prescriptions in composition rather than adding another exception
or assuming an old requirement expired. Existing sources are mixed-quality, not
gold standards: test borrowed patterns for focus, redundancy, delivery frequency,
init/shared retention, and historical patch baggage before adopting them.

Move stable explanations to init/shared instructions only when actual audience
and retention/re-entry/new-session contracts preserve their effectiveness
everywhere needed. Otherwise retain necessary instructions at their effective
delivery site; shared does not mean injected or retained, and file materialization
does not establish model memory. Do not change feeding, compaction, retention, or
runtime architecture as a wording optimization; that needs separate design/review.

Historical-bias cleanup removes obsolete prescriptive nudges, not factual history,
refusals, evidence, canonical requirements, or valid regression constraints.
Brevity never overrides workflow guarantees, constraints, authentication/privacy,
or unrelated capabilities. Stop and ask the owner if cleanup would weaken them.

## 4. Validate representative rendered/composed results

Inspect representative renders/compositions using existing source renderers/tests
where applicable, or an explicitly labeled synthetic offline projection when that
is the appropriate available surface. Raw templates alone are insufficient. Select
entrypoints/substitutions, repeated turns, re-entry/new sessions, and
compaction/truncation cases according to the changed instruction's risk, not a
mandatory combinatorial matrix. Check hierarchy, quoted-data boundaries,
escaping/substitution, secrecy, tool/result names, and output/completion contracts.
Check that current-node exits remain actionable through continuation and re-entry,
without turning quoted old readiness or correction prose into fresh authority.

Match validation to the owning surface and consult existing validation profiles.
Runtime prompt checks do not prove OpenCode loaded a development skill; skill
checks do not validate provider serialization. Use no provider calls for validation by default. The author's composition check and the independent review in step 5 are both required; neither substitutes for the other. Label projections and their limits: prepared text does not establish actual delivery or behavior. Add no trivial prose-regex tests, word bans, or production helpers solely to test prose.

## 5. Perform the final clean-room pass

After the last relevant edit, the invoking owner obtains both independent activities from `prompt-reviewer` on the actual final composition: linkage, positive-sufficiency and composition review, then a separate clean-room read from the recipient's perspective as if designing for today's task, not from the diff or author's rationale. One invocation may do both sequentially if its review identifies each separately. A stale or prevented pass is blocked or pending, never complete.

Findings return through the invoking owner under `AGENTS.md`. After a correction or later relevant change to shared instructions, host or configuration, repeat affected validation and both final activities on the actual final input.

Check positive sufficiency as well as clutter: can this recipient identify today's
objective and scoped next action, necessary evidence/work-product responsibility,
authoritative facts/contracts, and meaningful decision/completion or no-action
conditions? Apply only dimensions the task needs, not a universal prose schema.
Can it hand off completed current work without waiting for a downstream owner,
while still identifying useful next work for an actual unmet gate or refusal?
Restore missing useful direction; concision fails if the recipient no longer knows
what to do, verify, or decide.

Remove obsolete exceptions, nudges, repetitions, model workarounds, examples, and
local patch scars unless each has a current contract or meaningful behavior
justification. Resolve conflicting prescriptions without erasing genuine
historical requirements; preserve still-valid requirements and safeguards.
Clean-room never means discarding evidence or ignoring governing instructions.
If this pass changes anything, rerun affected validation and repeat the whole-result
pass after the last edit. Finish only after assessing the actual final result for
both missing direction and accumulated baggage.

## Report

Report the purpose and changed surfaces, sources and compositions checked, relevant retention rationale, author selfchecks, independent review status and final-pass outcome, and validation results or projection limits. Use accessible references rather than duplicating reports. Distinguish source composition from live adoption: stored bodies, loaded skills, and discovered nested AGENTS entries can keep older wording. An edit or read proves neither adoption nor new authority. Do not restart OpenCode or rewrite stored sessions to adopt wording.
