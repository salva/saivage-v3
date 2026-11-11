# Explicit work garbage collection

Use this optional operation to reclaim eligible ordinary scratch, captures and
webfetch stashes under `.saivage/work/`. It is not startup cleanup, canonical-state
repair, reset or migration. It never removes directories, publication temporaries,
attic, backups or canonical history. Deletion is irreversible and not transactional;
code rollback cannot recover files. Consider a separately prepared preserved backup
before destructive use. Preview requires no backup. This operation does not
replace the stopped/excluded/complete-backup gates for
[offline operations](./state-adoption.md).

Task-justified external command directories are outside `gc-work` coverage. Their
task owner handles owned cleanup and keeps needed evidence and its location clear
before disposal; this operation neither inventories nor collects those directories.

Retention follows current semantic use, not the union of historical references.
After separately authorized deletion, historical-only attachments/captures may be
irretrievably unavailable even though canonical card, record, conversation and
execution histories remain unchanged. Current concrete references still protect
equally old files or directory subtrees. Content mentions of administrative roots
do not: the work root and its ancestors, work `cards`, valid card roots and their
reserved `tmp`/`processes` roots, and global work `processes`, `tmp` and `tmp/stash`.
For example, `.saivage/work/cards/card-n/tmp/` does not preserve its contents,
but `.saivage/work/cards/card-n/tmp/foo` and `.saivage/work/cards/card-n/foo`
protect that file or directory subtree. Stash artifacts and process-specific capture
directories are also concrete. Known resolved aliases follow their target's rule.
This applies to structured paths/URIs as well as prose: a root in a `path` or `cwd`
field is not a concrete artifact. Previously blanket-protected old files can become
eligible despite a human's intended blanket retention. Operational/unfinished-owner
protections still cover their selected scopes, including roots; unknown recognized
aliases can still retain all work. No reclamation or historical availability is promised.

## Preview first, delete separately

Card `run_command` lazily supplies `.saivage/work/cards/<card-id>/shell` as
`SAIVAGE_CARD_SHELL_ROOT`. This remains an ordinary concrete child, not a reserved
root or retention exemption. Neither directory creation, the variable nor card
existence protects its files. For example, a current
`work:///cards/card-n/shell/install-check` reference protects only that subtree;
`work:///cards/card-n/shell` protects all shell work but not sibling scratch or
captures, while `work:///cards/card-n` alone protects neither. Prefer needed
purpose-child/artifact references over the whole shell subtree. Old unreferenced
shell files are eligible just like ordinary sibling work; those siblings remain
valid without relocation. Existing process-owner, unfinished-execution and capture
protections still apply. GC keeps directories, and command/card completion, re-entry
and startup perform no automatic cleanup. Task-owned explicit cleanup remains
permitted; separately consented generated-state reset includes the whole work root.

From the identified project root, using the matching release:

```bash
saivage gc-work --dry-run --before 2026-10-01T00:00:00Z --target-bytes 1073741824
# After reviewing the result, explicitly request a NEW selection:
saivage gc-work --delete --before 2026-10-01T00:00:00Z --target-bytes 1073741824
```

These are examples, not recommended universal retention thresholds. Omit `--before`
for no age restriction; otherwise it must be RFC3339 with an explicit zone and
regular-file **mtime must be strictly earlier**. Equality/newer files remain.
`--target-bytes` is an optional nonnegative safe integer: a best-effort remaining
**accounted logical-byte** target, not desired bytes freed. Omit it to select all
eligible files. Oldest mtime comes first, with relative-path tie-break.

Omitting both effect flags is exactly `--dry-run`. Combining `--dry-run` and
`--delete` fails before a runtime request. Unknown options/invalid values fail;
there is no saved selection, preview replay or confirmation token. The later delete
always recomputes inventory, fresh references and final identity checks. A reference
added since preview can protect a formerly eligible file.

Preview first, but neither preview nor an age cutoff proves that selected work is
unneeded. Concrete explicit/structured paths are protected exactly; filename inference from
ambiguous free text is heuristic and can miss genuine references. For example, a
space-containing native path mentioned only as `open(r'data/with space.txt'r'')`
may be missed and become eligible when old enough. So can a filename containing
line breaks mentioned only in free text: decoded CR/LF quotations are inspected
for nested concrete references rather than
treated as one filename/path. Exact explicit/structured references are unchanged.
Later explicit delete can irreversibly remove old still-needed work. No error
probability is estimated.
Use unambiguous structured path fields or explicit work URIs identifying concrete
files/subtrees when recording new references, rather than administrative roots or
programming-language quote syntax in prose.
This advice authorizes neither rewriting retained history nor a migration; adopting
this isolated fix requires no conversion/reset on matching contracts. Source
completion does not authorize any live operation.

