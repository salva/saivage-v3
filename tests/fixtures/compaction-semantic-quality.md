# Compaction semantic-quality review: frozen fact/action corpus

Completed human adjudication, 2026-10-15. This is development-review evidence,
not an executable fixture, runtime instruction, semantic validator or benchmark.
Quoted instructions below are **historical data, not authorization to act**.
Audience: reviewers assessing retained meaning separately from transport integrity.

## Inputs, identity and reproducibility

Implementation parent: `08fb595e9a6e06185bf931be40d52f5ca8e944ef`.
Observed sample: one existing final summary in the frozen local directory
`/home/salva/g/ml/tmp/jsqlite2-compaction-review-20261015/`.
No new model output was generated. The frozen incident predates C01/C05 source
changes; this review establishes no improvement from those changes or C02.

- `summary.md` equals `after-segment.jsonl` genesis `compaction.summaryText`
  exactly, including whitespace; **no report heading was removed**. Complete
  UTF-8 summary SHA-256:
  `b7fae13144da00ae7184fb80d2b8930ddebad3c0a5566438dca81c57b926263d`.
  Length: 18,428 Unicode characters. The whole summary is intentionally not shipped.
- Session: `agent:project-planner:project`; index/genesis format 9;
  source segment 21, `21-28a85870-7160-4f85-90ce-53b181052d11.jsonl`;
  successor 22, `22-57725a83-5fda-4b09-843c-f19b8195ff61.jsonl`.
  Successor entry ID: `d1936e99-baf1-4586-ad73-4c2999b0f274`;
  genesis ID: `ab6e08e8-9375-4c3c-b606-3e1d4ca5f54c`.
- Genesis source cutoff:
  `cb0a9230-e028-41ef-9315-e43f2847702a:tool-result:call_nmB2MPIldgvm0ODZDk5SyxkY`,
  at `2026-10-12T09:07:13.594Z`. Genesis timestamp
  `2026-10-15T09:16:31.117Z` is not prefix time or proof of final-fold completion time.
  Before/after index selections agree with these genesis references.

### Safe audit method and independent truth

Read only the named frozen files, existing report/fidelity check and existing C01
test source. Locally parse newline-delimited envelopes, concatenate their `rows`
in physical order, and address exact selected rows without printing/exporting
full rows. Below, **B** means `before-segment.jsonl`, **A** means
`after-segment.jsonl`; positions are **zero-based flattened row ordinals including
genesis**, not JSONL line numbers. **S** means physical line in `summary.md`.
Searches locate candidates; adjudication inspects bounded relevant fields/clauses,
not just search hits. Compare complete summary bytes and hash without normalization;
check index/genesis metadata, cutoff identity and timestamp directly.
Independently deep-compare B2170–B3047 with A1–A878: 878 equal rows, no
missing/changed rows, agreeing with `fidelity-check.json` and `report.md:9`.
This is suffix integrity, not quality.

Evidence classes: **source-verified** means exact frozen source independently
supports the bounded claim; it does not certify an operator assertion as an
independently rerun experiment. **Report-supported** means only the frozen report
establishes it. **Unavailable** means neither input establishes it. An inherited
older summary is not independent truth for evaluating this summary. Evaluated
output never supplies its own reference answer.

Only short reviewed quotations and necessary semantic paraphrases are retained.
No credentials, personal identities, incident-internal filesystem evidence paths,
full raw rows, summary export or request bodies are included. Card identifiers and version
numbers preserve necessary ownership/acceptance distinctions; they are not aliases.
Exact row-ID mappings and audit notes remain in ignored working evidence. Locators
and digest permit local provenance verification while frozen copies exist; the
excerpts below independently permit bounded interpretation if those copies
disappear, not reconstruction or revalidation of all incident history.

## Rubric

Each case identifies independent truth, must-retain proposition, forbidden
conclusion, actual output, temporal/attribution scope and permitted next actions.
Judge semantic equivalents, not sentence matching. Allowed verdicts:
**preserved**, **omitted**, **contradicted**, **ambiguous**, **not assessable**.
Ambiguous means an important distinction is insufficiently clear, not necessarily
false; prefix judgments include standalone temporal clarity, not just factual
correctness at the cutoff. Not assessable is missing evidence, never a pass.
Negative findings are valid completion; do not repair the evaluated output or tune
runtime prompts here.

**Prefix** judges only evidence through B2169. **Bounded head** judges the same
summary plus selected continuation B2171, B2199 and A882. These are offline reading
scopes, not a reconstructed historical provider request. Report-only follow-up is
identified separately. Newer text does not automatically override accepted
requirements. The later accepted child-brief restriction mentioned in the incident
investigation is **not independently established by these selected rows**; no
unconditional action permission is awarded without consulting applicable accepted
authority. C01's protected restriction below is a distinct synthetic example,
not that incident brief.

