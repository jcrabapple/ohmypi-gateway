"""Gateway e2e suite. Usage: e2e.py [BASE_URL]   (default http://127.0.0.1:9315)

Covers auth (bearer, cookie login, CSRF, WS auth paths), the session
lifecycle against a live omp child, streaming over WebSocket with cursor
resume, and the config round trip. Leaves no sessions running.
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
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
for probe in ("/assets/../auth-token", "/..%2fauth-token", "/%2e%2e/auth-token", "/assets/%2e%2e/auth-token",
              "/assets/..%2f..%2fauth-token", "/static/../auth-token", "/does-not-exist.js"):
    for tok in (None, TOKEN):
        code, _, hdrs = req("GET", probe, token=tok)
        leaked = code == 200 and "text/html" not in (hdrs.get("Content-Type") or "")
        check(f"traversal-{probe}-{'auth' if tok else 'anon'}", code in (401, 404) and not leaked, f"-> {code}")
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
        check("sw-no-cache", code == 200 and hdrs.get("Cache-Control") == "no-cache")
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
gid = sess["gwId"]
check("spawn", not sess["exited"], f"gw={gid} proto=v{sess['protocolVersion']}")

try:
    res = ok("POST", f"/api/sessions/{gid}/prompt",
             {"message": "Reply with exactly the single word: pong", "wait": True, "timeout": 90}, timeout=100)
    text = (res.get("lastAssistantText") or "")
    check("prompt-wait", "pong" in text.lower(), repr(text[:40]))

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
    check("set-thinking", ok("POST", f"/api/sessions/{gid}/thinking", {"level": "low"}) is not None)
    ok("POST", f"/api/sessions/{gid}/name", {"name": "e2e probe"})
    check("rename", ok("GET", f"/api/sessions/{gid}")["ompSessionName"] == "e2e probe")
    raw = ok("POST", f"/api/sessions/{gid}/rpc", {"type": "get_last_assistant_text"})
    check("raw-rpc-passthrough", raw["data"] is not None)
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
    for _ in range(90):
        if not ok("GET", f"/api/sessions/{aid}")["isStreaming"]:
            break
        _t.sleep(1)
    evs = [e["event"] for e in ok("GET", f"/api/sessions/{aid}/events")["events"]]
    ran = [e for e in evs if e.get("type") == "tool_execution_end" and "gw-approval-probe" in json.dumps(e.get("result"))]
    check("approved-tool-ran", bool(ran) and not ran[0].get("isError"))
    check("ui-resolved-event", any(e.get("type") == "ui_resolved" and e.get("id") == pend[0]["id"] for e in evs))
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

check("stop-reaped", all(s["gwId"] != gid for s in ok("GET", "/api/sessions?include_saved=false")["live"]))

print(f"\n{BASE}: " + ("all green" if not failures else f"FAILURES: {failures}"))
sys.exit(1 if failures else 0)
