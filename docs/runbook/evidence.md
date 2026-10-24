# Find evidence and interpret its limits

Start with the selected card and question, not a search for a universal audit.
Saivage retains particular observations and accepted artifacts; it does not promise
every command, file change, delivery or decision is recorded. Interruption can lose
evidence. Historical facts, current observations, prepared instructions and external
effects are different authorities.

## Choose the evidence surface

| Question | Surface and limit |
|---|---|
| What work was requested/accepted? | Records & History; distinguish baseline, draft, acceptance and author |
| What did an agent prepare/say/call? | Exact-session Conversations and activation entry; not proof of perception |
| What did a non-LLM action/hook retain? | Executions; not an invented agent conversation or current liveness |
| Is a process alive/contained; where is output? | Processes and returned stream URLs; missing output is not completion |
| Which pixels were selected? | Inspect image on the exact recorded occurrence; current Files is separate |
| Which request/control observations exist? | Technical details, System Events/Actions, external receipts; none is complete audit |

Current card selection freshness uses exact `head_id` **and** mutation revision.
Historical ordinary artifact version/UUID is immutable provenance, not today's
head. Queue-only changes can alter revision without a new ordinary version;
history/diffs are queue-free. Re-read through supported surfaces before acting;
an old screenshot, tool observation or reviewer verdict is not current authority.

## Baseline0, drafts and accepted documents

In Records/Overview inspect the label, document number, author and immutable source:

* **Baseline v0 — not authored or accepted** is automatic create-if-absent template
  data. It is not an agent verdict, accepted document or historical seed.
* Opening baseline0 yields draft0/target1. A changed substantive edit authors draft1,
  eligible for accepted1. An untemplated first draft starts at1; later acceptance
  is n+1, independent of mutable head revision. Accepted backing cannot satisfy
  draft0/empty draft; opening alone cannot satisfy an updated gate.
* Current draft URLs are reusable current selections, never immutable draft locators.
  Versionless latest-effective reads can return newer content or an open draft.
* Accepted provenance retains source document version/entry/time, author, observed
  card mutation revision and ordinary historical card reference as distinct facts.
  History/diff validates each reached predecessor; current reads do not certify all
  unconsumed history.

An initializer renders only with exact head absence. Any present baseline/draft/
accepted/empty-after-discard head suppresses it, including after restart/template
changes. Clean discards the draft and opens existing baseline0 or empty while keeping
accepted backing, without rerendering; Continue preserves work. Startup/reads/free
writes/creation do not backfill templates. Existing-config init does not install
new declarations/guidance. [Configuration](../guides/configuration.md) owns templates,
macros, write permissions and node-entry selection.

::: v-pre

For example, this is a **declaration/node excerpt**, not complete YAML or a field
overlay; place it in the complete owning card type:

```yaml
records:
  status.md:
    format: markdown
    schema: status-summary.v1
    bootstrap: false
    initialization:
      format_version: 1
      template: |
        # Current assessment

        {{cardTitle}} — not yet assessed at {{nodeId}}.
workflow:
  nodes:
    plan:
      # Other required node fields omitted.
      initialize_records: [status.md]
```

Only `{{cardType}}`, `{{cardId}}`, `{{cardTitle}}`, `{{nodeId}}`,
`{{recordName}}` and direct `{{> fragment-id}}` includes are supported here.
Nested includes, arbitrary paths, unknown/malformed macros fail; inserted bytes
are opaque, not reparsed. `${NAME}` is literal in initializer/selected fragment
text, unlike ordinary config interpolation. Each selection requires declared
nonbootstrap initializer, matching record_writes and direct write (edit is not
enough); duplicate/unknown selections, extra keys, old content/at and empty
templates fail. Omission/null disables future initialization, not retained text.
Shipped profiles use brief-relative status starters and neutral review starters,
including both typed architecture reviews. First review entry is unassessed, not
a verdict; later clean entries preserve accepted evidence without regenerating it.
Creation-time initialization is deferred (GitHub issue4), not implemented by this
example. Normal Analyst acceptance suppresses future initialization; it does not
take over an open workflow draft.

:::

### Authorship is not a verdict

| Author | What it establishes |
|---|---|
| `agent` | The configured named agent authored the acceptance; no independent correctness guarantee |
| `external-agent` | The configured external credential-holder principal, not verified person/model identity |
| `runtime:bootstrap` / `runtime:repair` | Procedure-owned structural bootstrap or visibly synthetic repair, not old work/approval |
| `action-output` | Exact operation/contract/provider, activation/invocation/node/ordinal, actual nullable process/leader facts, outcome and body-bound source/byte-size/SHA256; returned-text is not native stdout |