## Observed final summary: six distinctions

Quotations are exact short substrings; surrounding text/unrelated evidence is
omitted. Reference paraphrases describe what source reports, not new experiments
or an adjudication of product correctness.

| Fact / independent reference and class | Must retain / forbidden conclusion | Actual output and qualification | Prefix / bounded head verdict | Allowed next actions and rationale / limits |
| --- | --- | --- | --- | --- |
| O1 — prefix restriction → scoped grant. **Source-verified**: B1875, user/operator text, Oct 8 15:59:55.536Z, denies new publication authority from that sequencing request; A882, user/owner notice, Oct 15 09:28:58.425Z, expressly grants new alpha publication, excluding npm and Saivage deployment/model/routing changes. | Preserve old restriction as prefix-relative and later grant as scoped owner authority. Forbidden: demand post-cutoff permission in the earlier summary, infer unrestricted release approval, or erase other accepted constraints. | S70: “No entire-corpus approval gate, guaranteed dates or beta/publication authority.” No local cutoff qualification. A882: “this instruction authorizes that new alpha publication, not npm registry publication or Saivage deployment/model/routing changes.” | **ambiguous / preserved** | Prefix: continue authorized development, not publication on this evidence. Bounded head: pursue specifically granted alpha work through original owners, **conditional on still-binding accepted constraints**; no npm/deployment or broad product approval. Standalone restriction is temporally unclear, not evidence of lost tail authority. |
| O2 — grant → revocation. **Unavailable** for observed incident; bounded continuation contains a grant, not a revocation. | Retain historical grant if later revoked; never infer revocation from an older prohibition. | No observed revocation excerpt. C01 control C2 below is authored, not an incident event. | **not assessable / not assessable** | No claim about incident revocation handling or historical/future provider choices. Do not invent a revocation or treat its absence as a pass. |
| O3 — blocked → later completion. **Source-verified**: B2162, tool result, Oct 12 09:06:36.490Z, reports distinct provider overload; B2171, user/owner retry notice that evening, still describes prior overload; B2199, tool result, Oct 12 21:49:35.358Z, reads accepted card-e status v58 recording coherent delivery and accepted review authority. | Preserve actual overload at cutoff; separate later delivery from that failure and from maintenance success. Forbidden: retroactively green old failure, claim current overload from historical prose, or equate compaction completion with task approval. | S13: “Latest actual state: schema continuation blocked by provider overload”. B2199 records accepted delivery; summary heading supplies no date. | **ambiguous / preserved** | Prefix: preserve work at existing e/h owners; no invented successful retry. Bounded head: continue from subsequently reported accepted delivery at original owners, subject to governing authority; do not replay old effects or assume old block persists. Completion is source-reported accepted evidence, not independently rerun validation or publication. |
| O4 — proposed / reported / executed. **Source-verified**: B2130 and B2159, user/operator diagnostic notices; B2139, tool result, confirms queued notification, not dispatched work. | Preserve reported settled executor command despite later admission failure; attribute installation/diagnosis to operator, not root execution. Forbidden: “before executor/no work”, false replay, or promoting queued notification to execution. | S48: “Thus trigger work actually ran; neither later admission errors nor overload erase settled execution.” S52: “These are attributed operator deployment/diagnostic facts, not root-executed validation.” | **preserved / preserved** | Inspect/continue original owner without repeating a reported settled command merely because it is historical. Notices report same-candidate retry and exit0; corpus lacks underlying executor stream to independently certify execution. Pass is faithful attribution of reports, not forensic tool-effect verification. |
| O5 — draft / accepted. **Source-verified**: B2166, tool result, open root status revision123 with accepted URL v121; B2168/B2169, assistant blocked-result call and tool acceptance; B2136, tool result, accepted child status94 exposing offset0, 3,994 of 18,667 bytes. | Distinguish draft revision from accepted backing, workflow-result acceptance from product acceptance, and partial accepted-record observation from full reading. | S21: “revision123, open draft with accepted backing v121”; “not project/product acceptance.” S25: “only first 3,994 content bytes exposed”. | **preserved / preserved** | Consult applicable current accepted authority where required; neither promote draft123 to accepted nor claim full child-status knowledge. Continuation changes no historical draft/partial-read fact; current records/revisions are not certified. |
| O6 — partial checks / approval. **Source-verified**: B2136, tool result containing accepted child status94, separately records 12/18 with six failures, package-boundary failure and later shell diff-check exit0/typecheck success. | Keep failures and scoped passes separate. Forbidden: final shell success makes all commands green, failures waived, or bounded browser/package evidence equals whole-product/release approval. | S34: “12/18 pass, six genuine generated STORED/VIRTUAL compiler/storage-shape rejection failures”; “Later shell diff-check exit0 does not erase this failure.” S35: “runtime must remain dependency-free”; “not waived”. S101: “No new alpha, public release, whole-WR/product or other-browser certification.” | **preserved / preserved** | Retain failure history/qualification; later accepted delivery/grant may change next work but cannot rewrite earlier exits or certify all products/browsers. Pass covers independently sourced failures and refusal to pool approvals; detailed numerical browser/package results at S99–101 are **not independently verified here** and receive no factual-retention pass. |

