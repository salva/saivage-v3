#!/usr/bin/env bash
set -euo pipefail
stage_dir="${1:-}"; [[ -d "$stage_dir" ]] || { echo "usage: $0 <stage-dir>" >&2; exit 2; }
python3 - "$stage_dir" <<'PYLINK'
import re, sys
from pathlib import Path
workspace=Path('/work').resolve(); project=Path('/work/saivage-v3').resolve(); stage=Path(sys.argv[1]).resolve(); tops={'saivage-v3','saivage-e2e-checkers','tmp'}
for name in ('design.md','plan.md'):
    text=(stage/name).read_text()
    for target in re.findall(r'\]\(([^)]+)\)', text):
        if '://' in target or target.startswith('#'): continue
        # Documentation placeholders such as <gate-id> are notation, not real links.
        if '<' in target and '>' in target: continue
        if target == 'target': continue
        raw=target.split('#',1)[0]
        if not raw: continue
        raw=raw[2:] if raw.startswith('./') else raw
        parts=Path(raw).parts
        candidate=(workspace/raw) if parts and parts[0] in tops else ((project/raw) if parts and parts[0] in {'.gitignore'} else (stage/raw))
        if not candidate.exists():
            print(f"unresolved link in {name}: {target} -> {candidate}", file=sys.stderr); sys.exit(1)
PYLINK
