#!/usr/bin/env bash
# Explicit contributor/CI provisioning, never called by runtime tools.
set -euo pipefail
test "$(node --version)" = v24.22.0
test "$(npm --version)" = 11.19.1
source_dir=$(cd "$(dirname "$0")" && pwd)
target=${1:?Supply a fresh absolute scratch directory outside the repository}
case "$target" in /*) ;; *) echo 'Expected absolute scratch path' >&2; exit 1;; esac
repository=$(cd "$source_dir/../../.." && pwd)
parent=$(cd "$(dirname "$target")" && pwd -P)
target="$parent/$(basename "$target")"
case "$target/" in "$repository/"*) echo 'Provision outside the repository' >&2; exit 1;; esac
mkdir "$target"
cp "$source_dir/package.json" "$source_dir/package-lock.json" "$source_dir/requirements.txt" "$target/"
cp "$source_dir/qualify-eslint.mjs" "$source_dir/qualify-ruff.py" "$source_dir/qualify-extra.mjs" "$target/"
mkdir "$target/fixtures" "$target/wheelhouse"
for fixture in "$source_dir"/fixtures/*.fixture; do
  name=$(basename "$fixture" .fixture)
  cp "$fixture" "$target/fixtures/$name"
done
: > "$target/npm-user.npmrc"
: > "$target/npm-global.npmrc"
export npm_config_userconfig="$target/npm-user.npmrc"
export npm_config_globalconfig="$target/npm-global.npmrc"
export npm_config_cache="$target/npm-cache"
export npm_config_update_notifier=false npm_config_audit=false npm_config_fund=false
export npm_config_ignore_scripts=true npm_config_engine_strict=true
export npm_config_fetch_retries=0 npm_config_fetch_timeout=30000
export NODE_DISABLE_COMPILE_CACHE=1
cd "$target"
npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
wheel="$target/wheelhouse/ruff-0.17.2-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"
curl --fail --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 60 \
  --silent --show-error --output "$wheel" \
  https://files.pythonhosted.org/packages/c3/d8/59894cf630d2d86882457a2a6a0a1533410c5c805bfbac6f6eb4b5aef69d/ruff-0.17.2-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl
echo "c60f93fec7142dba5b8f487f94bf2f6231dae24dc11e4c48648347c8b0720004  $wheel" | sha256sum --check
python3 -m venv "$target/venv"
PIP_CONFIG_FILE=/dev/null PIP_DISABLE_PIP_VERSION_CHECK=1 "$target/venv/bin/python" -m pip install \
  --no-index --find-links "$target/wheelhouse" --require-hashes --only-binary=:all: -r requirements.txt
printf '%s\n' 'Provisioning complete; no analyzer executed. Review qualification reference before running fixtures.'
