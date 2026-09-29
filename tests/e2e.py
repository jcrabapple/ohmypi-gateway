"""End-to-end test of the ohmypi-gateway against a live omp child."""
import json
import sys
import urllib.request

BASE = "http://127.0.0.1:9315"
TOKEN = open("/home/jason/projects/ohmypi-gateway/auth-token").read().strip()


def call(method, path, body=None, timeout=120):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
        return json.loads(r.read())


failures = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name} {detail}")
    if not cond:
        failures.append(name)


# 1. system
sysinfo = call("GET", "/api/system")
check("system", sysinfo["omp"]["version"] not in ("", "unknown"), f"omp {sysinfo['omp']['version']}")

# 2. spawn session
sess = call("POST", "/api/sessions", {"cwd": "/home/jason/projects/ohmypi-gateway"})
gid = sess["gwId"]
check("spawn", not sess["exited"], f"gwId={gid} ompSession={sess['ompSessionId']}")

# 3. prompt with wait
res = call("POST", f"/api/sessions/{gid}/prompt",
           {"message": "Reply with exactly the single word: pong", "wait": True, "timeout": 240},
           timeout=260)
text = (res.get("lastAssistantText") or "").strip().lower()
check("prompt-wait", "pong" in text, f"reply={text[:80]!r}")

# 4. state
state = call("GET", f"/api/sessions/{gid}/state")
check("state", "model" in state and "thinkingLevel" in state,
      f"model={state.get('model', {}).get('id') if isinstance(state.get('model'), dict) else state.get('model')} ctx={state.get('contextUsage', {}).get('percent') if state.get('contextUsage') else '?'}")

# 5. messages
msgs = call("GET", f"/api/sessions/{gid}/messages")
check("messages", len(msgs.get("messages", [])) >= 2, f"count={msgs.get('totalMessages')}")

# 6. events backlog
evs = call("GET", f"/api/sessions/{gid}/events?after=0")
check("events", evs["lastSeq"] > 0 and len(evs["events"]) > 0, f"lastSeq={evs['lastSeq']}")

# 7. set thinking level
r = call("POST", f"/api/sessions/{gid}/thinking", {"level": "low"})
check("set-thinking", r["data"] is not None or r.get("ok", True))

# 8. config read
cfg = call("GET", "/api/config")
check("config-read", "modelRoles" in json.dumps(cfg.get("parsed", {})), f"keys={sorted((cfg.get('parsed') or {}).keys())[:4]}...")

# 9. config write-back (identical content, raw body)
req = urllib.request.Request(BASE + "/api/config", method="PUT", data=cfg["raw"].encode())
req.add_header("Authorization", "Bearer " + TOKEN)
req.add_header("Content-Type", "text/plain")
with urllib.request.urlopen(req, timeout=90) as r:
    res = json.loads(r.read())
check("config-write", res.get("ok") is True, f"backup={res.get('backup')}")

# 10. skills
skills = call("GET", "/api/skills")
names = [s["name"] for s in skills["installed"]]
check("skills", len(names) >= 10, f"{len(names)} skills: {names[:6]}...")

# 11. saved sessions scan
sessions = call("GET", "/api/sessions")
check("saved-scan", len(sessions["saved"]) > 0, f"{len(sessions['saved'])} saved")

# 12. websocket stream
try:
    import asyncio
    import websockets

    async def ws_test():
        uri = f"ws://127.0.0.1:9315/omp-ws/{gid}?token={TOKEN}"
        async with websockets.connect(uri, max_size=None) as ws:
            # backlog arrives first
            got = []
            # then trigger a turn and watch live events
            import threading

            def fire():
                call("POST", f"/api/sessions/{gid}/prompt",
                     {"message": "Reply with exactly: beep", "wait": True, "timeout": 240}, timeout=260)
            t = threading.Thread(target=fire, daemon=True)
            t.start()
            # Wait for TWO agent_end frames (one replayed from the prior turn's
            # backlog, one from the live turn) so we don't bail early.
            ends = 0
            try:
                while ends < 2 and len(got) < 200:
                    frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=240))
                    got.append(frame["event"])
                    if frame["event"].get("type") == "agent_end":
                        ends += 1
            except asyncio.TimeoutError:
                pass
            types = [e.get("type") for e in got]
            return types, ends
    types, ends = asyncio.run(ws_test())
    check("ws-stream", ends >= 2 and "message_update" in types,
          f"live agent_end={ends}, message_updates={types.count('message_update')}")
except ImportError as e:
    print("[SKIP] ws-stream (websockets missing):", e)
except Exception as e:
    print("[FAIL] ws-stream:", e)
    failures.append("ws-stream")

# 13. stop session
r = call("DELETE", f"/api/sessions/{gid}")
after = call("GET", "/api/sessions")
still = [s for s in after["live"] if s["gwId"] == gid]
check("stop-session", len(still) == 0, "reaped")

print()
print("FAILURES:", failures if failures else "none — all green")
sys.exit(1 if failures else 0)
