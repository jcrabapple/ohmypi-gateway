#!/usr/bin/env bash
# Deploy ohmypi-gateway on this host.
#
# Guards, in order:
#   1. the built web client must be newer than the client sources (a restart
#      serves whatever sits in web/dist, and web/dist is not in git)
#   2. no live gateway sessions, unless --force (a restart kills every child)
#   3. after the restart, /api/health must report the version in gateway/main.py
#
# Usage: scripts/deploy.sh [--build] [--force] [--dry-run]
#
# Env overrides: OMPGW_UNIT, OMPGW_URL, OMPGW_DIST_DIR, OMPGW_HEALTH_TIMEOUT.
set -euo pipefail

UNIT="${OMPGW_UNIT:-ohmpi-gateway.service}"
URL="${OMPGW_URL:-http://127.0.0.1:9315}"
HEALTH_TIMEOUT="${OMPGW_HEALTH_TIMEOUT:-20}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${OMPGW_DIST_DIR:-$REPO/web/dist}"
TOKEN_FILE="$REPO/auth-token"

BUILD=0
FORCE=0
DRY=0

usage() {
  sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
say() { printf 'deploy: %s\n' "$*"; }

for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    --force) FORCE=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) usage 0 ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

[ -d "$REPO/gateway" ] || die "not in an ohmypi-gateway checkout: $REPO"

# ---- expected version ------------------------------------------------------
EXPECTED="$(grep -m1 '^VERSION = ' "$REPO/gateway/main.py" | cut -d'"' -f2)"
[ -n "$EXPECTED" ] || die "could not read VERSION from gateway/main.py"

# ---- 1. is the built client current? --------------------------------------
if [ ! -f "$DIST/index.html" ]; then
  die "no built web client at $DIST (run: cd web && bun install && bun run build, or pass --build)"
fi

newer="$(find "$REPO/web/src" "$REPO/web/package.json" "$REPO/web/vite.config.ts" \
           -newer "$DIST/index.html" -print -quit 2>/dev/null || true)"
if [ -n "$newer" ]; then
  if [ "$BUILD" = 1 ]; then
    say "web client is stale (newest: ${newer#$REPO/}); building it"
    BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
    [ -x "$BUN" ] || die "bun not found; install it or build the client yourself"
    [ "$DRY" = 1 ] || ( cd "$REPO/web" && "$BUN" run build )
    [ "$DRY" = 1 ] || say "build ok"
  else
    die "web client is stale: ${newer#$REPO/} is newer than $DIST/index.html
       run 'cd web && bun run build', or pass --build to do it here"
  fi
fi

# ---- 2. live sessions ------------------------------------------------------
live=0
if [ -f "$TOKEN_FILE" ]; then
  live="$(curl -fsS -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
            "$URL/api/sessions?include_saved=false" 2>/dev/null \
          | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(len(d.get("live") or []))
for s in (d.get("live") or [])[:8]:
    print("  -", s.get("ompSessionName") or s.get("cwd"), file=sys.stderr)' 2>/dev/null || echo 0)"
fi

if [ "${live:-0}" -gt 0 ]; then
  if [ "$FORCE" != 1 ]; then
    say "$live live session(s) on the gateway; restarting kills them" >&2
    curl -fsS -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
      "$URL/api/sessions?include_saved=false" 2>/dev/null \
      | python3 -c 'import json,sys
for s in json.load(sys.stdin).get("live") or []:
    print("  -", s.get("ompSessionName") or s.get("cwd"), "(" + s.get("gwId","?") + ")", file=sys.stderr)' || true
    die "refusing to restart with live sessions; pass --force to proceed anyway"
  fi
  say "restarting with $live live session(s) because --force was given"
fi

say "web client current, ${live:-0} live session(s), target version $EXPECTED"

if [ "$DRY" = 1 ]; then
  say "dry run: would restart $UNIT and expect version $EXPECTED at $URL"
  exit 0
fi

# ---- 3. restart and verify -------------------------------------------------
say "restarting $UNIT"
systemctl --user restart "$UNIT"

deadline=$((SECONDS + HEALTH_TIMEOUT))
seen=""
while [ "$SECONDS" -lt "$deadline" ]; do
  # /api/health carries the version but is behind the bearer token; /healthz is
  # public and versionless, so it can prove liveness but not identity.
  if [ -f "$TOKEN_FILE" ]; then
    seen="$(curl -fsS -H "Authorization: Bearer $(cat "$TOKEN_FILE")" "$URL/api/health" 2>/dev/null \
            | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))' 2>/dev/null || true)"
  else
    seen="$(curl -fsS "$URL/api/health" 2>/dev/null \
            | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))' 2>/dev/null || true)"
  fi
  [ "$seen" = "$EXPECTED" ] && break
  sleep 1
done

if [ "$seen" != "$EXPECTED" ]; then
  printf 'deploy: FAILED: %s reports version %s, expected %s\n' \
    "$URL" "${seen:-<no answer>}" "$EXPECTED" >&2
  printf 'deploy: recent unit log:\n' >&2
  journalctl --user -u "$UNIT" -n 15 --no-pager >&2 || true
  exit 1
fi

say "OK: $URL is serving $EXPECTED"
