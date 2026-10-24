"""MANAGER ONLY after licensing. Real exact native CLI, bounded subprocesses."""
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
cwd = root / 'fixtures'
binary = root / 'venv/bin/ruff'
results = []
def snapshot():
    return {str(p.relative_to(cwd)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in cwd.rglob('*') if p.is_file()}
before = snapshot()
def call(name, args, expected):
    p = subprocess.run([str(binary), *args], cwd=cwd, text=True, capture_output=True, timeout=30)
    results.append({'name': name, 'args': args, 'code': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr})
    assert p.returncode == expected, results[-1]
    return p
try:
    assert call('version', ['--version'], 0).stdout.strip() == 'ruff 0.17.2'
    call('help', ['check', '--help'], 0)
    base = ['check', '--config', 'ruff.toml', '--no-fix', '--no-fix-only', '--no-cache', '--output-format', 'json']
    assert json.loads(call('clean', [*base, 'clean.py'], 0).stdout) == []
    findings = json.loads(call('findings', [*base, 'defect.py'], 1).stdout)
    assert {'F821', 'B006'} <= {x['code'] for x in findings}, findings
    parse = json.loads(call('syntax-error', [*base, 'parse.py'], 1).stdout)
    assert any(x['code'] == 'invalid-syntax' for x in parse), parse
    call('invalid-config', ['check', '--config', 'bad-ruff.toml', '--no-fix', '--no-fix-only', '--no-cache', 'clean.py'], 2)
    call('fix-disabled', [*base, 'fixable.py'], 1)
    selected = call('show-files', ['check','--config','ruff.toml','--no-fix','--no-fix-only','--no-cache','--show-files',
                                  'clean.py','defect.py'], 0)
    assert set(selected.stdout.splitlines()) == {str(cwd/'clean.py'), str(cwd/'defect.py')}
    assert snapshot() == before, 'fixture bytes and names must remain unchanged'
    assert not (cwd/'.ruff_cache').exists()
    assert not (root/'.ruff_cache').exists()
    print('Ruff native qualification passed')
finally:
    (root/'ruff-native-evidence.json').write_text(json.dumps(results, indent=2)+'\n')
