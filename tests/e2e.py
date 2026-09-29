"""Gateway e2e suite. Usage: e2e.py [BASE_URL]   (default http://127.0.0.1:9315)

Covers auth (bearer, cookie login, CSRF, WS auth paths), the session
lifecycle against a live omp child, streaming over WebSocket with cursor
resume, and the config round trip. Leaves no sessions running.
"""
import asyncio
import json
import sys
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

check("stop-reaped", all(s["gwId"] != gid for s in ok("GET", "/api/sessions?include_saved=false")["live"]))

print(f"\n{BASE}: " + ("all green" if not failures else f"FAILURES: {failures}"))
sys.exit(1 if failures else 0)
