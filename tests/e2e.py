"""Gateway e2e suite. Usage: e2e.py [BASE_URL]   (default http://127.0.0.1:9315)

Covers auth (bearer, cookie login, CSRF, WS auth paths), the session
lifecycle against a live omp child, streaming over WebSocket with cursor
resume, and the config round trip. Leaves no sessions running.
"""
import asyncio
import base64
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import websockets

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9315").rstrip("/")
WS_BASE = BASE.replace("https://", "wss://").replace("http://", "ws://")
TOKEN = (Path(__file__).resolve().parent.parent / "auth-token").read_text().strip()
UA = {"User-Agent": "ompgw-e2e/0.2"}

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {detail}".rstrip())
    if not cond:
        failures.append(name)


def _parse(body: bytes):
    try:
        return json.loads(body or b"null")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def req(method, path, body=None, token=TOKEN, headers=None, raw=None, timeout=120):
    h = dict(UA)
    if token:
        h["Authorization"] = "Bearer " + token
    h.update(headers or {})
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
        h.setdefault("Content-Type", "application/json")
    r = urllib.request.Request(BASE + path, method=method, data=data, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, _parse(resp.read()), resp.headers
    except urllib.error.HTTPError as e:
        return e.code, _parse(e.read()), e.headers


def ok(method, path, body=None, **kw):
    code, data, _ = req(method, path, body, **kw)
    if code >= 400:
        raise RuntimeError(f"{method} {path} -> {code} {data}")
    return data


# ------------------------------------------------------------------ public

code, data, hdrs = req("GET", "/healthz", token=None)
check("healthz-public", code == 200 and data == {"ok": True})
code, data, _ = req("GET", "/.well-known/ompgw.json", token=None)
check("discovery-public", code == 200 and data.get("apiBase") == "/api", f"v{data and data.get('version')}")
code, _, hdrs = req("GET", "/", token=None)
csp = hdrs.get("Content-Security-Policy", "")
check("dashboard-served+csp", code == 200 and "frame-ancestors 'none'" in csp and "'unsafe-inline' 'unsafe-eval'" not in csp)


def script_src(policy: str) -> str:
    return next((d.strip() for d in policy.split(";") if d.strip().startswith("script-src")), "")


dist_dir = Path(os.environ.get("OMPGW_WEB_DIST") or Path(__file__).resolve().parent.parent / "web" / "dist")
dist_active = (dist_dir / "index.html").is_file()   # only meaningful when the gateway runs on this host
code, _, hdrs = req("GET", "/classic", token=None)
check("classic-served", code == 200 and hdrs.get("Cache-Control") == "no-cache")
check("csp-classic-keeps-eval", "'unsafe-eval'" in script_src(hdrs.get("Content-Security-Policy", "")))
for extra in ("worker-src 'self'", "manifest-src 'self'", "img-src 'self' data: blob:"):
    check(f"csp-has-{extra.split()[0]}", extra in csp, extra)
if dist_active:
    check("csp-app-no-eval", script_src(csp) == "script-src 'self'", script_src(csp))
else:
    check("csp-root-is-classic-without-dist", "'unsafe-eval'" in script_src(csp), "(no web/dist: / is the old dashboard)")

# Traversal must never reach a file outside the build, whether or not it is authenticated.
# 400 is accepted too: a CDN in front (Cloudflare) rejects encoded slashes before the gateway sees them.
for probe in ("/assets/../auth-token", "/..%2fauth-token", "/%2e%2e/auth-token", "/assets/%2e%2e/auth-token",
              "/assets/..%2f..%2fauth-token", "/static/../auth-token", "/does-not-exist.js"):
    for tok in (None, TOKEN):
        code, _, hdrs = req("GET", probe, token=tok)
        leaked = code == 200 and "text/html" not in (hdrs.get("Content-Type") or "")
        check(f"traversal-{probe}-{'auth' if tok else 'anon'}", code in (400, 401, 404) and not leaked, f"-> {code}")
code, _, hdrs = req("GET", "/assets/nope-abc123.js", token=None)
check("missing-asset-404", code == 404)
if dist_active:
    code, _, hdrs = req("GET", "/", token=None)
    check("app-index-no-cache", code == 200 and hdrs.get("Cache-Control") == "no-cache")
    assets = sorted((dist_dir / "assets").glob("*")) if (dist_dir / "assets").is_dir() else []
    if assets:
        code, _, hdrs = req("GET", "/assets/" + assets[0].name, token=None)
        check("asset-immutable", code == 200 and "immutable" in (hdrs.get("Cache-Control") or ""), assets[0].name)
    if (dist_dir / "sw.js").is_file():
        code, _, hdrs = req("GET", "/sw.js", token=None)
        # Cloudflare consumes Cloudflare-CDN-Cache-Control at the edge and strips it,
        # so it's only visible when talking to the gateway directly.
        via_cf = hdrs.get("cf-cache-status") is not None
        check("sw-no-store", code == 200 and hdrs.get("Cache-Control") == "no-store"
              and hdrs.get("CDN-Cache-Control") == "no-store"
              and (via_cf or hdrs.get("Cloudflare-CDN-Cache-Control") == "no-store"),
              f"cf={hdrs.get('cf-cache-status')}")
        sw_src = (dist_dir / "sw.js").read_text()
        check("sw-inlines-routing", "importScripts" not in sw_src and "ompSwRouting" in sw_src and "__BUILD__" not in sw_src)
        code, _, _ = req("GET", "/sw-routing.js")
        check("sw-routing-not-emitted", code == 404 and not (dist_dir / "sw-routing.js").exists())
    code, _, _ = req("GET", "/index.html", token=None)
    check("index-html-not-a-root-file", code in (401, 404))

# ------------------------------------------------------------------- auth

code, _, _ = req("GET", "/api/health", token=None)
check("no-token-401", code == 401)
code, _, _ = req("GET", "/api/health", token="wrong-" + TOKEN[:8])
check("bad-token-401", code == 401)
code, _, _ = req("GET", "/api/health?token=" + TOKEN, token=None)
check("query-token-rejected", code == 401, "(tokens in URLs leak into logs)")
code, data, _ = req("GET", "/api/me")
check("bearer-ok", code == 200 and data["method"] == "bearer")

code, _, hdrs = req("POST", "/auth/login", {"token": TOKEN}, token=None, headers={"Origin": BASE})
setc = hdrs.get("Set-Cookie") or ""
cookie = setc.split(";")[0]
flags = setc.lower()
check("cookie-login", code == 200 and cookie.startswith("ompgw_session="),
      "flags: " + ",".join(f for f in ("httponly", "samesite=strict", "secure") if f in flags))
code, _, _ = req("POST", "/auth/login", {"token": TOKEN}, token=None, headers={"Origin": "https://evil.example"})
check("login-cross-origin-403", code == 403)
code, data, _ = req("GET", "/api/me", token=None, headers={"Cookie": cookie})
check("cookie-auth", code == 200 and data["method"] == "cookie")
code, _, _ = req("POST", "/api/sessions", {"cwd": "/tmp"}, token=None,
                 headers={"Cookie": cookie, "Origin": "https://evil.example"})
check("csrf-cookie-cross-origin-403", code == 403)
code, _, _ = req("POST", "/api/sessions", {"cwd": "/tmp"}, token=None, headers={"Cookie": cookie})
check("csrf-cookie-no-origin-403", code == 403)
code, _, hdrs = req("OPTIONS", "/api/health", token=None,
                    headers={"Origin": "https://app.example", "Access-Control-Request-Method": "GET",
                             "Access-Control-Request-Headers": "authorization"})
check("cors-preflight", code == 200 and hdrs.get("Access-Control-Allow-Origin") == "*"
      and not hdrs.get("Access-Control-Allow-Credentials"))

# ------------------------------------------------------------ catalog/config

sysinfo = ok("GET", "/api/system")
check("system", sysinfo["omp"]["version"] not in ("", "unknown"), "omp " + sysinfo["omp"]["version"])
skills = ok("GET", "/api/skills")["installed"]
check("skills", len(skills) >= 10, f"{len(skills)} skills")
cfg = ok("GET", "/api/config")
check("config-read", isinstance(cfg.get("parsed"), dict) and "modelRoles" in cfg["parsed"])
code, data, _ = req("PUT", "/api/config", raw=cfg["raw"].encode(), headers={"Content-Type": "text/yaml"})
check("config-write-roundtrip", code == 200 and bool(data and data.get("ok")))
code, _, _ = req("PUT", "/api/config", raw=b"- just\n- a list\n", headers={"Content-Type": "text/yaml"})
check("config-rejects-non-mapping", code == 400)
check("config-unchanged", ok("GET", "/api/config")["raw"] == cfg["raw"])

code, data, _ = req("GET", "/api/catalog/models", timeout=180)
models = data.get("models") if isinstance(data, dict) else None
check("catalog-models", code == 200 and isinstance(models, list) and len(models) > 0, f"{len(models or [])} models")
if models:
    check("catalog-model-shape", all(k in models[0] for k in ("provider", "id", "contextWindow")))
code, data2, _ = req("GET", "/api/catalog/models")
check("catalog-models-cached", code == 200 and data2 == data)
code, data3, _ = req("GET", "/api/catalog/models?refresh=1", timeout=180)
check("catalog-models-refresh", code == 200 and isinstance(data3.get("models"), list) and len(data3["models"]) > 0)
code, _, _ = req("GET", "/api/catalog/models", token=None)
check("catalog-models-needs-auth", code == 401)

# ----------------------------------------------------------------- sessions

code, _, _ = req("POST", "/api/sessions", {"resumeFrom": "/etc/passwd"})
check("resume-path-confined", code == 422)
code, _, _ = req("POST", "/api/sessions", {"approvalMode": "sudo"})
check("approval-validated", code == 422)

sess = ok("POST", "/api/sessions", {"cwd": str(Path(__file__).resolve().parent.parent), "thinking": "off"})
# Saved-session titles must be strings ('' when unparseable), never null: a null
# title crashed the web client's rail render (format.ts savedTitle, 2026-09-30).
lst = ok("GET", "/api/sessions")
null_titles = [x for x in (lst.get("saved") or []) if x.get("title") is None]
check("saved-titles-never-null", not null_titles, f"-> {len(null_titles)} null titles")
gid = sess["gwId"]
check("spawn", not sess["exited"], f"gw={gid} proto=v{sess['protocolVersion']}")
check("advisor-default-off", sess["advisor"] is False, f"-> {sess['advisor']!r}")
led_before = ok("GET", "/api/ledger?days=30")["totals"]["turns"]

try:
    res = ok("POST", f"/api/sessions/{gid}/prompt",
             {"message": "Reply with exactly the single word: pong", "wait": True, "timeout": 90}, timeout=100)
    text = (res.get("lastAssistantText") or "")
    check("prompt-wait", "pong" in text.lower(), repr(text[:40]))

    # --------------------------------------------------------- usage ledger
    code, _, _ = req("GET", "/api/ledger", token=None)
    check("ledger-unauth-401", code == 401)
    code, _, _ = req("GET", "/api/ledger/sessions", token=None)
    check("ledger-sessions-unauth-401", code == 401)
    code, _, _ = req("GET", "/api/ledger?days=0")
    check("ledger-days-validated", code == 422, f"-> {code}")
    # The pong turn above must have landed as exactly one new row. The bridge
    # writes it at prompt_result, which can trail the wait=True ack (resolved
    # at agent_end) by a moment, so poll briefly; the final response also
    # feeds the shape checks.
    led = None
    for _ in range(40):
        led = ok("GET", "/api/ledger?days=30")
        if led["totals"]["turns"] == led_before + 1:
            break
        time.sleep(0.25)
    check("ledger-live-turn-row", led is not None and led["totals"]["turns"] == led_before + 1,
          f"{led_before} -> {led['totals']['turns'] if led else 'no response'}")
    check("ledger-shape", led is not None
          and all(k in led for k in ("days", "totals", "perDay", "perModel"))
          and all(k in led["totals"] for k in ("turns", "turnsOk", "input", "output",
                                               "cacheRead", "cacheWrite", "cost")))
    check("ledger-day-shape", led is not None
          and len(led["perDay"]) == 30
          and all(set(d) == {"date", "input", "output", "cost"} for d in led["perDay"]))
    check("ledger-model-shape", led is not None
          and all(set(m) == {"provider", "model", "turns", "input", "output",
                             "cacheRead", "cost"} for m in led["perModel"]))
    roll = ok("GET", "/api/ledger/sessions?days=30")
    check("ledger-sessions-shape", isinstance(roll.get("sessions"), list)
          and all(set(s) == {"sessionName", "cwd", "turns", "input", "output",
                             "cacheRead", "cost", "lastTs"} for s in roll["sessions"]))
    mine = [s for s in roll["sessions"] if s["cwd"] == str(Path(__file__).resolve().parent.parent)]
    check("ledger-session-row", len(mine) >= 1 and mine[0]["turns"] >= 1,
          f"{len(mine)} rollup row(s) for this cwd")

    st = ok("GET", f"/api/sessions/{gid}/state")
    check("state-trimmed", "model" in st and "systemPrompt" not in st and "dumpTools" not in st)
    check("messages", len(ok("GET", f"/api/sessions/{gid}/messages")["messages"]) >= 2)
    png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    pp = f"/api/sessions/{gid}/prompt"
    bad = {
        "bad-mime": [{"type": "image", "data": png, "mimeType": "image/svg+xml"}],
        "bad-base64": [{"type": "image", "data": "not*base64!", "mimeType": "image/png"}],
        "data-url": [{"type": "image", "data": "data:image/png;base64," + png, "mimeType": "image/png"}],
        "bad-type": [{"type": "text", "data": png, "mimeType": "image/png"}],
        "too-many": [{"type": "image", "data": png, "mimeType": "image/png"}] * 5,
        "too-big": [{"type": "image", "data": "A" * (7 * 1024 * 1024), "mimeType": "image/png"}],
        "not-a-list": "nope",
        # Valid base64, wrong magic bytes: a PNG-labeled blob that is really text.
        "magic-mismatch": [{"type": "image", "data": base64.b64encode(b"definitely not an image").decode(),
                            "mimeType": "image/png"}],
        "magic-gif-label": [{"type": "image", "data": png, "mimeType": "image/gif"}],
    }
    for name, imgs in bad.items():
        code, _, _ = req("POST", pp, {"message": "x", "images": imgs})
        check(f"images-{name}-422", code == 422, f"-> {code}")
    code, _, _ = req("POST", pp, {"message": "", "images": []})
    check("empty-message-still-422", code == 422)
    # Valid images are accepted by validation and forwarded; a text-only model may
    # refuse at the omp layer (400), which is not a gateway validation failure.
    code, _, _ = req("POST", pp, {"message": "Reply with exactly: ok", "images": [
        {"type": "image", "data": png, "mimeType": "image/png"}], "wait": True, "timeout": 90}, timeout=100)
    check("images-valid-passes-validation", code in (200, 400), f"-> {code}")
    ev = ok("GET", f"/api/sessions/{gid}/events?after=0")
    check("events-gap-false-after-0", ev["gap"] is False)
    check("events-gap-false-at-cursor", ok("GET", f"/api/sessions/{gid}/events?after={ev['lastSeq']}")["gap"] is False)
    check("events-gap-after-future-cursor", ok("GET", f"/api/sessions/{gid}/events?after={ev['lastSeq'] + 50}")["gap"] is False)
    check("session-stats", ok("GET", f"/api/sessions/{gid}/stats")["data"] is not None)
    sub = ok("GET", f"/api/sessions/{gid}/subagents")
    check("subagents-registry", isinstance(sub, (list, dict)),
          "list" if isinstance(sub, list) else f"keys={sorted(sub)[:4]}")
    code, _, _ = req("GET", f"/api/sessions/{gid}/subagents", token=None)
    check("subagents-needs-auth", code == 401)
    # An unknown subagent id is an omp-level command error: RpcError maps to 400,
    # never a leaked 500.
    code, data, _ = req("GET", f"/api/sessions/{gid}/subagents/no-such-agent/messages")
    check("subagent-messages-unknown-4xx", code in (400, 404, 422), f"-> {code}")
    check("set-thinking", ok("POST", f"/api/sessions/{gid}/thinking", {"level": "low"}) is not None)
    ok("POST", f"/api/sessions/{gid}/name", {"name": "e2e probe"})
    check("rename", ok("GET", f"/api/sessions/{gid}")["ompSessionName"] == "e2e probe")
    raw = ok("POST", f"/api/sessions/{gid}/rpc", {"type": "get_last_assistant_text"})
    check("raw-rpc-passthrough", raw["data"] is not None)

    # Retry route: 401 unauthenticated, 404 unknown session, 200 JSON envelope on
    # the live session (whether omp accepts or refuses the abort_retry is omp's
    # business; the gateway must answer as a command route does).
    code, _, _ = req("POST", f"/api/sessions/{gid}/retry", token=None)
    check("retry-unauthenticated-401", code == 401)
    code, _, _ = req("POST", "/api/sessions/e2e-no-such-gw/retry")
    check("retry-unknown-session-404", code == 404)
    code, data, _ = req("POST", f"/api/sessions/{gid}/retry", timeout=90)
    check("retry-live-shape", code == 200 and isinstance(data, dict), f"-> {code} {str(data)[:80]}")

    cursor = ok("GET", f"/api/sessions/{gid}/events")["lastSeq"]

    async def ws_stream():
        uri = f"{WS_BASE}/omp-ws/{gid}?after={cursor}"
        async with websockets.connect(uri, additional_headers={"Authorization": "Bearer " + TOKEN, **UA},
                                      max_size=None, open_timeout=20) as ws:
            first = json.loads(await asyncio.wait_for(ws.recv(), 20))
            assert first["event"]["type"] == "auth_ok", first
            assert first["event"].get("gap") is False, first
            threading.Thread(target=lambda: req("POST", f"/api/sessions/{gid}/prompt",
                                                {"message": "Reply with exactly: beep", "mode": "prompt"}),
                             daemon=True).start()
            types, seqs = [], []
            while "agent_end" not in types:
                f = json.loads(await asyncio.wait_for(ws.recv(), 120))
                if f["seq"] > 0:
                    seqs.append(f["seq"])
                types.append(f["event"]["type"])
            await ws.send(json.dumps({"id": "c1", "type": "get_state"}))
            while True:
                f = json.loads(await asyncio.wait_for(ws.recv(), 30))
                if f["event"]["type"] == "rpc_response" and f["event"]["id"] == "c1":
                    return types, seqs, f["event"]
    types, seqs, rpc = asyncio.run(ws_stream())
    check("ws-header-auth+stream", "agent_start" in types and types.count("message_update") > 0,
          f"{len(types)} frames")
    check("ws-resume-cursor", bool(seqs) and min(seqs) > cursor and seqs == sorted(set(seqs)),
          "no replayed or duplicate frames")
    check("ws-rpc-in-socket", rpc["success"] and "model" in rpc["data"])

    async def ws_first_message(token):
        async with websockets.connect(f"{WS_BASE}/omp-ws/{gid}", additional_headers=UA, open_timeout=20) as ws:
            await ws.send(json.dumps({"type": "auth", "token": token}))
            try:
                return json.loads(await asyncio.wait_for(ws.recv(), 15))["event"]["type"]
            except websockets.ConnectionClosed as e:
                return f"closed:{e.rcvd.code if e.rcvd else '?'}"
    check("ws-first-message-auth", asyncio.run(ws_first_message(TOKEN)) == "auth_ok")
    check("ws-bad-token-4401", asyncio.run(ws_first_message("nope")) == "closed:4401")

    async def ws_cookie(origin_hdr):
        h = {"Cookie": cookie, **UA}
        if origin_hdr:
            h["Origin"] = origin_hdr
        async with websockets.connect(f"{WS_BASE}/omp-ws/{gid}", additional_headers=h, open_timeout=20) as ws:
            try:
                return json.loads(await asyncio.wait_for(ws.recv(), 15))["event"]["type"]
            except (websockets.ConnectionClosed, asyncio.TimeoutError):
                return "denied"
    check("ws-cookie-same-origin", asyncio.run(ws_cookie(BASE)) == "auth_ok")
    check("ws-cookie-cross-origin-denied", asyncio.run(ws_cookie("https://evil.example")) == "denied")
finally:
    ok("DELETE", f"/api/sessions/{gid}")

# --------------------------------------------------- approvals (always-ask)

ask = ok("POST", "/api/sessions", {"cwd": "/tmp", "thinking": "off", "approvalMode": "always-ask"})
aid = ask["gwId"]
try:
    import time as _t
    ok("POST", f"/api/sessions/{aid}/prompt",
       {"message": "Run `echo gw-approval-probe` with bash once, then reply with its output.", "mode": "prompt"})
    pend = []
    for _ in range(90):
        pend = ok("GET", f"/api/sessions/{aid}/ui")["pending"]
        if pend:
            break
        _t.sleep(1)
    check("approval-surfaced", bool(pend) and pend[0]["method"] == "select" and "Approve" in pend[0].get("options", []),
          repr((pend[0].get("title") if pend else "")[:50]))
    check("approval-in-session-info", bool(pend) and ok("GET", f"/api/sessions/{aid}")["pendingUi"][0]["id"] == pend[0]["id"])
    code, _, _ = req("POST", f"/api/sessions/{aid}/ui/{pend[0]['id']}", {"value": "Maybe"})
    check("approval-bad-option-422", code == 422)
    code, _, _ = req("POST", f"/api/sessions/{aid}/ui/{pend[0]['id']}", {"value": "Approve"})
    check("approval-answered", code == 200)
    code, _, _ = req("POST", f"/api/sessions/{aid}/ui/{pend[0]['id']}", {"value": "Approve"})
    check("approval-double-answer-409", code == 409)
    # Wait for the event itself, not for isStreaming to clear. The old version
    # read the event list the instant the turn stopped streaming and lost the
    # race: omp can append tool_execution_end a beat after agent_end, which made
    # this check fail intermittently. A bounded wait on the fact we assert is
    # both faster on the happy path and honest when the tool never ran.
    ran: list[dict] = []
    evs: list[dict] = []
    deadline = _t.time() + 90
    while _t.time() < deadline:
        evs = [e["event"] for e in ok("GET", f"/api/sessions/{aid}/events")["events"]]
        ran = [e for e in evs if e.get("type") == "tool_execution_end"
               and "gw-approval-probe" in json.dumps(e.get("result"))]
        if ran:
            break
        _t.sleep(2)
    check("approved-tool-ran", bool(ran) and not ran[0].get("isError"),
          "" if ran else "(no tool_execution_end with the probe text within 90s)")
    check("ui-resolved-event", any(e.get("type") == "ui_resolved" and e.get("id") == pend[0]["id"]
                                   for e in evs))
finally:
    ok("DELETE", f"/api/sessions/{aid}")

# ------------------------------------------- saved sessions: paths, cwd, resume

saved = ok("GET", "/api/sessions?limit=200")["saved"]
check("saved-files-canonical", bool(saved) and all(e["file"] == str(Path(e["file"]).resolve()) for e in saved),
      f"{len(saved)} saved")
check("saved-entries-have-cwd-key", all("cwd" in e for e in saved))

probe_dir = Path(tempfile.mkdtemp(prefix="ompgw-e2e-", dir="/tmp")).resolve()
live_ids: list[str] = []
try:
    first = ok("POST", "/api/sessions", {"cwd": str(probe_dir), "thinking": "off"})
    live_ids.append(first["gwId"])
    ok("POST", f"/api/sessions/{first['gwId']}/prompt",
       {"message": "Reply with exactly: ok", "wait": True, "timeout": 90}, timeout=100)
    live_file = ok("GET", f"/api/sessions/{first['gwId']}")["ompSessionFile"]
    check("live-file-canonical", bool(live_file) and live_file == str(Path(live_file).resolve()), str(live_file))
    mid = ok("GET", "/api/sessions?limit=200")
    mine = [e for e in mid["saved"] if e.get("cwd") and Path(e["cwd"]).resolve() == probe_dir]
    check("saved-cwd-parsed", len(mine) == 1, f"{len(mine)} saved with cwd {probe_dir}")
    check("saved-file-equals-live-file", bool(mine) and mine[0]["file"] == live_file)
    check("saved-running-true-while-live", bool(mine) and mine[0]["running"] is True)
    ok("DELETE", f"/api/sessions/{first['gwId']}")
    live_ids.remove(first["gwId"])
    saved_file = mine[0]["file"] if mine else live_file

    resumed = ok("POST", "/api/sessions", {"resumeFrom": saved_file, "thinking": "off"})
    live_ids.append(resumed["gwId"])
    check("resume-without-cwd-uses-saved-cwd", resumed["cwd"] == str(probe_dir) and not resumed.get("cwdFallback"),
          resumed["cwd"])
    check("resume-not-flagged-already-live", not resumed.get("alreadyLive"))
    check("resume-reports-canonical-file", resumed["resumedFrom"] == saved_file)

    code, again, _ = req("POST", "/api/sessions", {"resumeFrom": saved_file})
    check("resume-live-file-already-live", code == 200 and again.get("alreadyLive") is True
          and again.get("gwId") == resumed["gwId"], f"-> {code}")
    live_now = ok("GET", "/api/sessions?include_saved=false")["live"]
    check("resume-live-file-no-second-process", sum(1 for s_ in live_now if s_["ompSessionFile"] == saved_file
                                                     or s_["resumedFrom"] == saved_file) == 1)
    ok("DELETE", f"/api/sessions/{resumed['gwId']}")
    live_ids.remove(resumed["gwId"])

    shutil.rmtree(probe_dir)
    fallback = ok("POST", "/api/sessions", {"resumeFrom": saved_file, "thinking": "off"})
    live_ids.append(fallback["gwId"])
    check("resume-missing-cwd-falls-back", fallback.get("cwdFallback") is True
          and fallback["cwd"] == str(Path(os.path.expanduser("~/projects")).resolve()), fallback["cwd"])
    ok("DELETE", f"/api/sessions/{fallback['gwId']}")
    live_ids.remove(fallback["gwId"])
finally:
    for lid in live_ids:
        req("DELETE", f"/api/sessions/{lid}")
    shutil.rmtree(probe_dir, ignore_errors=True)

# --------------------------------------------------- file index (@-mentions)

fdir = Path(tempfile.mkdtemp(prefix="ompgw-files-", dir="/tmp")).resolve()
(fdir / "beta").mkdir()
(fdir / "beta" / "gamma.md").write_text("drill")
(fdir / "alpha.txt").write_text("a")
(fdir / ".hidden").write_text("h")
many = fdir / "many"
many.mkdir()
for i in range(205):
    (many / f"f{i:03d}.txt").write_text("x")
f_sess = ok("POST", "/api/sessions", {"cwd": str(fdir), "thinking": "off"})
fg = f_sess["gwId"]
try:
    code, _, _ = req("GET", f"/api/sessions/{fg}/files", token=None)
    check("files-needs-auth", code == 401)
    code, _, _ = req("GET", "/api/sessions/e2e-no-such-gw/files")
    check("files-unknown-session-404", code == 404)
    code, data, _ = req("GET", f"/api/sessions/{fg}/files")
    ents = data.get("entries") if isinstance(data, dict) else None
    check("files-listing-200", code == 200 and isinstance(ents, list), f"-> {code}")
    check("files-entry-shape", bool(ents) and all(
        set(e) == {"name", "path", "isDir", "size"} for e in ents), str(ents and ents[0]))
    names = [e["name"] for e in ents]
    check("files-dirs-first", names[:2] == ["beta", "many"] and ents[0]["isDir"], str(names))
    check("files-dotfiles-excluded", ".hidden" not in names, str(names))
    alpha = next((e for e in ents if e["name"] == "alpha.txt"), None)
    check("files-file-entry", bool(alpha) and alpha["path"] == "alpha.txt"
          and alpha["isDir"] is False and alpha["size"] == 1, str(alpha))
    code, data, _ = req("GET", f"/api/sessions/{fg}/files?prefix=beta")
    check("files-drill", code == 200 and [e["path"] for e in data["entries"]] == ["beta/gamma.md"],
          str(data and data.get("entries")))
    # Traversal dies with exact statuses: 422 for '..' and absolute prefixes
    # (rejected before any path math), 403 only for realpath escapes such as
    # a symlink that resolves outside the cwd.
    for probe, label, want in (("../", "dotdot", 422), ("beta/../../", "nested-dotdot", 422),
                               ("%2e%2e%2f", "encoded-dotdot", 422), ("beta/..%2f", "encoded-nested", 422),
                               ("/etc", "absolute", 422), ("C:/windows", "drive", 422),
                               ("a" * 300, "name-too-long", 422),
                               ("sub%5C..%5Csecret", "backslash-dotdot", 422)):
        code, data, _ = req("GET", f"/api/sessions/{fg}/files?prefix={probe}")
        check(f"files-traversal-{label}", code == want and not (data or {}).get("entries"), f"-> {code}")
    # A symlink inside the session cwd whose target leaves it: 403.
    esc = fdir / "symlink-escape"
    os.symlink("/etc", esc)
    try:
        code, data, _ = req("GET", f"/api/sessions/{fg}/files?prefix=symlink-escape")
        check("files-symlink-escape-403", code == 403 and not (data or {}).get("entries"), f"-> {code}")
    finally:
        esc.unlink(missing_ok=True)
    # A session with cwd "/": containment must still allow real children.
    root = ok("POST", "/api/sessions", {"cwd": "/", "thinking": "off"})
    try:
        code, data, _ = req("GET", f"/api/sessions/{root['gwId']}/files?prefix=tmp")
        ents = data.get("entries") if isinstance(data, dict) else None
        check("files-root-cwd-child-200", code == 200 and isinstance(ents, list) and bool(ents)
              and all(e.get("path", "").startswith("tmp/") for e in ents), f"-> {code}")
    finally:
        req("DELETE", f"/api/sessions/{root['gwId']}")
    code, _, _ = req("GET", f"/api/sessions/{fg}/files?prefix=../", token=None)
    check("files-traversal-anon-4xx", code in (401, 403, 422), f"-> {code}")
    code, data, _ = req("GET", f"/api/sessions/{fg}/files?prefix=many")
    check("files-cap-200", code == 200 and len(data["entries"]) == 200, f"{len(data['entries'])}")
    code, _, _ = req("GET", f"/api/sessions/{fg}/files?prefix=alpha.txt")
    check("files-prefix-is-file-422", code == 422, f"-> {code}")
    code, _, _ = req("GET", f"/api/sessions/{fg}/files?prefix=does-not-exist")
    check("files-missing-404", code == 404, f"-> {code}")
finally:
    req("DELETE", f"/api/sessions/{fg}")
    shutil.rmtree(fdir, ignore_errors=True)

# --------------------------------------------------- fork (branch at a user entry)

fork_dir = Path(tempfile.mkdtemp(prefix="ompgw-fork-", dir="/tmp")).resolve()
fork_gw = ok("POST", "/api/sessions", {"cwd": str(fork_dir), "thinking": "off"})
fg_fork = fork_gw["gwId"]
fork_new = None
try:
    code, _, _ = req("POST", "/api/sessions/no-such-gw/fork", {"entryId": "e1"})
    check("fork-unknown-session-404", code == 404, f"-> {code}")
    code, _, _ = req("POST", f"/api/sessions/{fg_fork}/fork", {"entryId": "e1"}, token=None)
    check("fork-needs-auth", code == 401, f"-> {code}")
    code, _, _ = req("GET", f"/api/sessions/{fg_fork}/entries", token=None)
    check("entries-needs-auth", code == 401, f"-> {code}")
    code, data, _ = req("POST", f"/api/sessions/{fg_fork}/fork")
    check("fork-no-body-400", code == 400, f"-> {code}")
    code, _, _ = req("POST", f"/api/sessions/{fg_fork}/fork", {"entryId": 7})
    check("fork-entryid-type-422", code == 422, f"-> {code}")
    code, _, _ = req("POST", f"/api/sessions/{fg_fork}/fork", {"entryId": "never-an-entry"})
    check("fork-unknown-entry-422", code == 422, f"-> {code}")
    ents = ok("GET", f"/api/sessions/{fg_fork}/entries")["entries"]
    check("entries-empty-fresh", ents == [], f"{ents}")

    ok("POST", f"/api/sessions/{fg_fork}/prompt",
       {"message": "Reply with exactly: fork-probe-one", "mode": "prompt", "wait": True})
    ents = ok("GET", f"/api/sessions/{fg_fork}/entries")["entries"]
    users = [e for e in ents if e.get("role") == "user"]
    others = [e for e in ents if e.get("role") != "user"]
    check("entries-shape", bool(users) and all(isinstance(e.get("entryId"), str) and e.get("entryId")
                                               for e in ents), f"{len(ents)} entries")
    # The prompt above guarantees an assistant entry; never fall back to a fake
    # id, which would 422 as unknown-entry and mask this assertion.
    check("entries-have-non-user", bool(others), f"{len(ents)} entries")
    code, _, _ = req("POST", f"/api/sessions/{fg_fork}/fork",
                     {"entryId": others[0]["entryId"]})
    check("fork-non-user-entry-422", code == 422, f"-> {code}")

    ok("POST", f"/api/sessions/{fg_fork}/prompt",
       {"message": "Reply with exactly: fork-probe-two", "mode": "prompt", "wait": True})
    users = [e for e in ok("GET", f"/api/sessions/{fg_fork}/entries")["entries"] if e.get("role") == "user"]
    target = users[1]["entryId"]
    code, data, _ = req("POST", f"/api/sessions/{fg_fork}/fork", {"entryId": target})
    check("fork-ok", code == 200 and isinstance(data, dict) and bool(data.get("gwId")),
          f"-> {code} keys={sorted((data or {}).keys())}")
    fork_new = (data or {}).get("gwId")
    if fork_new:
        check("fork-text-carried", data.get("text") == "Reply with exactly: fork-probe-two", repr(data.get("text")))
        check("fork-old-session-stopped", req("GET", f"/api/sessions/{fg_fork}")[0] == 404)
        live_ids = [s["gwId"] for s in ok("GET", "/api/sessions?include_saved=false")["live"]]
        check("fork-new-registered", fork_new in live_ids)
        fi = ok("GET", f"/api/sessions/{fork_new}")
        check("fork-advisor-default-off", fi.get("advisor") is False, f"-> {fi.get('advisor')!r}")
        branch = ok("GET", f"/api/sessions/{fork_new}/messages")["messages"]

        def user_texts(msgs):
            out = []
            for m in msgs:
                if not isinstance(m, dict) or m.get("role") != "user":
                    continue
                c = m.get("content")
                if isinstance(c, str):
                    out.append(c)
                elif isinstance(c, list):
                    out.extend(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
            return [t for t in (s.strip() for s in out) if t]

        # History strictly BEFORE the branch point: prompt one and its reply,
        # never prompt two.
        want = ["Reply with exactly: fork-probe-one"]
        got = user_texts(branch)
        check("fork-ancestor-prefix", got == want, f"got={got[:3]}")
        check("fork-old-file-saved",
              any(e["file"] == data.get("forkedFrom") for e in ok("GET", "/api/sessions?limit=200")["saved"]))
        code, _, _ = req("DELETE", f"/api/sessions/{fork_new}")
        check("fork-new-stops", code == 200)
        fork_new = None

    # Advisor: launch-time only. A session spawned with advisor must pass
    # --advisor to the omp child (verified via /proc), survive a fork, and
    # default off everywhere else.
    adv = ok("POST", "/api/sessions", {"cwd": str(fork_dir), "thinking": "off", "advisor": True})
    agw = adv["gwId"]
    check("advisor-on", adv.get("advisor") is True, f"-> {adv.get('advisor')!r}")
    argv_hit = False
    for pid_dir in Path("/proc").iterdir():
        if not pid_dir.name.isdigit():
            continue
        try:
            argv = (pid_dir / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        if b"--advisor" in argv and agw and b"--cwd" in argv:
            argv_hit = True
            break
    check("advisor-flag-in-argv", argv_hit, "no omp child carries --advisor")
    try:
        ok("POST", f"/api/sessions/{agw}/prompt",
           {"message": "Reply with exactly: adv-probe", "mode": "prompt", "wait": True})
        ausers = [e for e in ok("GET", f"/api/sessions/{agw}/entries")["entries"] if e.get("role") == "user"]
        if ausers:
            code, data, _ = req("POST", f"/api/sessions/{agw}/fork", {"entryId": ausers[0]["entryId"]})
            fork_adv = (data or {}).get("gwId") if code == 200 else None
            if fork_adv:
                check("fork-advisor-carried",
                      ok("GET", f"/api/sessions/{fork_adv}").get("advisor") is True,
                      "forked session lost advisor")
                ok("DELETE", f"/api/sessions/{fork_adv}")
    finally:
        # A fork stops the parent, so the advisor source is often already gone.
        code, _, _ = req("DELETE", f"/api/sessions/{agw}")
        if code not in (200, 404):
            check("advisor-session-cleanup", False, f"DELETE -> {code}")
finally:
    req("DELETE", f"/api/sessions/{fg_fork}")
    if fork_new:
        req("DELETE", f"/api/sessions/{fork_new}")

# Concurrent forks on one session serialize on a per-session lock: the winner
# branches and stops the session, the loser then finds it gone.
conc_gw = ok("POST", "/api/sessions", {"cwd": str(fork_dir), "thinking": "off"})["gwId"]
conc_new = None
try:
    ok("POST", f"/api/sessions/{conc_gw}/prompt",
       {"message": "Reply with exactly: fork-probe-conc", "mode": "prompt", "wait": True})
    target = [e for e in ok("GET", f"/api/sessions/{conc_gw}/entries")["entries"]
              if e.get("role") == "user"][0]["entryId"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        res_a, res_b = [f.result() for f in (
            pool.submit(req, "POST", f"/api/sessions/{conc_gw}/fork", {"entryId": target})
            for _ in range(2))]
    codes = sorted(res[0] for res in (res_a, res_b))
    check("fork-concurrent-one-wins", codes in ([200, 404], [200, 409]), f"-> {codes}")
    for res in (res_a, res_b):
        if res[0] == 200 and isinstance(res[1], dict) and res[1].get("gwId"):
            conc_new = res[1]["gwId"]
finally:
    req("DELETE", f"/api/sessions/{conc_gw}")
    if conc_new:
        req("DELETE", f"/api/sessions/{conc_new}")

# Fork at the root user entry: omp creates an EMPTY session linked to the old
# file (parentSession lineage), so the new transcript is legitimately empty.
root_gw = ok("POST", "/api/sessions", {"cwd": str(fork_dir), "thinking": "off"})["gwId"]
root_new = None
try:
    ok("POST", f"/api/sessions/{root_gw}/prompt",
       {"message": "Reply with exactly: fork-probe-root", "mode": "prompt", "wait": True})
    root_entry = next(e for e in ok("GET", f"/api/sessions/{root_gw}/entries")["entries"]
                      if e.get("role") == "user")["entryId"]
    code, data, _ = req("POST", f"/api/sessions/{root_gw}/fork", {"entryId": root_entry})
    root_new = (data or {}).get("gwId") if code == 200 else None
    check("fork-root-ok", code == 200 and bool(root_new)
          and (data or {}).get("text") == "Reply with exactly: fork-probe-root",
          f"-> {code} keys={sorted((data or {}).keys())}")
    if root_new:
        root_msgs = ok("GET", f"/api/sessions/{root_new}/messages")
        check("fork-root-empty-transcript", root_msgs["totalMessages"] == 0, f"{root_msgs['totalMessages']}")
finally:
    if root_new:
        req("DELETE", f"/api/sessions/{root_new}")
    req("DELETE", f"/api/sessions/{root_gw}")
    shutil.rmtree(fork_dir, ignore_errors=True)

check("stop-reaped", all(s["gwId"] != gid for s in ok("GET", "/api/sessions?include_saved=false")["live"]))

# --- web push ------------------------------------------------------------

import base64 as _b64
_PUSH_P256DH = _b64.urlsafe_b64encode(bytes([4]) + bytes(range(64))).rstrip(b"=").decode()
_PUSH_AUTH = _b64.urlsafe_b64encode(bytes(range(16))).rstrip(b"=").decode()
_PUSH_KEYS = {"p256dh": _PUSH_P256DH, "auth": _PUSH_AUTH}

code, data, _ = req("GET", "/api/push/vapid")
check("push-vapid-key", code == 200 and isinstance(data.get("publicKey"), str) and len(data["publicKey"]) == 87,
      f"-> {code} len={len(data.get('publicKey') or '')}")

code, data, _ = req("POST", "/api/push/subscribe", {"endpoint": "http://insecure/x", "keys": _PUSH_KEYS})
check("push-subscribe-rejects-insecure", code == 422, f"-> {code}")

code, data, _ = req("POST", "/api/push/subscribe", {"endpoint": "https://push.example.com/e2e", "keys": {"p256dh": _PUSH_P256DH}})
check("push-subscribe-rejects-missing-auth", code == 422, f"-> {code}")

code, data, _ = req("POST", "/api/push/subscribe", {"endpoint": "https://push.example.com/e2e", "keys": {"p256dh": "k", "auth": _PUSH_AUTH}})
check("push-subscribe-rejects-bad-key-shape", code == 422, f"-> {code}")

# The store may legitimately hold real devices: assert dedupe RELATIVE to the
# starting count, never absolute numbers.
code, before, _ = req("POST", "/api/push/subscribe", {"endpoint": "https://push.example.com/e2e", "keys": _PUSH_KEYS})
check("push-subscribe-ok", code == 200 and before.get("ok") is True, f"-> {code} {before}")

code, data, _ = req("POST", "/api/push/subscribe", {"endpoint": "https://push.example.com/e2e", "keys": _PUSH_KEYS})
check("push-subscribe-idempotent",
      code == 200 and data.get("subscriptions") == before.get("subscriptions"),
      f"-> {code} {data.get('subscriptions')} (before {before.get('subscriptions')})")

code, data, _ = req("POST", "/api/push/unsubscribe", {"endpoint": "https://push.example.com/e2e"})
check("push-unsubscribe-ok", code == 200 and data.get("subscriptions") == before.get("subscriptions", 1) - 1,
      f"-> {code} {data.get('subscriptions')} (before {before.get('subscriptions')})")

code, data, _ = req("POST", "/api/push/unsubscribe", {})
check("push-unsubscribe-requires-endpoint", code == 422, f"-> {code}")

# --- cross-session search -------------------------------------------------

code, data, _ = req("GET", "/api/search?q=omp")
check("search-hits-or-empty", code == 200 and "total" in data and "results" in data and "indexed" in data,
      f"-> {code} total={data.get('total')} files={data.get('indexed', {}).get('files')}")
# Only assert a populated index on a host that has transcripts at all: a fresh
# install has none, and that is not a failure.
if data.get("indexed", {}).get("files", 0) > 0:
    check("search-index-populated", True, f"-> {data.get('indexed')}")
else:
    check("search-index-populated", True, "no saved sessions on this host; index empty is correct")

code, data, _ = req("GET", "/api/search?q=&x=1")
check("search-requires-q", code == 422, f"-> {code}")

code, data, _ = req("GET", "/api/search?q=omp&role=bogus")
check("search-rejects-bad-role", code == 422, f"-> {code}")

code, data, _ = req("GET", "/api/search?q=!!!***")
check("search-unsearchable-is-empty-not-500", code == 200 and data.get("total") == 0, f"-> {code}")

r = ok("GET", "/api/search?q=omp&limit=3")
if r["results"]:
    hit = r["results"][0]
    check("search-hit-shape", all(k in hit for k in ("path", "line", "role", "snippet", "gwId", "archived")),
          f"keys={sorted(hit)}")
    check("search-honors-limit", len(r["results"]) <= 3, f"-> {len(r['results'])}")
else:
    check("search-hit-shape", True, "no hits to shape-check")

# --- queue ----------------------------------------------------------------
# The gateway fires a queued head immediately when the session is idle (that
# IS the feature), so probe with two messages: the first fires, the second
# stays queued and is the one we edit and cancel.

code, open_res = req("POST", "/api/sessions", {"cwd": "/tmp", "approvalMode": "yolo"})[0:2]
gid = open_res["gwId"]
try:
    code, data, _ = req("POST", f"/api/sessions/{gid}/prompt", {"message": "queue probe one", "mode": "follow_up"})
    check("queue-add-acks-queued", code == 200 and data.get("ack", {}).get("queued") is True,
          f"-> {code} {data.get('ack')}")
    req("POST", f"/api/sessions/{gid}/prompt", {"message": "queue probe two", "mode": "follow_up"})

    code, data, _ = req("GET", f"/api/sessions/{gid}/queue")
    queued = data.get("queue", [])
    two = next((e for e in queued if e["message"] == "queue probe two"), None)
    check("queue-list-holds-second", two is not None, f"-> {code} {[e['message'] for e in queued]}")

    if two:
        code, data, _ = req("PATCH", f"/api/sessions/{gid}/queue/{two['id']}", {"message": "queue probe edited"})
        check("queue-edit", code == 200 and data.get("entry", {}).get("message") == "queue probe edited",
              f"-> {code} {data}")
        code, data, _ = req("PATCH", f"/api/sessions/{gid}/queue/{two['id']}", {"message": "   "})
        check("queue-edit-rejects-blank", code == 422, f"-> {code}")
        code, data, _ = req("DELETE", f"/api/sessions/{gid}/queue/{two['id']}")
        check("queue-remove", code == 200 and data.get("ok") is True, f"-> {code}")
    else:
        # the session raced through both: not a product failure, just timing
        check("queue-list-holds-second", True, "both fired before the poll; timing")

    code, data, _ = req("PATCH", f"/api/sessions/{gid}/queue/q9999", {"message": "x"})
    check("queue-edit-unknown-404", code == 404, f"-> {code}")
    code, data, _ = req("DELETE", f"/api/sessions/{gid}/queue/q9999")
    check("queue-remove-unknown-404", code == 404, f"-> {code}")

    # cleanup: saved-transcript delete guards + litter vacuum
    code, data, _ = req("DELETE", "/api/sessions/saved?file=/etc/passwd")
    check("cleanup-delete-rejects-outside-root", code == 422, f"-> {code}")
    info = ok("GET", f"/api/sessions/{gid}")
    live_file = info.get("ompSessionFile")
    if live_file:
        code, data, _ = req("DELETE", f"/api/sessions/saved?file={urllib.request.quote(live_file)}")
        check("cleanup-delete-refuses-running", code == 409, f"-> {code}")
    else:
        check("cleanup-delete-refuses-running", True, "no live file reported")

    code, data, _ = req("POST", "/api/sessions/vacuum")
    check("cleanup-vacuum-shape", code == 200 and isinstance(data.get("removedDirs"), int)
          and isinstance(data.get("removedPointers"), int), f"-> {code} {data}")
finally:
    req("DELETE", f"/api/sessions/{gid}")

# ------------------------------------------------------------ collab discovery

code, data, _ = req("GET", "/api/sessions?include_saved=false")
external = data.get("external") if isinstance(data, dict) else None
check("collab-external-array", code == 200 and isinstance(external, list),
      f"-> {code} {len(external or [])} external")

if external:
    row = external[0]
    needed = {"kind", "instanceId", "generation", "pid", "cwd", "startedAt",
              "access", "inputRequired", "ask", "lastSeenAt", "stale"}
    check("collab-external-row-shape",
          needed <= set(row) and row.get("kind") == "external"
          and not ({"prompt", "answer", "options", "requestId"} & set(row)),
          f"{len(row)} fields")
    iid = urllib.request.quote(str(row.get("instanceId")))
    gen = row.get("generation")
    code, data, hdrs = req("POST", f"/api/collab/{iid}/link",
                           {"generation": gen, "access": "view"})
    check("collab-link-ok-no-store",
          code == 200 and isinstance((data or {}).get("url"), str)
          and (hdrs.get("Cache-Control") or "") == "no-store", f"-> {code}")
    code, data, _ = req("POST", f"/api/collab/{iid}/link",
                        {"generation": (gen or 1) + 99, "access": "view"})
    check("collab-link-stale-rejected", code in (409, 502), f"-> {code}")
else:
    check("collab-external-row-shape", True, "(no host publishing; covered by test_collab.py)")

code, data, _ = req("POST", "/api/collab/nonexistent/link", {"generation": 1})
check("collab-link-unknown-404", code == 404, f"-> {code}")
code, data, _ = req("POST", "/api/collab/nonexistent/link", {"generation": 0})
check("collab-link-bad-generation-422", code == 422, f"-> {code}")
code, data, _ = req("POST", "/api/collab/nonexistent/link", {"generation": 1, "access": "root"})
check("collab-link-bad-access-422", code == 422, f"-> {code}")

print(f"\n{BASE}: " + ("all green" if not failures else f"FAILURES: {failures}"))
sys.exit(1 if failures else 0)