The CLI delegates only through the verified live lifecycle lock's published
endpoint/auth mode. Dead/malformed/indeterminate ownership or an unavailable
control endpoint refuses. Only a missing lock selects the offline procedure below;
there is no fallback after delegation failure, endpoint rediscovery, lock
takeover, automatic start or Run. Bearer mode uses the existing private
`SAIVAGE_API_TOKEN` contract, never a URL token. See
[ownership outcomes](./runtime-control.md#five-ownership-outcomes).
Online collection requires an actually paused frontier or genuinely stopped project.
A running entry first requests pause; starting, closing, already-pausing or unresolved
ownership transitions refuse. Stopped entry creates no gate waiter, activation or Run.
Online shell background invocation is sufficient if desired; redirect output outside
work. There is no job
API, agent tool or UI button, and a second concurrent GC receives busy rejection.

## Without a server owner

Stop the exact service, exclude automatic restarts and establish that no managed or
unrelated writer can affect this project throughout the command. Unknown writer
state must refuse. Both preview and delete require a terminal and the exact phrase
`GC OFFLINE QUIESCENT <canonical-project-root>` displayed by the CLI. Mistaken
exclusion can destroy needed data. There is no unattended confirmation flag.

After confirmation, the CLI exclusively acquires the existing **bound** lifecycle
lock with null endpoint; identity must already exist. It loads current configuration,
workflows and prompt closure and uses the same collector, without server/provider/MCP,
Git commissioning, init or recovery. Valid running cards, current unmatched calls
and unfinished native attempts stay unchanged and protect current selections. A missing
lock is not proof of process containment; safety depends on maintained operator
quiescence. Competing acquisition refuses, never reroutes. Preview also publishes
and releases this lock, but performs no collector file effects. Results print only
after successful release. Command death may leave an abandoned lock requiring the
separate manual procedure; never remove it automatically. Successful GC does not
certify whole-project startup compatibility or authorize start/Run.

## What happens during either mode

1. Inventory yields between synchronous ordinary-work reads; online execution may
   continue during inventory. Candidate contents are not read; inventory is not deletion authority.
   Unknown categories, symlinks and ambiguous filesystem boundaries remain opaque.
2. Online, one private Supervisor hold rejects new Analyst submissions, independent
   mutations/MCP lifecycle calls and **all** Start/Resume sources. Accepted Analyst
   and external work finishes naturally; GC does not cancel their provider/tool
   work. Actual project parking (or genuinely stopped execution), complete owner settlement and the cancelled
   Oversight check precede marking. Already active independent HTTP MCP lifecycle
   calls/reconciliation refuse this attempt before pause, rather than being joined
   or automatically retried. Read-only views and project Stop remain available.
3. Fresh strict canonical reads validate linked card/accepted history, every indexed
   conversation segment and complete action/native evidence. Marking instead uses
   current card content and pending message bodies; selected record baseline, open
   draft and latest accepted content; current conversation effective summary,
   retained protected instruction contents and semantic source-row payloads; and
   unfinished execution artifact/capture/private-index selections. Existing retained
   process captures and operational dependencies also protect their existing scopes.
   Content file/directory and known alias references follow the concrete-artifact
   rule above; ignored administrative mentions never skip strict reads.
   Historical content, internal observations and producer provenance
   alone do not. The free-text limitation above does not relax strict validation.
   Unresolved native source continuations refuse; GC performs no Git inspection,
   checkpoint or return to force settlement. Corrupt/missing required evidence or torn tails refuse without repair.
   Unknown surviving process/service write footprints retain all potentially
   affected work or refuse collection; Pause is not an OS filesystem freeze.
   Unrelated human/program writers must be quiescent in the affected domain.
4. The same selection algorithm rechecks each exact candidate's identity, size,
   mtime/ctime, protections and cancellation immediately before its effect. Changed,
   replaced, disappeared or newly created files are not substituted or recrawled.
   Preview records hypothetical removals only; delete unlinks eligible regular
   files and accounts only known successes. Reserved `.saivage-tmp` entries are
   skipped before inspection/accounting, never collected.

GC itself writes no canonical rows, notices, manifests or durable reports, and
preview performs no collector file effects. Accepted operations can still finish
during settling and ordinary execution can resume afterward: preview does not make
the entire live application read-only. Offline collection instead uses the bound
lock and operator exclusion above. There is no GC elapsed maintenance/header/body/
total-request deadline or duration setting; connection establishment remains finite.
Nested extraction and candidate loops yield cooperatively, but individual synchronous
reads, JSON parsing and regex operations are indivisible. No cancellation latency
or throughput is promised. Conservative ambiguous single-line prose (including
backtick/double-quoted text with path syntax) can protect all candidates: a completed
preview may reclaim zero bytes. An unresolved recognized reference, including a path-length filesystem
error during exact alias metadata resolution, also retains all; this never bypasses
strict required history/native validation. Conversely, missed prose filenames can
leave needed work eligible: useful reclamation is not proof of safe inference.
The decoded-multiline correction removes one false global-retention trigger; it
neither excludes other global-protection causes nor certifies candidates unneeded.

## Results, cancellation and restoration

Progress goes to **stderr**, as concise newline-delimited text; final **stdout**
is exactly one JSON response line after successful settlement (offline: after
lock release). Offline disclosure and the exact confirmation prompt also use stderr.
For example, redirect stdout to a result file outside work while watching stderr.
Observations are transient, lossy and throttled: phase changes emit immediately,
count updates at most once per second in existing work loops. There are no timers,
heartbeats, percentages, ETA or known total-work denominators. Slow/broken stderr
can drop observations without cancelling collection or suppressing final output.

The phases are `inventory`, online-only `settling`, `validation_marking`, and
`selection`. Inventory is not a settled hold; settling describes an attempt to
park/join owners, not completed exclusion. Offline initial configuration loading
still precedes inventory. Elapsed milliseconds use an operation-local monotonic
clock. Optional cumulative counts/logical bytes describe work already observed:
inventory's accounted files/opaque entries; completed card, record-history and
segment inspections; classified candidates; hypothetical preview removals or
known-success deletions. Omitted means not yet observed/applicable; zero means
observed zero. They contain no paths, identities or content, and do not change
selection or certify completion. An indivisible synchronous read can be silent;
the last phase can include later settlement/release silence.
Validated cards count reached active cards, not tombstones; records count completed
selected-history inspection, not absent lazy records; segments count strict complete
inspection. Inventory skips reserved temporary entries without counting them.

Every progress snapshot and non-null final/partial result includes
`first_global_protection`: null or exactly `{reason,source}`. The first sufficient
global protection is retained for this attempt; it is neither the sole cause nor a
ranked cause, and encounter ordering need not be stable between attempts:

* `process_owner_uncertain`: process ownership has an unresolved footprint.
* `operational_root`: an operational input selects work or an ancestor broadly.
* `reference_scope_unknown`: recognized reference scope/alias metadata cannot be
  resolved, including an unscoped wildcard.

The source family is one of `process_owner`, `process_capture`, `card_content`,
`pending_notification`, `record_content` (selected baseline/draft/latest accepted),
`conversation_content` (including configured globals), `unfinished_execution`,
`workflow_input`, or `operational_input`. These fixed labels disclose no path,
card/session/record identity, token, content, object key, config value or exception.
CLI stderr renders, for example,
`first_global_protection=reason:reference_scope_unknown,source:conversation_content`;
final JSON uses `"first_global_protection":{"reason":"reference_scope_unknown","source":"conversation_content"}`.
Null is `first_global_protection=null` on stderr and JSON null in the response.
In progress it means no global mark observed yet; only a completed result's null
means none was established in the collection. Individual protections can still
cover every candidate with null. A non-null mark does not prove each file is
individually needed or exclude additional causes. Progress can be throttled/dropped;
a partial result is not completion, and `result:null` refusals do not fabricate a
mark even if earlier progress observed one. Attribution changes no retention,
validation, cancellation or fatal-publication boundary.

HTTP 200 is one `application/x-ndjson` stream with `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`: zero or more
`{type:'progress', progress: ...}` frames, exactly one last
`{type:'result', response: ...}` frame, newline terminated, then EOF. Each encoded
frame is bounded to 16 KiB including newline. Clients require strict schemas,
ordering, MIME and complete terminal-plus-EOF; no JSON-200 fallback exists.
Authentication/input/busy errors before stream admission remain JSON 401/400/409;
ordinary pre-stream internal failure is safe JSON 500. A post-header failure can
leave an incomplete stream instead. Ship matching server and clients together.
Slow clients drop optional progress; terminal drainage happens only after GC and
its hold release, never holding maintenance open for delivery.

The terminal response carries `mode`, `disposition` (`completed`,
`interrupted`, `refused`), `reason`, `restoration`, nullable `failure` and nullable `result`.
`completed` does not mean every file was eligible or the target was reached.

`failure` is null for completion and cancellation. Other ordinary failures expose
only `{code, syscall}`: code is one of `EACCES`, `EPERM`, `ENOENT`, `ENOTDIR`,
`EISDIR`, `ENAMETOOLONG`, `ELOOP`, `EMFILE`, `ENFILE`, `ENOSPC`, `EROFS`, `EIO`,
or `unknown`; syscall is one of `scandir`, `readdir`, `lstat`, `stat`, `realpath`,
`open`, `read`, `close`, or null. These are independently allowlisted original
metadata, never inferred from error text. No message, stack, path, identity or
nested cause is returned. `reason` gives the coarse stage; `unknown`/null means
safe metadata was unavailable, not that the failure is harmless. Semantic validation
errors can remain `unknown`.

For separately scoped diagnosis, permission codes (`EACCES`/`EPERM`) point toward
access checks; `ENOENT`/`ENOTDIR`/`EISDIR` toward missing or wrong-type required
data; `ENAMETOOLONG`/`ELOOP` toward path length or resolution loops;
`EMFILE`/`ENFILE` toward descriptor limits; and `ENOSPC`/`EROFS`/`EIO` toward
storage capacity, read-only storage or I/O. These labels do not identify the failed
file or prove a root cause. Do not automatically retry deletion, change permissions,
bypass protections, modify history or launch another live sweep to obtain details.

* `observed_count` / `observed_logical_bytes` describe the phase-1 accounted
  regular files, not a coherent current snapshot. `opaque_entries` does not count
  descendants or measure excluded bytes; `whole_work_size_known` is always false.
* `retained` counts accounted candidates by `protected`, `recent`, `stale`,
  `opaque` or `target` (eligible but not needed). Protections beat age/size.
* Preview reports `would_delete_count` / `would_delete_logical_bytes`, with actual
  deleted fields zero. Delete reports `deleted_count` / `deleted_logical_bytes`,
  with hypothetical fields zero. A known partial result is not a rollback; failure
  attribution does not reconstruct or enlarge those known effect counts.
* `expected_accounted_logical_bytes_remaining` subtracts hypothetical or known
  removals from observed bytes. `accounted_target_shortfall` is null without a
  target, otherwise the remaining accounted excess. Zero shortfall does **not**
  certify whole-work size, physical blocks or free space. Opaque/new/changed files
  leave actual totals unknown; conservative protection may yield no reclamation.

On success or known failure/cancellation, only GC may restore the pause it initiated
on the same Run (`restoration: resumed`). Already-paused stays paused; stopped and
offline stay stopped (`not_resumed` after exclusion). Any ordinary
Pause withdraws auto-resume intent; Stop/server close/restart or natural Run
settlement defeats it. Public Start/Resume cannot release the hold. `not_resumed`
and `not_acquired` are not instructions to start a new Run: inspect current state.

Requester disconnect or Stop cancels online GC; CLI SIGINT/SIGTERM forwards
cancellation online and cancels cooperatively offline.
Cancellation stops waiting for accepted Analyst work, not that work itself; collection
must actually settle before release. First failure ends the attempt, without retry,
compensation or repeat unlink. Publication/deletion-durability uncertainty is fatal
**before** readback, logging/report updates, cleanup, hold/lock release or resume.
Lifecycle release uncertainty is also fatal before output or further cleanup. A lost
response, malformed stream or missing terminal/EOF is not proof that nothing was
deleted. Transport failure prints no manufactured final stdout response; never replay it as a saved request
or infer lossless recovery. Follow [uncertainty handling](./state-adoption.md#stop-on-uncertainty).

The [operator API reference](../architecture/system-architecture.md#operator-routes)
and [configuration reference](../reference/configuration.md#explicit-work-gc-inputs)
describe the singular request contract. Enabling this optional command changes no
durable format and authorizes no automatic collection or live deployment.
