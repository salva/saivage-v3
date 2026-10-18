# `paad-typed`

Opt in on a config-absent project with `saivage init --profile paad-typed`.
`classic` remains the default. This profile reuses classic-typed's deeply frozen
configuration unchanged and owns a complete independent physical prompt tree.
It adds guidance, not deterministic gates or a model-quality guarantee.

## Deliberate PAAD adaptation

Prior art: Curtis "Ovid" Poe's **PAAD — Pushback, Alignment, Architecture,
Discipline**, pinned to
[`0d97d5f0da8b7982ecb86a3ee66f83cac2bda76b`](https://github.com/Ovid/paad/tree/0d97d5f0da8b7982ecb86a3ee66f83cac2bda76b).
Sources are its [README](https://github.com/Ovid/paad/blob/0d97d5f0da8b7982ecb86a3ee66f83cac2bda76b/README.md),
[pushback skill](https://github.com/Ovid/paad/blob/0d97d5f0da8b7982ecb86a3ee66f83cac2bda76b/plugins/paad/skills/pushback/SKILL.md),
[alignment skill](https://github.com/Ovid/paad/blob/0d97d5f0da8b7982ecb86a3ee66f83cac2bda76b/plugins/paad/skills/alignment/SKILL.md)
and [MIT license](https://github.com/Ovid/paad/blob/0d97d5f0da8b7982ecb86a3ee66f83cac2bda76b/LICENSE).
The local anti-degradation emphasis adapts Discipline; “Degradation” is not the
official expansion. No upstream endorsement is implied.

Only five prompt paths differ from classic-typed:

- `agents/_shared/planner.md`: evidence-grounded brief pushback and bidirectional
  scope alignment before delegation, within existing requirement authority.
- `agents/_shared/executor.md`: resolve task-defining uncertainty before
  implementation, return unavailable required decisions through existing node
  outcomes, and keep validation, interfaces, callers and docs coherent.
- `agents/_shared/reviewer.md`: independent source-grounded alignment findings,
  distinguished from suggestions, including supported no-finding acceptance.
- `process/architecture/architecture-component-review.md`: bounded component
  fit, contracts, complexity and maintenance lens.
- `process/architecture/architecture-system-review.md`: complementary integration,
  intent and operational/persistence lens preserving immutable component evidence.

Existing typed workflows, records, tools, outcomes, independent review and ordinary
repair remain authoritative. Analyst, Oversight and all six neutral guidance
fragments are unchanged. Upstream mandatory TDD rewriting, specialist fan-out,
human choices at every critique, reports/counters and branch procedures are not
adopted. There is no new review scheduler, validator pass or BLOCKED reason.

The **full upstream MIT copyright, permission and warranty notice** is carried in
the clearly delimited non-procedural attribution section of
[`prompts/agents/_shared/planner.md`](./prompts/agents/_shared/planner.md), so the
ordinary source/package/init prompt closure retains it. That notice covers the
upstream material; it does not relicense Saivage or replace its GPL license.

Existing-config init preserves YAML, prompt tree and marker; it never switches or
upgrades a profile. Later adoption requires separately authorized stopped
reconciliation preserving custom guidance and independently resolving retained
identity/format compatibility. This source addition authorizes no live action.
