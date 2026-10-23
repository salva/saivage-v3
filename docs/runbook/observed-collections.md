# Observed source collections: prepare and adopt

Optional observed collections use deployment-owned native XERJ for initial
indexing and Linux inotify maintenance. Original files/read/grep/glob remain
authoritative. Small or structured files may have **lexical-only** coverage;
observations can be incomplete or stale. Source delivery does not install or
start anything in an existing instance. Live adoption requires separate authority.

## Exact dependencies

Use unmodified source `922921aec0d69b551ea714c40fca601eb331a759` (PR2193 merge).
Qualified Linux x86_64 binary SHA256:
`e6872c55ddd910d2edbccdc3956cd5c4beceffce0899abe15bfad7f3fdd642e1`.
CLI rc.98 is not source identity: dated released rc.98 at
`28de5cfcb0ab5a2078ae001819fd21d8cf132f2e` excludes this fix. Never substitute
“latest” or a released binary based on version text.

Official source archive SHA256:
`d5259299a44638790644e9d547fb3414669ac7792f3ee73c91cefab2010e8534`.
Build that exact source using Rust/Cargo1.99.1:

```sh
cargo build --locked --release --target x86_64-unknown-linux-gnu -p xerj-server --bin xerj -j 4
```

Retain default neural/decide-local and release opt3/fat LTO/codegen-units1/strip/
panic-abort settings. Retain source/build provenance. Preparation checks the
selected digest; a different rebuild needs reviewed qualification/source selection,
not a bypass or old-binary fallback.

Local MiniLM revision `1110a243fdf4706b3f48f1d95db1a4f5529b4d41` assets:

| File | SHA256 |
| --- | --- |
| config.json | 953f9c0d463486b10a6871cc2fd59f223b2c70184f49815e7efbcab5d8908b41 |
| tokenizer.json | be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037 |
| model.safetensors | 53aa51172d142c89d9012cce15ae4d6cc0ca6895895114379cacb4fab128d9db |

Configure neural mode/384 dimensions; expected live identity is
`c40475924188af9e851f7c38e0ed12acf92106cb2f6582bbb80ee7282c790d24`.
Validate it on the actual engine. Assets remain immutable while running; no
runtime model download or feature-hash fallback is configured.

## Define and prepare

Create `.saivage/config/observed-collections.json`:

```json
{"format_version":1,"type":"observed-collections","collections":[
  {"name":"guides","purpose":"Find relevant source documentation","kind":"documentation","directory":"docs","include":["**/*.md"],"exclude":[]},
  {"name":"skills","purpose":"Find methods, then read originals","kind":"documentation","directory":".github/skills","include":["**/*.md"],"exclude":[]},
  {"name":"code","purpose":"Locate implementation references","kind":"code","directory":"src","include":["**/*.ts"],"exclude":["**/*.test.ts"]}
]}
```

