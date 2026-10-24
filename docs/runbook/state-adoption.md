# State adoption, repair and reset

Adopting optional `agents.<name>.quality_tools` requires a matching release supporting
its initial format1 input, paired tool grant and preprovisioned pinned dependencies.
Old binaries reject this section. Source completion is not installation adoption,
migration consent, reset consent or permission to start/Run. No runtime probing,
download or fallback converts an older configuration.

Optional observed source inputs use a distinct
[native prepare/adopt procedure](./observed-collections.md). Definitions, private
deployment descriptor and fixed key are operator inputs preserved by generated-state
reset. Native storage is external derived state, not a Saivage migration/reset root.

Use this chapter when retained inputs or generated state cannot be used as-is.
For an ordinary start, use [Deployment](./deployment.md); for execution control,
use [Runtime control](./runtime-control.md). None of these procedures is authorized
merely by a source change, approved plan, successful build, backup or failed startup.
[AGENTS Storage Policy](https://github.com/salva/saivage-v3/blob/HEAD/AGENTS.md#storage-policy)
is the policy authority.

## Generalized action output

The [2026-10-24 source cutover](../architecture/durable-format-changes.md#generalized-action-output-—-2026-10-24)
changes workflow3→4, accepted-record4→5, ordinary/tombstone card4→5 and execution
envelope1→2 together. Materialized workflow inputs must select `output_record`,
not the removed shell-only spelling. Accepted output authors carry the actual
operation/provider, source and body-bound size/hash; returned-text must not be
relabeled as stdout. Nested retained action IDs use the qualified grammar.

Old or mixed state remains a stopped blocker. This is not a startup converter,
automatic reset or authorization to edit generated files. Deliberately adopt the
matching release and inputs only through the separately authorized full offline
migration or destructive reset procedure below. Do not roll back just the binary
after new-format writes. No deployment or historical fidelity is inferred from
source completion; unrelated family labels remain unchanged.

## Choose the operation

| Situation | Appropriate decision |
|---|---|
| Valid retained state matches every selected release contract | Authorized stopped deployment; retain it, without reset or migration |
| Current-format selector or selected body is damaged | Separately backed-up, consented [exact-target repair](#current-format-repair), where supported |
| Configuration or selected prompts need an identity-preserving change | [Reconcile stopped inputs](#selected-configuration-and-prompts), then authorized new server process |
| Participating identities or durable contracts are incompatible | Remain stopped; choose explicit [destructive reset](#destructive-reset) or owner-requested [external migration](#explicit-external-offline-migration) |
| Publication outcome is unknown | [Stop on uncertainty](#stop-on-uncertainty); no inspection or automatic retry |

Repair is not a format converter. Startup is not a compatibility probe. There is
no core or packaged migration, old-format reader, normalization, alias, dual path,
automatic reset or selective restoration. Binary-only downgrade is unsupported.
Rollback needs a separately authorized matching complete-state/release decision.

## Selected configuration and prompts

1. Identify the exact target, service, source and intended release, selected YAML,
   compiled workflow identities and selected prompt closure. Use the
   [configuration guide](../guides/configuration.md) and actual release contracts.
2. Stop the exact service and establish [offline exclusion](./deployment.md#offline-exclusion-and-complete-backups).
   Preserve customization, credentials, identity, operator objectives, source and docs.
3. Author one complete current configuration. `agents`, `analyst_agent` and
   `models.routes` are named catalogs, not old role-key overlays. Supply the complete
   closed `card_types` map including `project`, or omit the whole map for bundled
   classic definitions; there is no deep merge or invalid-map fallback. Each child
   type, scoped agent, route, operation, record and prompt must resolve.
4. Reconcile the actual selected role/node/edge/fragment hosts, not just bundled
   source. Preserve instance guidance. A shipped prompt update does not replace
   materialized prompts. Typed-only references in a hand-authored map need their
   selected classic-typed files in the instance prompt tree; bundled classic contains
   only its own compiler-observed closure. Follow [prompt architecture](../architecture/prompts.md).
5. Check the participating-identity predicate below and all cumulative durable
   differences before using retained state. Compile/start success alone is insufficient.
6. Start a genuinely new process only when authorized. Inspect installed Debug Graphs
   and selected configuration. Project Stop/Run, Pause/Resume, browser reload and MCP
   refresh do not recompile or reload prompts.

`reconfigure` validates and publishes selected next-start YAML and reports
`requires_restart`; it does not install a new live workflow/prompt binding.
Configuration warnings for missing interpolation variables do not probe credentials
or authorize repair. Correct variables in the actual service environment.

`init --profile classic|classic-typed|paad-typed` selects a complete template only
when YAML is absent. It materializes missing prompt files, writes provenance, then
publishes YAML last. Existing YAML preserves the entire config/prompt/marker choice;
another profile is not an upgrade command. Layout and configuration outcomes are
reported independently, only after strict admission succeeds. A partial prompt-only
materialization with no generated work can be completed by ordinary init, skipping
existing files. Existing generated work still requires compatible selected identities.
Partial generated roots cannot be combined with first publication; remain stopped
and obtain the appropriate separately authorized procedure, not `init --force`.

### Offline command inputs

Before init on retained inputs, repair inspection or reset, resolve the exact
canonical cwd `.saivage/saivage.yaml`, its **interpolation environment and selected
prompt/workflow closure** against the intended matching service inputs. These
commands do not consume Start's `--config`, `--project-root`, `SAIVAGE_CONFIG` or
`SAIVAGE_PROJECT_ROOT` selection. Control commands have a different ancestor-root
rule; see the [command matrix](../reference/configuration.md#command-specific-input-selection).

A service-only alternate YAML does not carry across to offline commands. Neither
the same filename nor byte-identical YAML proves effective equivalence. Divergence
blocks the operation pending an explicitly scoped stopped-input reconciliation
decision, after exclusion and a successful complete preserved backup. Do not copy
or merge service YAML automatically, overwrite canonical inputs, or use init/reset
as a configuration probe. Repair uses these workflows for eligibility; reset uses
them to publish the fresh root and required participants.

### Workflow3 literal protection keys

Workflow input advances **2→3**: authored durable prompt `compaction_key` values
are now literal parsed YAML strings at all admitted durable sites, including
record prompts and conditional/pending routes. Explicit workflow2 is rejected
even if it contains no substitutions. Omitted `card_types` selects the complete
current bundled map, not an old-version reader; the full selected-input and
participating-identity comparison still applies.

A version edit alone is not a universal semantic migration. For substitution-bearing
keys, establish actual source-era effective values and retained protection
relationships. Old stored `expanded-name` and new literal `${POLICY_KEY}` are
different identities even when the source environment bound that variable to
`expanded-name`. Keeping old rows unchanged can retain both protected occurrences;
a later literal occurrence supersedes only that literal key. Do not relabel old
expanded keys as authored names or promise continuity, release, supersession or
losslessness without evidence. Conversation format12 and its exact stored-key
comparison are unchanged. Bundled current templates declare no environment-generated
protection keys; that says nothing about installed customizations.

Use authorized stopped matching-release input reconciliation. Where retained-state
transformation is needed, it requires the separately owner-requested
[external migration](#explicit-external-offline-migration) gates, not core conversion.
Reset is a separately consented destructive alternative, not automatically required
for every version change. Source applicability and the historical promise/loader
mismatch are recorded in the [format reference](../architecture/durable-format-changes.md#literal-authored-protection-keys-workflow-2-to-3-2026-10-21).

### Participating identity changes

After generated work exists, including the initial root, renaming, removing,
replacing or changing scope of a participating card agent; changing selected
Analyst; rebinding a reached node to another agent; or changing existing workflow
node/state identities is incompatible adoption. This applies to reached active,
non-tombstoned cards including DONE/FAILED, not only running actors or all unused
catalog declarations. Tombstones terminate admission. Identity-retaining prompt,
route, tool, edge, outcome, unused-declaration or new-type edits do not unconditionally
require reset, but still need exact retained-contract comparison.

For example, adopting project `assess-completion` while removing reached project
`handle-notifications` is an identity change even if that old node never executed.
Historical names/results must not become fabricated executions of the new node.
Required configured session indexes are not a prior-graph detector: same-agent node
removal can pass startup. Never infer compatibility from readiness or enumerate old
session directories to manufacture an identity inventory.

Selected Oversight is lazy. Changing a never-used selection without established
history does not itself require reset; replacing known established identity is an
operator-assessed incompatible cutover. Absence of its exact index remains different
from missing referenced content. Required Analyst and reached card-agent indexes
must exist; a valid empty index is legitimate. Missing required indexes fail, never
create replacement history or grant permission for manual mkdir/publication.

### Outside-boundary inputs

Preserved inputs need deliberate current-release reconciliation under either
adoption path. This includes skill entries: exact `name`, normalized relative `file`
and duplicate-free `target_agents`, each naming a configured skill-enabled agent.
Do not remap targets from old fixed role labels; the default Planner lacks `skill`.
Absent and empty indexes need no invented entries. Reset does not parse or fix them.

Historical JSON-path, `streaming`, `card_type_set`, removed `mcp_reconcile`, old
prompt-layout and result-field transitions are recorded in the
[format reference](../architecture/durable-format-changes.md), not supported inputs.
If separately adopting an old config filename, first establish stopped exclusion
and require the old source to exist and YAML destination not to exist. A collision
blocks: never overwrite, merge or auto-select. JSON syntax itself is valid YAML;
there is no runtime rename/fallback. Current field lookup belongs to the current
schema, not a historical reset recipe.

For that explicitly chosen filename operation only, the guarded example is:

```bash
test -f .saivage/saivage.json && test ! -e .saivage/saivage.yaml && \
  mv -- .saivage/saivage.json .saivage/saivage.yaml
```

Do not execute it as a generic current-start prerequisite. If either check fails,
stop and resolve the selected input offline without disclosing credentials.

Reconcile notification recipients/urgency/conditional edges and required disabled
Oversight policy as well as enabled behavior. Prompt filenames follow references,
not agent names; shared references share content. Direct one-level includes and
host-specific placeholders are strict. Exactly one generated contract placeholder
belongs in each workflow-agent host; structural compilation cannot certify natural
language consistency. Do not translate obsolete `status` results to `outcome` or
recover parent activation direction from transcript history. Initializers are
create-if-absent data, not permission to backfill old baselines or relabel authorship.

## Current-format repair

**Trigger:** strict consumption rejects a current selector, selected document,
required index or current segment. Supported repair uses only the exact previous
slot, immediate indexed conversation predecessor, reported current torn tail or
separately eligible synthetic card discard. It launches no work, appends no semantic
closing, scans no history and never regenerates a head.

1. Stop the exact service, prevent automatic restarts and positively verify no owner
   or project process. Every pre-existing lifecycle lock blocks, even positively
   dead. Resolve only the exact abandoned lock through the separately authorized
   [lock procedure](./runtime-control.md#abandoned-locks); malformed/indeterminate
   observation is not proof of absence.
2. Successfully complete and preserve a **fresh complete stopped-project backup**.
   Keep exclusion throughout. Existence alone proves neither completion nor a small
   loss bound. The CLI does not create or inspect the archive.
3. Resolve the [offline effective inputs](#offline-command-inputs) before inspection.
   From the exact root use the positively identified matching current build, choosing
   **one** target. These are alternatives, not a batch:

   ```bash
   saivage repair --target card:card-a --backup /absolute/preserved-backup --report /absolute/fresh-report.md
   saivage repair --target record:card-a/brief.md --backup /absolute/preserved-backup --report /absolute/fresh-report.md
   saivage repair --target conversation:agent:executor:card-a --backup /absolute/preserved-backup --report /absolute/fresh-report.md
   ```

   Both paths must be absolute and outside cards, agents, logs, work, repair-attic
   and locks, lexically and through resolved aliases. Report must be fresh, absent
   and outside the declared backup. Ordinary source-side project paths are allowed;
   prevent recursive self-inclusion in a full backup. Strict identity/config/workflow
   loading and exclusive bound lifecycle ownership with null control endpoint apply
   throughout. There is no unattended/`--yes`, all-target, arbitrary-file or resume mode.
4. Type `BACKUP COMPLETE <target>` before inspection. Read the proposal and external
   provisional report, including exact moves, losses and tail effects. Type
   `REPAIR <target>` only to consent to those effects. The CLI then rechecks exact
   inspected bytes/absence; a change aborts. Refusal leaves candidate bytes untouched,
   including torn tails. Reports expose safe identities/paths/counts, not corrupt
   contents or credentials.
5. Read known completed steps and the final exact-owner validation. Another independent
   defect may still block startup. Restart is separate and only when authorized;
   repair or startup is not Run. Existing semantic owners may append their authorized
   uncertainty mates/recovery notices at restart/actual use, never replay old calls.

### What restoration can lose

| Target | Candidate and consequences |
|---|---|
| Card | Exact previous head plus selected documents. Fresh head UUID, never rename prev over current. May lose latest lifecycle, queue or membership and resurrect prior state/unlink descendants. Queue-only prev may select the same broken artifact. No older search. |
| Record | Complete previous accepted/draft selection. Latest draft/acceptance can be lost. Healthy current is no-op; genuinely absent optional record stays absent. Record damage never permits healthy-card discard. |
| Conversation index | Exact valid previous index. Fresh-publish it before any reported now-current tail truncation. No replacement empty history or genesis discovery. |
| Newest conversation body | With a strict-valid index, roll back only to its immediate **wholly valid** indexed predecessor. No first-segment rollback, corrupt predecessor salvage or historical-tail truncation to qualify. |
| Current torn suffix | Only an identifiable unterminated suffix after complete retained-prefix validation. Tail-only proposal leaves selector unchanged. Complete malformed prefix fails unchanged, even if followed by a torn suffix. |

Conversation rollback can lose potentially days of interactions since compaction.
Known coverage/time is reported, unknown loss stays unknown; external effects are
not undone. Missing/unusable previous slots and unsupported global/record damage
are blockers, not permission for discovery, normalization or synthetic history.

### Separately confirmed card loss

Only independently unusable **current AND previous card selections** qualify.
Strict ancestor membership must prove reachability; repair a broken ancestor
separately. Non-root type is explicit operational input, not recovered evidence:

```bash
saivage repair --target card:card-a --discard-card --card-type code --backup /absolute/preserved-backup --report /absolute/fresh-report.md
saivage repair --target card:project --discard-card --backup /absolute/preserved-backup --report /absolute/fresh-report.md
```

Type must be compiled and parent-permitted; depth twelve requires a leaf type.
Project type is fixed. After ordinary repair consent, separately type
`DISCARD CARD <target>` for catastrophic own-data and descendant-reachability loss.
The procedure moves only six exact own roots wholesale into a fresh attic UUID:
`card-head.json`, `card-head.prev.json`, `card-history`, `mailbox`, `records`,
`conversations`. Known absent roots are reported without inventory. Never move
`children` or the entire namespace. Parent link/siblings, child bytes, globals,
source/work, identity/configuration/credentials and logs are unchanged. Former
children stay unlinked and ignored forever, count/content unknown. **Project discard
unlinks every prior project descendant.** Other dependencies can still block start.

Replacement is visibly synthetic `runtime:repair` FAILED v1, fresh artifact/head
identities, empty membership/dependencies/pending, accepted loss status, honest
placeholders for all required bootstrap records and empty conversation indexes for
the card's configured agent sessions.
No metadata, old approval or requirements are recovered. FAILED prevents direct
activation only while FAILED: a later explicit healthy-ancestor Run may let its
Planner reopen it to CHANGED and execute placeholder requirements. Replace lost
requirements first; this is recommended, not an operator-only enforced hold.

### Repair failure and retained attic

Repair is nontransactional. Known completed steps are reported only after success;
the first known failure, including report failure, ends the attempt without retry
or compensation. Partial moves/bootstrap may require a new backup and separately
consented attempt. [Uncertainty](#stop-on-uncertainty) forbids report updates,
descriptor cleanup and lock/prompt release as well as reads/writes/logging.

Attic retains only the procedure's exact corrupt-path/eligible six-root moves.
Never inspect, restore or adopt old attic contents. Files refuses attic and resolved
aliases before listing/content/preview; there is no attic restore/browser endpoint.
Reset preserves it. Unsupported damage is not implicit discard or migration consent.

## Destructive reset

**Consequence:** loss of generated cards, authored records/drafts, conversations and
selected images, logs, captures and work beneath exactly `.saivage/cards`,
`.saivage/agents`, `.saivage/logs`, `.saivage/work`. A preserved backup does not retain
continuity in the reset installation. Reset is not target-project cleanup.

1. Identify exact project, inactive service and matching built artifact. Establish
   [offline exclusion and a successful full stopped backup](./deployment.md#offline-exclusion-and-complete-backups)
   under workspace `tmp/` **before input corrections, pruning, reset or restart**.
   Backup failure blocks. An additional opaque generated-state archive is optional
   only when separately requested; never inspect descendants to choose contents.
2. Obtain explicit concrete irreversible-loss consent for all four roots. Source,
   deployment approval, startup rejection and backup existence are not that consent.
3. Preserve and deliberately reconcile outside inputs: configuration, credentials,
   project identity, operator inputs, prompts, skills, instructions, source and
   canonical docs. Do not change objectives or use backup/generated descendants as a
   reconstruction/merge workspace. Every existing lock blocks reset; exact abandoned
   lock handling needs separate positive absence proof and authorization.
4. Resolve the [offline effective inputs](#offline-command-inputs), then from the
   exact project root invoke the positively identified matching release:

   ```bash
   node /absolute/matching-release/bin/saivage.js reset
   ```

   Reset acquires the lifecycle lock, removes the four trees wholesale and publishes
   fresh project/root-participant/selected-Analyst state under the lock. It does not
   selectively inspect, rename, restore or normalize histories. No old/global binary.
5. Verify preserved outside inputs, canonical new root, required bootstrap selections
   and released exact lock. Other roots remain absent until their owners establish
   them. Keep target outputs, `.saivage-search-ignore`, dynamic MCP definitions,
   diagnostics, repair-attic and lock siblings unchanged. Never copy old logs/history
   back or use `git clean` to make a semantic target blank slate. Target cleanup needs
   a separate source/fixture/output/backup decision under that project's rules.
6. Only if authorized, start the same build and verify artifact/configured Analyst,
   health/readiness and benign authorized fresh behavior without disclosing secrets
   or transcript content. A provider test spends and needs permission. Run/resume
   remains separate. Reset cannot establish why state was missing or prove no old effects.

## Explicit external offline migration

Only an explicit project-owner request for the identified project and matching
release authorizes this external workflow. Deployment/update/repair/reset permission
is not migration consent; migration permission is not blanket loss consent. Choose
manual transformation or narrow task-specific scripting under `/home/salva/g/ml/tmp/`.
No shipped/tracked reusable migration utility or core compatibility path.

1. **Resolve scope:** exact project/service/container/workspace, known source release
   and contracts, pinned intended release, complete boundary and intended input,
   release and service actions. Compare actual release schemas/semantic consumers
   alongside the [format reference](../architecture/durable-format-changes.md),
   including equal-number incompatibilities/unknown applicability. Do not probe by
   starting incompatible binaries. Explicit in-scope start/deployment needs no
   ceremonial reconfirmation; Run/resume and unrelated actions need authorization.
2. **Stop and exclude:** stop the exact service, prevent automatic restart and
   positively establish no owner/process. Maintain exclusion through cutover, or
   positively reconfirm before source inspection, candidate mutation and cutover.
   Live/malformed/indeterminate/ambiguous ownership blocks. Abandoned-lock handling
   remains a separate verified/authorized exact operation, never takeover.
3. **Back up before generated inspection/transformation:** successfully finish a
   complete stopped target-project backup under workspace `tmp/`, preserve unchanged.
   Existence is insufficient. No descendant inspection to select a partial backup;
   backup is evidence, not candidate or operational authority.
4. **Build an independent complete candidate:** outside installation and backup,
   without writable aliases/hardlinks back. Copy canonical source state and transform
   that copy, including historical rows/documents, or rebuild current-format state.
   No in-place edits or selective merges into retained roots. Cover cards/agents/logs/work
   together or the explicitly selected whole workspace, preserving outside inputs
   unless an actual required change is in scope. Follow known canonical identities,
   committed references and indexed history. Missing facts/corrupt links block or
   limit fidelity; never fabricate or adopt orphans. Opaque copies grant no discovery,
   interpretation or promotion of temporary, unlinked, attic or uncertain artifacts.
   Preserve established empty directories or derive them from target bootstrap
   owners; genuinely lazy roots stay lazy. Regular files alone are insufficient.
5. **Evidence fidelity:** preserve representable identity/order/attribution/content/
   references. New selectors/IDs, renamed paths, re-encoded rows and derived
   commitments are structural transformations, not automatically historical loss,
   but cannot masquerade as observed tool effects, acceptance, producer provenance
   or old events. Report byte-identical, semantically/history-faithful, structurally
   transformed, omitted and uncertain parts with evidence/limits. Neither promise
   losslessness beforehand nor categorically deny equivalence. Disclose concrete
   unavoidable loss and obtain explicit owner confirmation before loss/cutover.
   Unresolved required provenance or representability blocks, never weaken validation.
6. **Strictly validate all canonical candidate history:** use actual pinned release
   schemas and semantic consumers, not mirrored/weakened validators. Include card/
   record relationships, lifecycle/provenance, configured card/global sessions,
   all indexed segments/context/tool results, provider/app-log evidence, exact
   referenced work, config/workflow/prompt closure and established directories.
   No orphan scans/certification. Startup/readiness is insufficient; init/startup
   is not assumed pure validation. Offline validation calls no providers/tools and
   mutates neither original nor backup. Failure blocks cutover. Correct known
   candidate-construction mistakes externally, then revalidate the complete candidate.
7. **Cut over only the authorized complete boundary to the matching pin:** exclusion,
   successful preserved backup, fidelity/loss confirmation and strict validation
   must hold. No mixed roots, binary-only downgrade, selective backup restore or
   multi-root atomicity/recovery promise. First failure stops; uncertainty permits
   no artifact inspection, retry, rollback, reconciliation or automatic continuation.
   Report known successes separately from uncertainty and seek a separately scoped
   next operation.
8. **Authorized start and report:** start only if actually authorized, only the
   matching tested release, then verify separately. Health proves neither history
   fidelity nor continuation/unchanged chain. Never automatically Run/resume. Keep
   authentication and outbound confidentiality. Preserve an external task-local
   report under workspace `tmp/`, outside backup/generated state, recording request,
   scope, releases, evidence, method, fidelity/structural provenance, omissions/loss
   consent, uncertainties, validation coverage/results and known actions. No generic
   ledger/schema or synthetic canonical migration event.

The [external-migration skill](https://github.com/salva/saivage-v3/blob/HEAD/.github/skills/saivage-format-migration/SKILL.md)
supports execution under policy; reading it grants no consent.

## Storage and interruption

Saivage promises no persistence-loss bound, including authoritative/non-reconstructible
state. Current card/record reads validate exact heads and selected documents, not
every unconsumed predecessor. Historical traversal validates each reached link;
missing referenced history fails without fallback. Startup follows current committed
linked membership, terminates at tombstones and retains required indexes/current
sessions/evidence/records/app-log admission, including stopped-card streams. It is
not all-history or future-publication-layout certification.

Growing canonical JSONL owners validate the complete retained prefix before
truncating only an identifiable unterminated final physical suffix. Parseable JSON
without LF is still torn; interrupted UTF-8 in that suffix is permissible. Complete
malformed envelopes, unsupported versions/types, invalid rows/identity/policy/pairing
and empty/no-valid-prefix damage fail without salvage. Card/record JSON gains no
truncation. The selected current conversation file retains this rule even when
requested through a history route; older indexed segments are immutable and never
truncated. Process text, config/identity/indexes, temporaries and unlinked namespaces
gain no permission. Tail truncation is not semantic settlement or recovery.

Required established empty session roots/`versions/` and initial card `mailbox/`
must survive. Missing publication parents fail at actual use; no startup sweep or
manual mkdir remedy. See [established directories](../spec/system-specification.md#established-conversation-and-card-owner-directories).

Card head/mailbox format1, ordinary/tombstone4, record head3/accepted4, shared
conversation index/genesis/envelope12, app-log/provider rows envelope2, execution1,
workflow3 and initializer1 are distinct source contracts. The
[format reference](../architecture/durable-format-changes.md) owns applicability
and historical changes, not a supported-version matrix or installation inventory.
Equal versions do not certify nested payloads, layouts, identities or provenance.
Examples include process inline heads/completeness/URLs, five-field reported usage,
per-session evidence, Responses `producer_account_id`, protected instructions and
record observations. Never invent missing usage, pixels, stream facts or producer
identity during adoption; unresolved required facts block. Historical summaries stay
genuine summaries, not fabricated local omissions. Documentation alone authorizes
no adoption; workflow3's input change has its explicit assessment above.

When assessing the historical per-session-evidence change, present its measured
benefit and limits before an adoption decision: selected-session consumption can
remain linear; startup admits current configured sessions/established Oversight,
not every historical writer; duplicate validation is per stream, not global.
Old provider rows in the shared app log are not split by runtime. One complete
authorized adoption may cover multiple source changes in its pinned release, but
that does not make their distinct deployed discriminators interchangeable.

### Current selections, previous slots and orphans

Heads select immutable predecessor documents and current-only pending/draft data.
Ordinary card history can be sparse; accepted record documents are consecutive and
independent of mutable revision. Every card/record head publication gets a fresh
UUID: freshness is UUID **and** revision, not an old number or old review verdict.
Mailbox delivery appends conversation context before exact pending removal; duplicate
delivery after interruption is tolerated. Cleared/delivered/unselected bytes remain
ignored and unaddressable, not a queue-history API or cleanup opportunity.

Normal publication clears the exact previous slot, hardlinks current to it, fsyncs
the parent and performs fresh-temp replacement; initial known absence skips link.
No copies/retries/fallback. Interruption may leave no prev or prev equal to current;
inode damage can affect both. Normal startup/runtime never reads prev. Only the
consented repair procedure fresh-publishes a candidate; never rename prev over
current, regenerate a head from history or treat immutable predecessors as rollback.

Replacement uses one fresh exclusive same-directory UUID temporary, fsync, rename,
parent fsync. Harmless noncanonical temporaries, unindexed segments, incomplete or
unlinked card namespaces stay ignored forever: no scans, classification, warnings,
cleanup, reuse, repair or adoption. Reset's four whole-root deletion is not selective
orphan handling. Ordinary Node defaults filtered by umask apply, with no permission
repair. No database, generic recovery protocol or persistence coordination is implied.

## Stop on uncertainty

`PublicationOutcomeUnknownError` means the primitive may have committed. Fatal
delivery writes a fixed stderr diagnostic and exits without application cleanup.
It authorizes **no follow-up read/write, logging, response, descriptor/lock cleanup,
inspection, retry, rollback, replay or reconciliation**. The same boundary applies
to uncertain repair moves and truncation. Do not inspect the target or temporary
files to decide whether an operation committed.

For a separately authorized next lifecycle operation, positively establish no owner,
resolve only the exact abandoned lock under its separate procedure, then start a
genuinely new matching process when authorized. A malformed lock from an interrupted
first record write also fails closed. New startup freshly consumes strict canonical
state and may settle a valid remaining running prefix; it is not inspection/retry of
the uncertain operation. Failed startup is not automatically repeated. A later
explicit Run alone launches project work.
