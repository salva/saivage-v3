# Native quality tooling: qualification inputs and limits

Provisioning is explicit contributor/CI work via
`bash tests/tools/quality-native/provision.sh /absolute/fresh/scratch-root` with the
qualified Node/npm versions on PATH. Use an existing parent outside the checkout;
the target must not exist. This installs only that isolated npm tree and Python
venv with the tracked locks/hashes. Export its path as `SAIVAGE_QUALITY_NATIVE_ROOT`,
set `NODE_DISABLE_COMPILE_CACHE=1` and `SAIVAGE_QUALITY_TEST_SCRATCH`, then build
before `npm run test:quality:compiled`. Runtime tools never call provisioning.

This is a **development prerequisite reference**, not deployment or product
acceptance certification. Explicit compiled quality actions use these pins through
one packaged isolated helper. They require operator-selected configuration and
preprovisioned modules/binaries; nothing is installed on use or selected by default.
Optional agent-tool binding selects the same compiled actions through a narrow
runtime port; it adds no default grant or runtime installation.
See [configuration](./configuration.md#quality-actions).

Native engine development tests require that explicit provisioned root in
`SAIVAGE_QUALITY_NATIVE_ROOT` and `NODE_DISABLE_COMPILE_CACHE=1`. They fail if the
prerequisite is missing; they never use this repository's root ESLint as a fallback.
Build the matching source before running `tests/quality/native-engines.test.ts`:
that test launches `dist/tests/scripts/quality-native-engines.js` in standalone Node
so native package imports use Node resolution rather than Jest's VM resolver. The
standalone harness retains the real clean/defect/typed-coverage and negative assertions;
a missing build or provisioned tool tree fails rather than skipping the witnesses.
The pinned native loader consumes each selected package's evidenced public entry:
ESLint `exports["."].default` (`./lib/api.js`), typescript-eslint
`exports["."].default` (`./dist/index.js`), and TypeScript `main`
(`./lib/typescript.js`). It checks package identity/version/entry metadata and
resolved entry containment at use, then imports that exact file. Absolute-directory
resolution is not equivalent to package-export resolution; there is no alternate
installation search or fallback. Effective parser/plugin/rule identity checks still
compare the actual loaded objects with the native configuration's objects.
The manager runs them only after isolated provisioning and coherent integration;
native engine tests do not establish ProcessRunner, publication or tool admission.

## Pins and isolated provisioning

The private [qualification package](https://github.com/salva/saivage-v3/tree/HEAD/tests/tools/quality-native)
has its own manifest and actual npm lock. It does not replace root lint dependencies.
Use Node **24.22.0**, npm **11.19.1**, Python with `venv`/`ensurepip`, curl, and
Linux x86_64 with glibc>=2.17 for the selected Ruff wheel. No Rust build or global
Python installation is needed. Other platforms are not qualified by this wheel.

| Component | Exact input / integrity | Implementation license |
| --- | --- | --- |
| ESLint10.13.0 | `sha512-UohDjD4zSzEwhf58M3O7vc/ycc8O1I7dNlhtD0WxE8Px8EHNJKtUwzBqrzeGhisRuv2ag4sAYswszCJRgKXYUg==` | MIT |
| typescript-eslint8.72.0 | `sha512-r26Fkc8As+mZvqp7SLsMmNFyYUup/6CjK7/eHBHmhOw6GH6n6YFxHVFrG0jN1c5CMpDzelLPxvgeCOzx7BjN+A==` | MIT |
| TypeScript5.9.3 | `sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==` | Apache-2.0, with separately retained included notices |
| Ruff0.17.2 manylinux2.17 x86_64 wheel | SHA256 `c60f93fec7142dba5b8f487f94bf2f6231dae24dc11e4c48648347c8b0720004` | MIT plus native/embedded components below |
| Ruff0.17.2 source archive | SHA256 `84d632402d14c23b488f941db23712d6736a013225162062d34558c3f3c780eb` | Source/Cargo license evidence, not installed or built |

Official inputs: [ESLint registry](https://registry.npmjs.org/eslint/10.13.0),
[typescript-eslint registry](https://registry.npmjs.org/typescript-eslint/8.72.0),
[TypeScript registry](https://registry.npmjs.org/typescript/5.9.3), and
[Ruff PyPI release](https://pypi.org/pypi/ruff/0.17.2/json).
The actual lock SHA256 is
`9f2a90ee3f23d6382200d035624bb67845ec6eb4314c87df980b9c610b80d2a1`.
Each installed transitive selection has its own resolved URL/integrity, not a
claim that root version pins alone freeze dependency ranges.

From the repository root with that Node/npm already selected in PATH:

```bash
bash tests/tools/quality-native/provision.sh /absolute/scratch/quality-native
```

The target must be fresh and outside the checkout. The script copies only
qualification sources/fixture templates, uses `npm ci --ignore-scripts`, a local
cache/empty npm configs, and installs the hash-checked wheel into a local venv
offline. Fetches are bounded and have no retry. No analyzer is executed by
provisioning. Keep installed packages/binaries, venvs, caches, reports and traces
outside Git. Do not install directly in this source directory.

On the project host, wrap the whole command with
`/usr/bin/gnutimeout -k 10s 600s bash -c '<command>'` and give the outer tool at
least640 seconds. GNU timeout must be positively identified; an executable named
`timeout` alone is not sufficient here. The script itself is portable to other
qualified developer/CI hosts with their own finite command supervisor.

## Evidence status

As of2026-10-24, the implementation manager ran real pinned native basics in an
isolated Linux tree, with actual filesystem/network traces:

- Typed TS clean files carried actual configured parser identity, enabled aliased
  typed-rule identity/severity, Program, type checker, maps and bound config-file
  identity during the same lint consumption. Floating Promise, misused Promise
  callback and await-thenable defects produced actual diagnostics.
- Valid syntax-only configuration, disabled typed rules, mixed per-file override,
  suppressed private observer and fatal parse cases did not qualify as typed clean.
- Real JS clean/error/warning and invalid configuration semantics passed; native
  ESLint CLI0 can include warnings and therefore does not imply no findings.
- Real Ruff0/1/2, undefined name, B006, syntax error, bad config, show-files and
  configured `fix=true` overridden by `--no-fix` passed with fixture bytes unchanged.
- Initial traces recorded **zero network calls** in the observed runs. Ruff's
  only write-intent open was the harness evidence JSON. ESLint's first trace
  additionally showed **1068 Node compile-cache-related operations**, including
  successful writes/renames, from its native CLI. That first run did **not** pass
  the no-cache qualification. Preserve this limitation rather than rewriting it
  as a clean run.

**M1 native prerequisite qualification completed:** the manager ran the refined
ESLint and Ruff basic harnesses and the separate extra `rerun2`; all passed.
Extra checks covered out-of-project TS, empty/ignored/unmatched/unsupported scopes,
explicit exclusions and unchanged source/cache sentinels, including Ruff config
with both fix and fix-only enabled. Manager inspection of the refined traces
found only harness evidence JSON writes and no socket/connect/sendto calls; extra
trace writes were confined to its own fixtures, sentinels and evidence. Together
with the completed static license review, these observations close M1's native
qualification gate for the exact local fixture/tooling scope. Repository validation
and commit remain separate manager gates; product implementation is not qualified.
The first extra run stopped at its clean Ruff exit assertion: the harness returned
the raw subprocess object (`status`) but asserted its own receipt field (`code`).
The preserved native receipt records exit0, `[]` and empty stderr; this was a
harness defect, not a Ruff failure. Both harness copies now return the recorded
result consistently, without changing expected exits. Remaining cases were not
completed by that failed run.
No product action/tool, ProcessRunner integration, publication/UI, full release
or model-quality result follows from these native basics.

## Source-backed launch requirements

These are implementation requirements for the eventual fixed helper, not new
caller-selected options or proof of containment of operator-authored config:

1. **Node disk compile cache:** the [ESLint10.13.0 CLI entry point](https://github.com/eslint/eslint/blob/v10.13.0/bin/eslint.js#L15) explicitly invokes
   `node:module.enableCompileCache()`. Launch Node with
   `NODE_DISABLE_COMPILE_CACHE=1`; API `cache:false` controls ESLint result caching,
   not Node's disk compilation cache. The refined disabled-cache rerun passed.
2. **Existing ESLint cache deletion:** the [pinned ESLint implementation](https://github.com/eslint/eslint/blob/v10.13.0/lib/eslint/eslint.js#L1009-L1022) deletes an
   existing cache path when result caching is disabled. Set `cacheLocation` to a
   fixed, initially absent path inside the invocation-owned output namespace even
   with `cache:false`. Never point it at the target project's existing `.eslintcache`.
   The extra fixture preserves a target-owned sentinel and tests this distinction.
3. **Ruff fix-only:** the [Ruff0.17.2 implementation](https://github.com/astral-sh/ruff/blob/0.17.2/crates/ruff/src/lib.rs#L298-L304) applies fixes when
   either `fix` **or** `fix_only` is set. Fixed argv must include both `--no-fix`
   **and `--no-fix-only`**, plus `--no-cache`; no formatter/output-fixes invocation.
   The extra fixture enables both settings in TOML and requires unchanged source.
4. **Scope/coverage:** ESLint's empty patterns otherwise mean cwd; use strict
   nonempty intended scope, never infer clean from empty output. Ruff's check
   returns empty diagnostics when no supported paths remain; show-files is needed
   for actual selection. Explicit exclusions must also govern explicitly named
   files (`--force-exclude` for Ruff). Unsupported/missing/unmatched scope is not
   successful complete analysis merely because some native exit is0.
5. **Explicit native config:** ESLint's config-loader resolves an explicit override
   filename and dynamically imports it, including its code dependencies. It does
   not make that config harmless. The qualified fixture uses MJS, not additional
   Jiti-based TS config loading. Typescript-eslint builds a Program for explicit
   project selection; no compiler emit or project-service feature is invoked by
   the fixture. Ruff's explicit TOML/pyproject selection and CLI overrides remain
   native policy. Config imports/extends/plugins require their own offline/no-write
   qualification; user auth/executable boundaries cannot be inferred from a pin.

Actual selected engine/config paths showed no updater/network work during the
traced fixtures. Source inspection found native local config loading and explicit
cache/fix controls, not an automatic update operation in this invocation path.
This does not prove arbitrary plugins/config code cannot network or write. No
cloud/upload/telemetry path is authorized. Do not invoke npx/uvx or install-on-use.

## Repeat native qualification

From a freshly provisioned scratch tree:

```bash
NODE_DISABLE_COMPILE_CACHE=1 node qualify-eslint.mjs
python3 qualify-ruff.py
NODE_DISABLE_COMPILE_CACHE=1 node qualify-extra.mjs
```

Use finite outer limits (180seconds is the preparation budget) and retain natural
exits/results. `qualify-extra.mjs` creates a new scratch-only fixture root and
refuses to overwrite it. Original executed preparation scripts/results are not
part of this source package. The tracked basic scripts write
`eslint-native-evidence.json` and `ruff-native-evidence.json`; extra checks write
`extra-qualification.json`.

For a separate extra-check attempt against an existing installation, use
`NODE_DISABLE_COMPILE_CACHE=1 node /absolute/source/qualify-extra.mjs /absolute/install/root rerun2`.
The optional lowercase suffix selects fresh `extra-fixtures-rerun2` and
`extra-qualification-rerun2.json`; fixture creation and evidence publication are
exclusive. Use a fresh trace filename too. The basic scripts instead resolve
their installation relative to their own script path: copy the tracked scripts
under fresh filenames directly into the provisioned root before running them.
Their refined evidence filenames remain distinct from the original preparation
receipts; do not overwrite an existing refined receipt on a later attempt.

For observational network/write evidence, trace each bounded command with
`strace -f -qq -e trace=%file,network -o <fresh-trace>` where available. Fixture
snapshots check names/bytes; inspect traces as well for cache/delete/write intents
outside the expected harness output. Tracing is not a network sandbox or universal
no-effects guarantee. These standalone qualification/trace procedures remain
separate from ordinary Jest. Product integration now runs required native checks
through `test:quality:compiled` in release validation and applicable CI, with
explicit isolated provisioning; see [validation](../validation.md). Missing
prerequisites fail rather than silently skip. Those product checks do not imply
that these separate trace procedures ran on CI.

## Bounded license qualification

The [component reference](https://github.com/salva/saivage-v3/blob/HEAD/tests/tools/quality-native/license-components.json)
records exact versions, source URLs/integrities and declared terms for95 actual
npm packages and the conservatively overinclusive native source closures. It is
documentation, not a runtime license registry or permission detector. Native
membership is **not** asserted to be a precise linked-component list.

Scope approved by static engineering review: **unchanged upstream packages used
locally for analysis**, with complete installed upstream notices retained. No
analyzer binary/source bundle is shipped by this unit. This is not legal advice,
a patent opinion, historical authorship certification or permission to redistribute
under different terms. No SSAL, noncommercial, AI-use or proprietary implementation
restriction was found affecting this scope. A genuine new conflict blocks adoption.

| Material / evidence | Applicable terms and obligations |
| --- | --- |
| Actual npm closure | MIT69, Apache2 thirteen, BSD2 six, ISC5, BSD3 one, BlueOak1 one. Retain applicable copyright, grant, disclaimer, Apache notices/change indications and BSD nonendorsement. BlueOak requires license text or its specified link to recipients of copies. Exact rows are in the component reference. |
| Missing LICENSE filenames | `esrecurse4.3.0` has full BSD2 in executable source; `imurmurhash0.1.4` full MIT in README; `natural-compare1.4.0` executable header/README/package expressly MIT; `@humanfs/types0.15.0` README/package expressly Apache2. Keep those declarations; do not invent absent notice files or confuse filename absence with no grant. |
| TypeScript5.9.3 | Preserve LICENSE.txt **and** ThirdPartyNoticeText.txt/headers. Apache implementation plus included MIT; Unicode-DFS-2016 data/software; W3C-20150513 and CC-BY-4.0 specification-derived declarations/descriptions; Khronos MIT-style WebGL. Keep attribution/licenses/disclaimers, no endorsement or unsupported patent clearance. These are not NC/ND terms and must not be flattened to Apache-only. |
| TypeScript residual Background Synchronization notice | Preserve the supplied W3C Community Final Specification Agreement attribution. This task uses the unmodified package, not a new specification derivative or browser synchronization implementation. Do not invent a source spec version; creating a new derivative requiring exact version attribution would need separate resolution. |
| Ruff native/embedded software | Actual source Cargo.lock produced431 checksum-verified registry archives and37 reached workspace packages; native/data notices examined, not merely Python requires_dist. Conservative graph includes optional/dev/other-platform components. No source build is performed. |
| Native exceptions | jemalloc BSD2 independently of MIT/Apache wrapper; zstd BSD3 explicitly selectable instead of its GPL alternate; libcst Rust tokenizer MIT+PSF2; MPL2 for colored/option-ext/version-ranges with executable-distribution source availability obligations; Unicode3/DFS2016 software/data notices; terminfo WTFPLv2 unrestricted use. Preserve **AND** clauses and embedded notices, not just wrapper SPDX. |
| Source tests and data | rust-stemmers' GPL vocabulary files are read by `#[cfg(test)]` tests, not these analyzer invocations; generated Snowball algorithms retain BSD3. jiff-tzdb0.1.4 identifies IANA2025b data, whose pinned LICENSE declares public domain except named BSD3 code/doc files. Optional Linux embedding is not asserted from lock membership. |
| Native notice filenames | r-efi's full alternatives are in AUTHORS. Exact source manifests of collection_literals/quote-use/seahash explicitly declare MIT without separate named full license files. Preserve actual declarations; no fabricated copyright or broad exception for unknown grants. |
| Rust runtime | Wheel producer string identifies rustc1.99.0/b940084d7; actual library lock49 entries (30 registry archives), source metadata and notices examined as a conservative bound. Standard code MIT/Apache; Unicode separately; compiler_builtins0.1.160 combined MIT/Apache+LLVM terms, with actual libm/derived math notices. Not proof of reproducible builds or exact link membership. |
| Platform | Static ELF shows glibc-family and libgcc_s dependencies; Node also libstdc++/GNU loader. Observed host libc6 2.43-2ubuntu2.4 and GCC runtimes16-20260322-1ubuntu1 have LGPL and GPL3+ Runtime Library Exception3.1 terms respectively. Existing libraries are used locally, not rebuilt/distributed. Preserve matching notices/source/linking obligations on any later redistribution; do not assume another host has these versions. |

Installed direct npm notices and Ruff binary/LICENSE bytes were checked unchanged
against original artifacts. Original Ruff ELF SHA256:
`396f38351ef19df216c0aa7a230305e2aca19fd537d3eaaf5e4dd5fba33de82c`;
wheel LICENSE SHA256:
`2597d854122b77ddc71971564ca2350a37608575ce324adc5650a2b2051c8f18`.
Retain complete upstream notices in provisioned artifacts; this bounded summary
is not their replacement. Changes to pins, dependencies, config code, platform,
or distribution/use require renewed applicable qualification.