Child creation and root bootstrap have their actual owner attribution; do not
relabel every initial document as runtime work. External attribution lives in
`src/schemas/operation-author.ts`, `record-author.ts` and immutable accepted-record
provenance. Receipts deliberately contain no record body. A synthetic repaired
FAILED card has placeholder requirements, not recovered acceptance; see
[card loss](./state-adoption.md#separately-confirmed-card-loss).

## Exact activation and instruction evidence

Open a card participant in Conversations or configured global participant in
System. **Activation entries · N** lists retained markers in the selected accepted
segment. Card Evidence's segment catalog selects the exact numeric segment.
**Open entry** focuses its actual marker, including marker-only rounds. Share the
router-built `/agents/:id?segment=N&entry=ID` link; reload/Back retain exact selection.

`segment` is a single decimal positive safe integer. Omission means current.
Entry IDs are opaque nonempty scalar strings, including composite IDs: preserve
and router-encode exactly, never extract UUID/trim/double-decode. Empty/nonscalar
entry gives no target. Invalid segment, unavailable segment, read failure and
missing entry within accepted segment are distinct; none searches other segments
or substitutes current. Arrivals do not displace historical selection. The special
identity-resolved Analyst inspector does not promise the ordinary activation index.

**Activation entry recorded** proves publication, not current execution, invocation,
duration, completion or old node position. Coverage is one retained segment, not
every activation. No markers is not “never activated.” Inherited open-round genesis
is continuation context, not another activation/time/location.

### Prepared, current and historical instructions

At an activation entry, **Prepared instructions** retains rendered historical role
and full node text once, with agent/node/time. Expand Role instructions / Node
instructions and copy complete privacy-filtered public text. Retained configured
workflow rows are **Recorded workflow instruction** at original/repair positions;
protected details keep provenance/source, not original adjacency. Unmarked adjacent
text is not retrospectively reclassified.

**Historical instructions unavailable — not recorded** means missing evidence;
never substitute today's template, private diagnostics, a hash or similar text.
**No model invocation for this ingress** identifies confirmation-only ingress.
An entry outside the tail is different: **Inspect source segment N** opens its
known source, then choose successive sources explicitly if needed. No chain crawl.

**Currently configured instructions** lazily renders composed static instructions
from **server-loaded configuration**, covering each matching current node binding
or global participant. Refresh explicitly while open; close discards observation,
reopen reads anew. Edited files not loaded by a new server are not that config.
It remains labeled current while viewing history, and failure stays local to the
disclosure. It is neither historical request reconstruction nor the actual in-flight
provider request. **Technical details** separately reads latest session-scoped primary
exchange metadata, not the selected historical segment's request.

Preparation, admission, turn-start, cancellation and exchange outcome do not prove
provider receipt, attention, interpretation or obedience. Static role/node/tools
and same-read current-record snapshots contribute to request preparation; source
rows are not a complete wire request. Each new logical operation can select changed
records; retries/maintenance preserve that operation's frozen selection.

### Record observations and compacted context

Expand **Recorded record observations** for actual recorded current/historical
selection and metadata/slice/full/reference/excerpt exposure. An excerpt is neither
a contiguous source slice nor full body. Oversized notices disclose encoded/redacted
display and omitted display bytes, plus a versionless latest-effective pointer
that may now return newer content/draft. Safe JSON-string quoting is retained;
public text/metadata are independently filtered, never decoded into a raw secret body.

Prepared-bootstrap descriptors do not retain historical full-body text. The accepted
bootstrap supplied to the model stays complete and can dominate capacity. Compacted
facts retain original coordinates/time, not recalled body bytes or new observations.
**Inspect immutable record evidence** opens the selected accepted artifact, not a
reconstructed request. Template changes/restart do not re-fire unchanged conditional
selections; indispensable procedure belongs in its prepared node host.

For a compacted segment, open independent closed **Accumulated summary**, **Retained
instructions**, **Required model facts**, **Source and continuation** sections.
They are derived retained context, not fresh events or actual request. Segment
history is separate, not stitched. Null ordinary context has no invented genesis.
Declared local omission can lose days of decisions/detail while keeping protected
instructions/newest facts/continuation; indexed history is available only through
explicit authorized reads, not automatic recall. See [compaction diagnosis](./diagnosis.md#compaction-and-context-capacity).

## Action execution and stdout

Executions is retained **non-LLM** action/hook evidence, separate from real agent
Conversations. Entry does not prove spawn. An unmatched start means **no completion
retained; effects unknown**, not “running”; absent evidence does not mean never ran.
Captured runner stdout/stderr is distinct from declared artifact paths, which are
mutable **current workspace sources**, not historical snapshots. Missing files stay
unavailable; absent artifacts have no invented link. Bounded redacted preview/file
access keeps Files confidentiality and resolved-alias/attic refusal, never a raw-byte
bypass. Never replay invocation logs or infer a verdict from capture presence.

Required checks belong before DONE in ordinary workflow nodes. The optional single
`after_activation_commit` hook runs only for matching natural done/blocked/failed
publication, before owner release. It is advisory: report failure cannot undo DONE.
No hook on recovery/Stop/cancel/reopen/create/record/queue changes; no retry/background
queue/replay. Actions select no LLM prompt/session/provider and invent no conversation.

Optional stdout binding (node excerpt, not complete config):

```yaml
# Enclosing type declares nonbootstrap check-report.md:
# {format: markdown, schema: check-report.v1, bootstrap: false}
output_record: check-report.md
records:
  check-report.md: {mode: continue, gate: updated}
```

Use a full shell node with all four configured outcomes/edges; capture-only omits
output_record and uses `records: {}`. Only own declared nonbootstrap shell-node
destination qualifies, never agents/other actions/hooks. An open draft blocks launch
or later publication. Completed stdout alone must be valid substantive UTF-8 <=1MiB.
Nonregular/missing/unreadable/invalid/NUL/empty/whitespace/oversize output fails without
truncation, stderr fallback or placeholder. BOM/CRLF/Unicode/trailing newline survive.
Failed/signalled/timed_out captures retain factual disposition, not success.
Cancellation before publication writes no report; later gate failure may leave a
report without node acceptance. Equal text from a new shell invocation can become a
new accepted version with different provenance/empty diff. Accepted text no longer
depends on capture availability; that is not capture deletion permission.

Shell.run uses literal Bash and separate args (quote `"$@"`), project-relative cwd,
explicit nonsecret env and <=16 exact artifact paths/no globs. It runs
`bash --noprofile --norc -o pipefail`, no implicit set-e. Timeout default120000ms,
max600000; TERM grace default2000/max10000; captured settlement post-group deadline5000.
Root variables cannot be overridden; `${NAME}` in action text is literal. Config,
argv/env/artifacts are not secret-delivery channels. Full authoring belongs in
[configuration](../guides/configuration.md).

## Process state and missing output

[Explicit work GC](./work-gc.md) protects selected captures and work references in
baseline0, current drafts, accepted predecessor history and all indexed original
and compacted conversation segments—not merely the displayed context or inline
output. Execution start/finish selections remain protections even without a finish.
Directory and exact alias references can protect whole subtrees. Missing-file/404
presentation is not permission to delete selected evidence. Unreferenced eligible
stash/scratch may be collected; no source availability or lossless retention promise
is added by GC, and canonical history/images are outside its deletion scope.

Inspect actual process status/evidence, leader exit/error, stream open/EOF/closed,
capture errors and returned canonical stdout/stderr URLs independently. Running
or partial output calls for the returned links; done+complete inline heads can be
used directly. Never synthesize an omitted URL or infer completion from missing
output. Retained webfetch stash text is disposable, not guaranteed permanent work.

EPERM group probes or failed signal dispatch permanently revoke that launch's
numeric-PGID authority. **Evidence unavailable** exposes the first safe diagnostic;
EOF may coexist with capture failure and leader success/closed pipes do not prove
group absence. Waits fail promptly even with inherited FDs. Failed scope/entry is
retained; repeated cleanup cannot probe/signal/forget/transfer it to a later activation.
List success is observation, not containment. Never kill a stale numeric PGID or
erase a lock to clear the display.

Failed containment is not successful project Stop and may block Run/MCP replacement.
Intentional stop/EOF can instead show Process containment failed; neither permits
replacement. Separately authorized deployment intervention must stop/prevent restarts
and positively verify actual server/descendant absence before authorized start.
Restart does not itself certify privileged descendant containment. Current absence
cannot reconstruct old exits/output/effects. Do not delete canonical history to hide
an unavailable process.

## Current file versus recorded image

Ordinary text `read` is not image inspection. `view_image` and successful native MCP
images normalize static PNG/JPEG/WebP, orientation/size/sRGB and select ordered PNG
occurrences only at the real LLM settlement boundary. Snapshot descriptors carry
UUID/dimensions/length/hash under the source conversation; missing/corrupt bytes
fail selected reads, never fall back to the original. Metadata/startup does not
decode an image inventory. No snapshot scan/GC/dedup/selective cleanup exists;
unselected bytes remain ignored. Full backups include selected snapshots; reset
removes their roots; eligible card discard moves conversations wholesale.

In current or historical Conversations, **Inspect image** resolves exact session,
segment UUID/version, result row, content index and image UUID. Use Fit or1:1;
Previous/Next stays within that result, Escape returns to reading position. Ordinary
Files eligible PNG/JPEG/WebP uses the viewer labeled **Current source**, freshly
decoded dimensions; it can differ from the recorded model-input pixels. Image row
metadata is not inspected pixels. The viewer is neither provider delivery receipt
nor model perception. Compaction summary is lossy prose, not permanent visual recall.
External callers receive call-local bytes, not fabricated internal snapshots.
Never use credentials/config/authenticated operator pages as screenshot subjects;
pixels cannot be regex-certified secret-free. [MCP limits](./mcp.md#native-results-and-image-limits)
and [native dependencies](./deployment.md#native-image-dependencies) apply.

## Filesystem reads and tool observations

Native absolute `read({path:'/work/sibling/docs/notes.md'})`,
`glob({directory:'/work/sibling',pattern:'**/*.md'})`,
`grep({path:'/work/sibling',pattern:'TODO'})` need no registration. Relative paths
default to target; external discovery returns reusable absolute paths. Explicit
ordinary symlinks resolve, recursive discovery does not follow encountered directory
symlinks and omits fixed build/dependency/cache/.git directories. Direct ordinary
build/dependency files remain readable. [Project discovery exclusions](./deployment.md#project-discovery-and-exclusions)
can narrow recursive scope without changing direct access.

Credential paths/generic `.saivage` namespaces fail before access, including aliases
and system resources. Use intended `record:///`, read-only `work:///`, admitted
`tmp:///`; `project:///` stays contained. Native text access does not widen write/
edit/patch/Webfetch-save, view_image or operator Files authority. No copying workaround.
Current glob/grep envelopes are512..32768 requested bytes with stateless
`matches.next`; historical opaque results are not rewritten/retroactively bounded.

## Control events, notifications and external receipts

System Events / `/api/events` can show bounded `operator_runtime_control.result`
for direct Pause/Resume/Stop/Restart (including delegated CLI reaching handlers).
They describe returned status/contained or restart scheduling/fixed handler denial,
not complete halt/delivery/replacement. They are global, absent from card-filtered
Events and not Actions/Errors. Status reads, prehandler auth/routing/schema denial,
thrown failures and transport loss have no promised row. Event append can fail after
effect; no undo/retry. Restart append precedes finish-ack installation. Missing row
or HTTP failure never establishes no effect or permission to repeat.

Analyst controls/confirmation keep their own conversation/tool evidence without
duplicate direct-control events. Actions / `/api/control-actions` is bounded audited
Analyst mutation settlement plus valid retained historical Planner rows, not every
filesystem effect. Current Planner reopen/reorder uses tool results, no action row.
Use authenticated `/api/events` or `read_runtime_events` for explicit event queries;
Debug has no Timeline, and the current-state Dashboard is not a command, activation,
actionable-error or recovery ledger. There is no content-supervision endpoint.
Notification success is enqueue, not delivery; even interrupted does not promise
model action. Queue bodies/counts/membership/history are not ordinary query resources.
Generic revision/time/diff hints are not a supported queue API. On a failed enqueue
request use existing call/result/audit/runtime evidence, never blind resend.

External settled receipts contain invocation ID, configured principal/project digest,
selected tool (unsupported fixed marker), timestamp, execution class and outcome.
No args/results/start row/client identity/body, no completeness or exactly-once
guarantee. Native response, receipt and acceptance attribution are distinct evidence.
Publication uncertainty is fatal before receipt/logging/cleanup.

Provider exchange usage is provider-reported: omitted input/output/cached/reasoning/
total counts are **unknown**, not zero or locally backfilled estimates. Reported
usage is not billing. Latest primary evidence is source-session-owned; internal
summary evidence is separate and not the latest-primary inspector. See
[diagnosis](./diagnosis.md#network-exchange-observations) for transport phases and
private capture limits.
