#!/usr/bin/env bash
set -euo pipefail
BASE_URL=""
TOKEN=""
BOOTSTRAP_STATE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --bootstrap-state) BOOTSTRAP_STATE="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$BASE_URL" || -z "$BOOTSTRAP_STATE" ]]; then echo "usage: $0 --base-url URL --token TOKEN --bootstrap-state empty|configured" >&2; exit 2; fi
if [[ "$BOOTSTRAP_STATE" != "empty" && "$BOOTSTRAP_STATE" != "configured" ]]; then echo "invalid bootstrap state" >&2; exit 2; fi
ROOT="tmp/check-mutation-traffic-fixture"
cleanup(){ rm -rf "$ROOT"; }
trap cleanup EXIT
cleanup
mkdir -p "$ROOT/.saivage"
if [[ "$BOOTSTRAP_STATE" == "configured" ]]; then
  cat > "$ROOT/.saivage/auth-profiles.json" <<'JSON'
[{"id":"fixture","label":"Fixture","apiKey":"FIXTURE-FAKE-NOT-A-REAL-KEY","baseUrl":"http://invalid.test.local","providerKind":"stub"}]
JSON
else
  printf '[]\n' > "$ROOT/.saivage/auth-profiles.json"
fi
cat > "$ROOT/.saivage/saivage.json" <<'JSON'
{"schema_version":1,"project":{"id":"fixture","name":"Fixture"},"roles":{},"runtime":{}}
JSON
export SAIVAGE_PROJECT_ROOT="$ROOT"
node --input-type=module - "$BASE_URL" "$TOKEN" <<'NODE'
import { chromium } from 'playwright';
const baseUrl = process.argv[2];
const token = process.argv[3] || '';
const allow = new Set(['POST /api/auth/ws-ticket','POST /api/auth/login','POST /api/auth/logout','POST /api/auth/provider-secret']);
const views = ['/', '/cards', '/dashboard', '/files', '/debug', '/agents'];
const browser = await chromium.launch({ headless: true });
const bad = [];
try {
  const page = await browser.newPage();
  if (token) await page.addInitScript((t) => localStorage.setItem('saivage_api_token', t), token);
  for (const view of views) {
    page.on('request', (req) => {
      const method = req.method();
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
      const url = new URL(req.url());
      const key = `${method} ${url.pathname}${url.pathname.startsWith('/api/chats/') ? '/' : ''}`;
      if (!allow.has(key) && key !== 'POST /api/chats/') bad.push({ method, url: req.url(), view });
    });
    await page.goto(new URL(view, baseUrl).toString(), { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  }
} finally { await browser.close(); }
if (bad.length) { console.error(JSON.stringify(bad, null, 2)); process.exit(1); }
NODE