Roots must exist, including intentionally empty roots. Identical canonical roots
share a watcher; distinct overlapping roots are rejected. Logical view edits do
not rotate prefixes. XERJ elects actual datasets, including nested repository
scopes; **never guess prefix-docs**. See the [strict fields](../reference/configuration.md#optional-observed-source-inputs).

```sh
saivage observed-collections prepare \
  --project-root /work/project --output /opt/observed-project-bundle \
  --executable /opt/xerj/bin/xerj --model-directory /opt/xerj/model \
  --data-directory /var/lib/observed-project --user saivage \
  --port 19880 --rest-port 19881 --grpc-port 19882
```

Output must be fresh; its parent and the native storage base must already exist.
Both are outside the project. Exact root metadata checks resolve aliases without
walking source bodies/siblings. Private `.saivage`, Git internals, engine/model/
storage roots and escaping aliases are refused; `.github/skills` is allowed.

The bundle contains private `observed-collections-native.json`, `engine.toml`,
`commands.json` with exact argv/environment, quoted watcher scripts and
instance-specific systemd units/target. Keep its selected absolute path.
Preparation does not read/copy tokens, walk sources, execute XERJ, download,
call HTTP, create indexes or operate systemd. Partial failure leaves evidence;
do not blindly rerun into the same directory. File creation uses ordinary umask.

## Authorized installation and automatic start

1. Install the private descriptor at
   `.saivage/config/observed-collections-native.json`. Do not expose it through
   source, Files, logs or chat. Logical definitions are separate.
2. Install a strong private **64-character hexadecimal** token at `.saivage/config/xerj.key`, accessible
   to intended deployment/runtime users through deployment-owned controls.
   Contract: nonblank opaque text≤4096 UTF-8 bytes total, no embedded whitespace/
   controls, one optional final newline. The generated native deployment uses
   the64-hex subset because XERJ's existing admin.key reader requires it; arbitrary
   opaque strings would trigger native key regeneration. The engine launcher
   rejects wrong shape or a different engine/client key before execution. No
   inline/URL/configurable-path token.
3. Create the exact engine/watch directories from `commands.json` / `ADOPT.txt`,
   owned by the service user. **Before starting**, link `engine_key`
   (`.../engine/admin.key`) to the installed fixed key. This is XERJ's supported
   existing-admin-key input, not a second credential family. Do not allow missing
   input to select native automatic credential generation. Preparation creates
   neither the link nor the key.
4. Install generated services/target and reload systemd under operational
   authority. Enable/start the target named in ADOPT.txt: it starts the private
   engine and all root watchers automatically. Watchers read the fixed key into
   private `XERJ_API_KEY`; it never appears in argv. Keep scripts/flags intact.
5. Verify all three actual sockets are loopback and reject missing/invalid auth.
   Use private Authorization headers, never URL tokens. Verify actual neural
   identity. Inspect actual catalog root/prefix/dataset associations; query a
   selected destination and read the original source to assess attribution.
   Empty catalog means initializing/unknown, not proven completely empty indexing.

With the shipped Analyst/Planner/Executor/Reviewer grants (or explicit custom
grants), call `list_observed_collections({})`, then for example
`query_observed_collections({collections:["guides","skills"],query:"cancel only the current request",intent:"conceptual",limit:10})`.
Use ordinary `read` on an admitted returned path. Conceptual intent can produce
lexical-only references when no semantic fields exist; inspect channel/coverage
facts rather than assuming embeddings. Node ceilings and external Analyst
allowlists can still deny a configured role tool. Oversight gains no grant.
Supported excerpt carriers are native `impl`, `body` and `text`, in that precedence
order. Short-line notes/checklists may be native `text` windows rather than prose
bodies. Windows join nonblank lines and may be capped: reported coordinates remain
unavailable, not reconstructed from original reads. Plain mapped text is lexical,
not proof of a neural field. Across destinations, useful evidence can remain
available while `metadata_unavailable` discloses lost metadata and unknown coverage.

No manual indexes/mappings, copy pipelines/templates, dry-run/walk-only or
future-index monitor. Watchers use `--watch --no-graph --no-default-ignores
--code-analyzer code`, no symlink following or excluded-tree deep counting.
They index initially and after events, including later empty-root population.
Native ignores/visible private-name exclusions remain best effort; nested negation
may override them. Accepted private local indexing does not authorize disclosure.

## Lifetimes, resources and limits

Observation continues independently of app close/project Stop or query cancellation.
Units bind watcher/target lifetime to the engine; replacement restarts dependents
for native catch-up. Actual failures use `Restart=on-failure`,5s delay and3 starts
per120s. Review CPU/memory/task limits with unit drop-ins and size disk/inotify
limits for approved roots. Native preparation can be O(N), not O(changed bytes).

An alive failed pass may wait for another event and stay stale. Do not force
restart on timers or ambiguous HTTP outcomes. Incomplete walks/incompatible-file
skip/drop may remove derived observations, not originals. Search misses do not
prove source absence. Native startup logs may contain bootstrap credentials:
keep them private, never forward raw logs/payloads. Offline model settings alone
do not prove zero egress; qualify the actual deployment network boundary.

Native/model contract changes require reviewed selection and explicit adoption/
restart with fresh selected namespace/state. Ordinary content/ignore edits do
not. Old destinations remain unselected, without automatic cleanup/scans/migration.
Saivage generated-state reset preserves definitions/descriptor/key and does not
own external native indexes. This page itself authorizes no live service action.
