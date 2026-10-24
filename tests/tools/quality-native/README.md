# Isolated native quality qualification

Development-only prerequisites and witnesses; no Saivage runtime integration or
default tool grant. See [qualification reference](../../../docs/reference/quality-tool-qualification.md).

Provision into a fresh **absolute scratch directory outside this repository**:

```bash
bash tests/tools/quality-native/provision.sh /absolute/scratch/quality-native
```

Use Node24.22.0/npm11.19.1, Python with venv/ensurepip, Linux x86_64/glibc>=2.17,
and curl. Provisioning downloads only official locked packages and the hash-pinned
wheel; it does not execute analyzers. It never installs into the source checkout.
Fixture `.fixture` suffixes keep deliberately invalid TS out of repository tsc.

After reviewing the license reference and provisioning, from that scratch tree:

```bash
NODE_DISABLE_COMPILE_CACHE=1 node qualify-eslint.mjs
python3 qualify-ruff.py
NODE_DISABLE_COMPILE_CACHE=1 node qualify-extra.mjs
```

Each command needs a finite outer deadline (GNU timeout on the project host).
Qualification writes only scratch results. Keep first-run/failure traces; later
runs are not permission to erase evidence. To repeat, provision a fresh directory.
Use syscall tracing for observed network/filesystem behavior, not a sandbox claim.

Manager qualification passed the refined basic harnesses and extra scope/sentinel
checks on the exact pinned local installation. Original compile-cache observations
and the first extra harness return-field failure remain documented in the reference;
neither is retroactively a pass. This is not product/runtime qualification.

Provisioning retains complete upstream package contents, including LICENSE,
NOTICE, README grants and source headers; do not strip these after installation.
The component reference summarizes applicable terms but does not replace notices.

These are explicit standalone checks, **not yet included** in ordinary Jest or CI
profiles. Applicable CI integration and product behavior tests belong to the later
runtime implementation. No skipped/unavailable native check counts as a pass.