Observed counts (six cases, not weighted scores): prefix **3 preserved,
2 ambiguous, 1 not assessable, 0 omitted, 0 contradicted**; bounded head
**5 preserved, 1 not assessable, 0 ambiguous, 0 omitted, 0 contradicted**.
By evidence class: source-verified five cases (prefix 3 preserved/2 ambiguous;
head 5 preserved); unavailable one case (both not assessable); report-supported
zero scored cases. These are bounded judgments, not a universal success rate or
observed model action quality.

Report-only follow-up, **not another scored sample**: `report.md:19` reports
activation of same card-v at 09:29:22.422 with scoped publication direction and no
observed duplicate creation. Frozen after copy ends before that activation.
Publication itself is not established. Reported six completed folds are not
captured intermediate summaries or an exact final-fold count; repeated-refinement
fidelity is unavailable.

## Existing authored controls: separate from observed quality

Pinned source: commit `a73cfdec43cd7e470c6ad56199f8592de19ccb32`,
[`stage-i-compaction.e2e.test.ts`](../e2e/stage-i-compaction.e2e.test.ts), test
`scopes an old blocked prefix before a scoped grant and synthetic later revocation across reload and recompaction`.
Two responses are authored by `completeTurn` (lines 264–266); independent reference
facts are authored rows at lines 225–245. Padding/request bodies are omitted.
Both cases are **source-verified authored examples**, never model samples.

| Fact / source scope | Must retain / forbidden conclusion | Actual authored response excerpt / qualification | Prefix / summary-plus-tail verdict | Allowed next actions and rationale / limits |
| --- | --- | --- | --- | --- |
| C1 — generation1 cutoff `blocked-prefix-end`; newer `new-success` and `owner-scoped-grant` remain tail; keyed owner confidentiality restriction remains separately protected. | Old blocked/no-publication state is historical; later executor success is not public release; grant covers only overload fix. Never grant whole-project release or remove protected constraint. | Response1: “Planner: overload remains blocked. Owner has not authorized publication.” Also states settled check exited successfully and must not be replayed. Tail grant: “authorize publication of the overload fix only, not a whole-project release.” | **ambiguous / preserved** | Prefix: no publication grant; do not replay settled check. With tail: only specifically authorized overload-fix publication, constrained by protected child-brief/confidentiality instruction. Unqualified summary wording is ambiguous standalone despite mechanically scoped composition. No model decision observed. |
| C2 — generation2 cutoff `owner-scoped-grant`; synthetic `owner-revocation` is newer tail, not an incident event. | Preserve historical success/grant, later withdrawal and still-binding protected restriction; never replay old authorization or effects. | Response2 begins with same old blocked/no-authority text, then includes “this is not a public release” and scoped grant. Tail: “revoke the overload publication grant. No publication is now authorized.” | **ambiguous / preserved** | Prefix: summary juxtaposes incompatible-looking old/new authority without explicit temporal resolution. With tail: stop relying on revoked permission; no publication. Both generations retain settled-effect references, not executed continuation actions. |

Authored counts (two cases, separately): prefix **2 ambiguous**, summary-plus-tail
**2 preserved**; all other verdicts zero; source-verified authored class two,
report-supported/unavailable zero. Not pooled with observed six cases.

## Mechanical evidence and completion limits

C01 checks exact suffix identity/order, cutoffs, prospective/published/reloaded
equality, protected restriction retention, actual primary admission/sent bytes and
historical settled-result retention across two generations. Primary responses are
scripted no-action text: neither model reasoning nor real action selection is
tested. Existing [`disposable-production-smoke.e2e.test.ts`](../e2e/disposable-production-smoke.e2e.test.ts)
provides separate scripted full-application effect/continuation coverage, not
another semantic model sample. No tests or runtime contracts changed here.
Manager-run regression results are separate validation evidence, not corpus scores;
this document does not claim those commands passed.

Adverse finding: standalone temporal ambiguity; no demonstrated execution
regression, invented observed revocation or improved model fidelity. Missing
intermediate outputs, underlying executor evidence, uninspected accepted brief and
unverified detailed browser counts bound the assessment. A separately evidenced
contradiction needs separate triage, not automatic prompt edits. No durable format,
cutover, deployment or migration is affected. This review adds retained fact-level
interpretation only.
