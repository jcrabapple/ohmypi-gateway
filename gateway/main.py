"""ohmypi-gateway: HTTP/WebSocket gateway over the omp (oh-my-pi) RPC protocol.

Auth: bearer token, generated on first run at <project>/auth-token.
Everything under /api requires it; the dashboard page is served open and
prompts for the token in the browser.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import subprocess
import time
from pathlib import Path

import yaml
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from .bridge import (
    DEFAULT_APPROVAL_MODE,
    OMP_AGENT_DIR,
    OMP_BIN,
    ProcessDead,
    RpcError,
    get_manager,
    scan_saved_sessions,
)

PROJECT_DIR = Path(__file__).resolve().parent.parent
TOKEN_FILE = PROJECT_DIR / "auth-token"
STATIC_DIR = PROJECT_DIR / "static"
CONFIG_FILE = OMP_AGENT_DIR / "config.yml"
STARTED_AT = time.time()

app = FastAPI(title="ohmypi-gateway", version="0.1.0", docs_url="/api/docs")


def auth_token() -> str:
    if not TOKEN_FILE.exists():
        TOKEN_FILE.write_text(secrets.token_urlsafe(32) + "\n")
        os.chmod(TOKEN_FILE, 0o600)
    return TOKEN_FILE.read_text().strip()


TOKEN = auth_token()


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path.startswith("/api") or request.url.path.startswith("/omp-ws"):
        supplied = (request.headers.get("authorization", "").removeprefix("Bearer ").strip()
                    or request.headers.get("x-api-key", "").strip()
                    or request.query_params.get("token", "").strip())
        if supplied != TOKEN:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)


def cli(*args: str, timeout: float = 60) -> str:
    """Run an omp CLI subcommand and return stdout text."""
    env = dict(os.environ)
    env.setdefault("PATH", os.path.expanduser("~/.bun/bin:") + env.get("PATH", ""))
    try:
        r = subprocess.run([OMP_BIN, *args], capture_output=True, text=True,
                           timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, f"omp {' '.join(args)} timed out")
    if r.returncode != 0:
        raise HTTPException(502, (r.stderr or r.stdout or "omp failed").strip()[:2000])
    return r.stdout


def get_session_or_404(gw_id: str):
    try:
        return get_manager().get(gw_id)
    except KeyError:
        raise HTTPException(404, f"no live session {gw_id}")


@app.exception_handler(RpcError)
async def rpc_error_handler(request: Request, exc: RpcError):
    return JSONResponse({"error": str(exc)}, status_code=400)


@app.exception_handler(ProcessDead)
async def process_dead_handler(request: Request, exc: ProcessDead):
    return JSONResponse({"error": str(exc)}, status_code=409)


# --------------------------------------------------------------------- system

@app.get("/api/health")
async def health():
    m = get_manager()
    return {"ok": True, "version": app.version, "uptimeSec": round(time.time() - STARTED_AT, 1),
            "liveSessions": len(m.sessions)}


@app.get("/api/system")
async def system():
    m = get_manager()
    omp_version = "unknown"
    try:
        omp_version = cli("--version", timeout=15).strip().removeprefix("omp v").removeprefix("omp")
    except HTTPException:
        pass
    return {
        "gateway": {"version": app.version, "uptimeSec": round(time.time() - STARTED_AT, 1),
                    "projectDir": str(PROJECT_DIR)},
        "omp": {"binary": OMP_BIN, "version": omp_version, "agentDir": str(OMP_AGENT_DIR),
                "configFile": str(CONFIG_FILE)},
        "liveSessions": len(m.sessions),
    }


# --------------------------------------------------------------------- config

@app.get("/api/config")
async def get_config():
    if not CONFIG_FILE.exists():
        raise HTTPException(404, f"{CONFIG_FILE} not found")
    raw = CONFIG_FILE.read_text()
    parsed = None
    try:
        parsed = yaml.safe_load(raw)
    except yaml.YAMLError as e:
        return {"raw": raw, "parseError": str(e)}
    return {"raw": raw, "parsed": parsed, "file": str(CONFIG_FILE)}


@app.put("/api/config")
async def put_config(request: Request):
    body = await request.body()
    text = body.decode("utf-8")
    try:
        parsed = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise HTTPException(400, f"invalid YAML: {e}")
    backup = CONFIG_FILE.with_suffix(".yml.bak-gateway")
    backup.write_text(CONFIG_FILE.read_text())
    CONFIG_FILE.write_text(text)
    # Validate the new config actually loads.
    try:
        cli("config", "get", "modelRoles", timeout=30)
    except HTTPException as e:
        CONFIG_FILE.write_text(backup.read_text())
        raise HTTPException(400, f"omp rejected the config, reverted: {e.detail}")
    return {"ok": True, "backup": str(backup), "keys": sorted((parsed or {}).keys())}


# --------------------------------------------------------------------- models

@app.get("/api/models")
async def models(q: str | None = None):
    args = ["models"] + ([q] if q else [])
    out = cli(*args, timeout=90)
    return {"raw": out[-20000:]}


# ------------------------------------------------------------------ skills etc

@app.get("/api/skills")
async def skills():
    skills_dir = OMP_AGENT_DIR / "skills"
    installed = []
    if skills_dir.is_dir():
        for p in sorted(skills_dir.iterdir()):
            if not p.is_dir():
                continue
            for cand in (p / "SKILL.md", p / "skill.md"):
                if cand.exists():
                    desc = ""
                    in_front = False
                    for line in cand.read_text(errors="replace").splitlines()[:20]:
                        if line.strip() == "---":
                            in_front = not in_front
                            continue
                        if in_front and line.lower().startswith("description:"):
                            desc = line.split(":", 1)[1].strip()
                            break
                    installed.append({"name": p.name, "path": str(p), "description": desc})
                    break
    return {"installed": installed, "dir": str(skills_dir)}


@app.get("/api/plugins")
async def plugins():
    try:
        return {"raw": cli("plugin", "list", timeout=60)[-20000:]}
    except HTTPException as e:
        return {"raw": "", "error": e.detail}


@app.get("/api/usage")
async def usage():
    try:
        return {"raw": cli("usage", timeout=90)[-20000:]}
    except HTTPException as e:
        return {"raw": "", "error": e.detail}


@app.get("/api/agents")
async def agents():
    try:
        return {"raw": cli("agents", timeout=30)[-20000:]}
    except HTTPException as e:
        return {"raw": "", "error": e.detail}


# ------------------------------------------------------------------- sessions

@app.get("/api/sessions")
async def list_sessions(include_saved: bool = True, limit: int = 100):
    await get_manager().reap_dead()
    live = get_manager().list_live()
    saved = scan_saved_sessions(limit=limit) if include_saved else []
    return {"live": live, "saved": saved}


@app.post("/api/sessions")
async def create_session(request: Request):
    body = await request.json()
    cwd = body.get("cwd") or os.getcwd()
    model = body.get("model")
    thinking = body.get("thinking")
    approval_mode = body.get("approvalMode", DEFAULT_APPROVAL_MODE)
    if approval_mode not in ("always-ask", "write", "yolo"):
        raise HTTPException(422, "approvalMode must be always-ask|write|yolo")
    if thinking and thinking not in ("off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"):
        raise HTTPException(422, "invalid thinking level")
    sess = await get_manager().create(cwd=cwd, model=model, thinking=thinking,
                                      approval_mode=approval_mode,
                                      session_file=body.get("resumeFrom"))
    return sess.info()


@app.get("/api/sessions/{gw_id}")
async def session_info(gw_id: str):
    sess = get_session_or_404(gw_id)
    with_timeout = None
    try:
        await sess.get_state()
    except (RpcError, ProcessDead):
        pass
    return sess.info()


@app.delete("/api/sessions/{gw_id}")
async def stop_session(gw_id: str):
    get_session_or_404(gw_id)
    return await get_manager().stop(gw_id)


@app.post("/api/sessions/{gw_id}/prompt")
async def prompt(gw_id: str, request: Request):
    sess = get_session_or_404(gw_id)
    body = await request.json()
    message = body.get("message")
    if not message:
        raise HTTPException(422, "message required")
    wait = bool(body.get("wait"))
    steer = bool(body.get("steer"))
    data = await sess.prompt(message, wait=wait, steer=steer,
                             timeout=float(body.get("timeout", 600)))
    out = sess.info()
    out["ack"] = data
    if wait:
        out["lastAssistantText"] = await sess.last_assistant_text()
    return out


@app.post("/api/sessions/{gw_id}/abort")
async def abort(gw_id: str):
    return {"data": await get_session_or_404(gw_id).command("abort", timeout=15)}


@app.post("/api/sessions/{gw_id}/compact")
async def compact(gw_id: str, request: Request = None):
    body = await request.json() if request else {}
    kw = {}
    if body.get("instructions"):
        kw["customInstructions"] = body["instructions"]
    return {"data": await get_session_or_404(gw_id).command("compact", timeout=300, **kw)}


@app.get("/api/sessions/{gw_id}/state")
async def state(gw_id: str):
    return await get_session_or_404(gw_id).get_state()


@app.get("/api/sessions/{gw_id}/messages")
async def messages(gw_id: str):
    return await get_session_or_404(gw_id).messages()


@app.post("/api/sessions/{gw_id}/model")
async def set_model(gw_id: str, request: Request):
    body = await request.json()
    provider, model_id = body.get("provider"), body.get("modelId")
    if not provider or not model_id:
        raise HTTPException(422, "provider and modelId required")
    return {"data": await get_session_or_404(gw_id).command(
        "set_model", provider=provider, modelId=model_id, timeout=30)}


@app.post("/api/sessions/{gw_id}/thinking")
async def set_thinking(gw_id: str, request: Request):
    body = await request.json()
    level = body.get("level")
    if level not in ("off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"):
        raise HTTPException(422, "invalid thinking level")
    return {"data": await get_session_or_404(gw_id).command(
        "set_thinking_level", level=level, timeout=15)}


@app.get("/api/sessions/{gw_id}/models")
async def available_models(gw_id: str):
    return {"data": await get_session_or_404(gw_id).command("get_available_models", timeout=60)}


@app.get("/api/sessions/{gw_id}/events")
async def events(gw_id: str, after: int = 0):
    sess = get_session_or_404(gw_id)
    items = sess.backlog_since(after)
    return {"events": [{"seq": s, "event": e} for s, e in items], "lastSeq": sess._backlog_seq}


# ----------------------------------------------------------------- websocket

@app.websocket("/omp-ws/{gw_id}")
async def ws_session(ws: WebSocket, gw_id: str, token: str = Query("")):
    if token != TOKEN:
        await ws.close(code=4401)
        return
    try:
        sess = get_manager().get(gw_id)
    except KeyError:
        await ws.close(code=4404)
        return
    await ws.accept()
    q = sess.subscribe()
    last_sent = 0
    try:
        # backlog first
        for seq, event in sess.backlog_since(0):
            await ws.send_json({"seq": seq, "event": event})
            last_sent = seq
        while True:
            recv = asyncio.create_task(ws.receive_text())
            pub = asyncio.create_task(q.get())
            done, pending = await asyncio.wait({recv, pub}, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            if recv in done:
                msg = recv.result()
                if msg in ("ping", ""):
                    await ws.send_json({"seq": last_sent, "event": {"type": "pong"}})
                else:
                    # client may push commands as raw RPC frames
                    try:
                        frame = json.loads(msg)
                        sess._next_id += 1
                        rid = f"ws-{sess._next_id}"
                        await sess.send_raw({"id": rid, **frame})
                    except json.JSONDecodeError:
                        await ws.send_json({"seq": 0, "event": {"type": "ws_error",
                                                                "error": "bad json"}})
            if pub in done:
                seq, event = pub.result()
                await ws.send_json({"seq": seq, "event": event})
                last_sent = seq
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        sess.unsubscribe(q)


# ------------------------------------------------------------------- static

@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
