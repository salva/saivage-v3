# newloop: intent-to-delivery quality on typed workflows

`newloop` is an optional profile for useful, well-structured, evidenced code **or
other assets**. It foregrounds critical interpretation, appropriate design,
progressive planning, actual delivery and independent assessment where warranted.
These are responsibilities within existing nodes, not five mandatory stages.
Clear small work can remain concise and finish without ceremonial documents or
reviews; complex work must not use direct completion to evade necessary scrutiny.

For a config-absent target, select `saivage init --profile newloop`. The default
remains `classic`; existing `classic-typed` and `paad-typed` profiles are unchanged.
See [fresh selection](../../../../docs/guides/configuration.md#choose-a-fresh-profile)
and [prompt handling](../../../../docs/architecture/prompts.md).

## Method and ownership

- Planner examines the accepted assignment against relevant current facts and
  documentation, tests assumptions and the fit of the requested solution, then
  closes ordinary choices autonomously into useful work. Necessary decisions
  outside its authority return through existing BLOCKED outcomes with evidence,
  impact and options. Parent direction cannot amend a child's accepted brief;
  requirement changes must reach the actual requirement owner. With bundled grants,
  the parent can accept a proposal by writing the same inactive child's brief;
  it cannot weaken its own upstream obligations. Root decisions reach Analyst/operator.
- Planner connects the full outcome to a workable approach and a detailed next
  slice, leaving later slices coarse when appropriate. It executes that plan
  through direct children, not implementation edits/builds/tests. An architecture
  or research child may precede implementation for substantive value; its DONE
  does not complete the parent. Current `status.md` and necessary work products
  retain decisions, evidence and the full remainder, without a new record family.
- Meaningful returns distinguish execution mistakes, plan gaps, design faults
  and requirement decisions. Correction changes the failing premise at its owner,
  preserving useful work and evidence; a failed tactic is not automatic objective
  failure. Real unavailable authority/input and conclusive failure remain honest
  terminal boundaries. Uncertain effects and provider refusals never justify
  replay or circumvention.
- Planner, Executor and Reviewer relate intent to analysis/design, intent/design
  to planned work, design/plan to actual output, and useful delivery back to the
  authorized need. Consistent artifacts may share a wrong premise. Source-grounded
  review verifies and deduplicates findings, separates flaws from proposed
  remedies, recognizes sound choices and preserves all actual acceptance criteria.
- Evidence follows the asset: behavior and integration for code; credible sources,
  method and limits for research; factual consistency and audience/task usability
  for documentation; meaning/provenance and required validation for data;
  system fit and feasibility for designs; authorized observed effects for
  operations. These examples impose no universal code commit or test framework.
  Relevant structural debt may need in-scope correction, including non-code
  restructuring; adequate structure merits no change and unrelated cleanup is
  not a new completion gate.

## Exact source differences

All five registered profiles now share the singular capabilities1 grammar:
Planner self/status and children/brief, Reviewer self/review\*, Executor self/status,
global Analyst all/brief, broad explicit reads. Custom scopes may grant self
bootstrap drafts. Workflow6/accepted-record6/conversation13 require separately
authorized input/prompt and retained-state adoption; record-head3 stays unchanged.
This cutover does not redesign the profile's graph or prove installed compatibility.

The [template](./template.ts) selects its own complete standalone physical prompt
tree and directly reuses `CLASSIC_TYPED_TEMPLATE.config`, the same deeply frozen
object. Graphs, tools and ordering, agents, routes, child permissions, record
initialization/feeding and generated result contracts are identical. Native Git
remains OFF; no provisioning or optional quality tools are enabled.

Only these eight paths under `prompts/` differ from classic-typed:

| Host                                     | Responsibility                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `agents/_shared/planner.md`              | Consolidated interpretation, design/planning, delegation, revision and completion method.                              |
| `agents/_shared/executor.md`             | Task interpretation, actual output alignment and asset-appropriate production/validation within the current leaf node. |
| `agents/_shared/reviewer.md`             | Independent alignment, verified findings and proportionate quality/debt assessment.                                    |
| `process/_shared/specialized-plan.md`    | Goal's current analysis, next slice, delegation and full remainder.                                                    |
| `process/project/specialized-plan.md`    | Root objective and existing assessment handoff, not direct DONE.                                                       |
| `process/_shared/specialized-recover.md` | Recover relevant reasoning and plan from evidence; retain sound work.                                                  |
| `process/project/specialized-recover.md` | Root recovery with complete objective and historical-review limits.                                                    |
| `process/_shared/specialized-review.md`  | Current integrated goal/project assessment and supported verdict.                                                      |

Every other prompt is byte-identical, including Analyst/Oversight, architecture
nodes, project assessment, notification handling, correction/transition hosts and
all seven shared fragments. Direct includes and one generated contract token per
workflow role remain unchanged. Reusable method belongs to prepared roles, current
tasks to node text—not replaceable project-guidance hooks. The role method remains
in primary invocation instructions through continuation/reentry and after
compaction. Summary requests instead use summary-specific instructions, with
prepared card/current-node/bootstrap context and activation-local parent direction
where applicable as read-only orientation—not the role method as summarizer
instructions or proof of historical facts. Conditional record prompts do not
guarantee repeated bodies, so read current details when needed.

## PAAD input and deliberate adaptation

Conceptual source: Curtis "Ovid" Poe's **PAAD — Pushback, Alignment, Architecture,
Discipline**, especially the [course](https://curtispoe.org/paad/) (displayed
v1.24.1 when consulted), modules 2–4 and 6–9. Its concerns about weak input,
missing context, intent/action drift, structural debt and verified review inform
this profile. Wording here and in the eight hosts is original local expression,
not copied upstream skill/course text or paad-typed's licensed adaptations. No
upstream endorsement or change to Saivage's license is implied.

Newloop adapts a human-decision-oriented method to existing autonomous ownership:
ordinary decisions stay local; consequential missing context or requirement
authority is escalated honestly. Cohesive slices preserve the complete owner need,
not a size quota. Review uses relevant quality lenses, not mandatory specialist
fan-out, a report for every dimension, fixed history scans, branch rituals,
periodic audits or human approval after every finding. The typed code workflow
stays because it is the selected base, not a rule for every kind of asset. PAAD
examples do not import new recovery guarantees, threat models or accessibility
standards into target requirements.

## Evidence and adoption limits

Offline compiler renders, contract/closure checks and scripted legal paths can
qualify the source configuration and instructions. They prove neither provider
delivery/model compliance nor measured improvements in useful output. A later
behavioral evaluation requires separate authorization; more activity or fewer
BLOCKED results alone would not establish quality.

No retained-state contract or discriminator changes solely for this profile.
That is not whole-release compatibility certification. Existing-config init
preserves YAML, prompts and marker and is **not** a profile switch. Follow
[loaded instruction adoption](../../../../docs/architecture/prompts.md#loaded-configuration-and-installed-adoption)
and [state adoption](../../../../docs/runbook/state-adoption.md#selected-configuration-and-prompts)
for separately authorized stopped reconciliation and a fresh process, preserving
custom guidance and resolving actual identity/format compatibility. Matching
classic-typed identities/contracts need no migration solely for prose changes;
arbitrary installations still require their own assessment. Source selection
authorizes no deployment, service action, Run, reset or external migration.
