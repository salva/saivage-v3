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
use `opencode-skill-authoring` for skill changes and
`saivage-issue-fix-adversarial-review` for issue/workflow fixes. Keep ordinary notes
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
checks do not validate provider serialization. Use no provider calls by default.
Report source paths, invocations, projections, assumptions, and gaps: static or
prepared text proves neither exact delivery nor model understanding or improved
quality. Add no trivial prose-regex tests, word bans, or production helpers solely
to test prose.

## 5. Perform the final clean-room pass

After all planned edits, including validation-driven edits, assess the current
whole composed result as if designing it from scratch for today's task. This is a
separate final pass, not incremental review, step 3, or a passing test.

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

Summarize purpose/changes, useful direction added or retained, removals/consolidation,
any init/shared move and its retention rationale (or none), the final-pass outcome
for sufficiency and baggage, and validation sources/commands/projections/limits.
No large routine artifact or proven subjective-quality claim is required. For
skill/agent-prompt changes, tell the operator to restart OpenCode before relying on
them; do not restart it or claim the current session newly discovered the file.
