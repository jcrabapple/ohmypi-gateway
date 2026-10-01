"""ohmypi-gateway: HTTP/WebSocket gateway over the omp (oh-my-pi) RPC protocol.

Designed to sit behind a Cloudflare tunnel. See gateway/auth.py for the auth
model and docs/API.md for the client contract.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import json
import logging
import os
import re
import weakref
import subprocess
import time
from pathlib import Path

import yaml
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .auth import (
    COOKIE_NAME,
    COOKIE_TTL,
    FailureLimiter,
    TokenStore,
    bearer,
    client_ip,
    forwarded_https,
    origin_allowed,
)
from .bridge import (
    DEFAULT_APPROVAL_MODE,
    OMP_AGENT_DIR,
    OMP_BIN,
    ProcessDead,
    RpcError,
    _UNSET,
    canonical_path,
    get_manager,
    read_session_cwd,
    scan_saved_sessions,
)
from .ledger import DEFAULT_DAYS, close_ledger, get_ledger

VERSION = "0.6.0"
PROJECT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = PROJECT_DIR / "static"
# Built web client. Served when WEB_DIST/index.html exists, else the Alpine dashboard.
WEB_DIST = Path(os.environ.get("OMPGW_WEB_DIST") or PROJECT_DIR / "web" / "dist").expanduser().resolve()
CONFIG_FILE = OMP_AGENT_DIR / "config.yml"
STARTED_AT = time.time()

log = logging.getLogger("ohmpi-gateway.main")

MAX_SESSIONS = int(os.environ.get("OMPGW_MAX_SESSIONS", "8"))
IDLE_REAP_SEC = int(os.environ.get("OMPGW_IDLE_REAP_SEC", str(6 * 3600)))
WS_HEARTBEAT_SEC = 25          # Cloudflare drops idle websockets at ~100s
WS_AUTH_TIMEOUT_SEC = 10
# Extra browser origins allowed to use cookie auth (comma-separated).
EXTRA_ORIGINS = {o.strip() for o in os.environ.get("OMPGW_EXTRA_ORIGINS", "").split(",") if o.strip()}
THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max", "auto")
APPROVAL_MODES = ("always-ask", "write", "yolo")

tokens = TokenStore(PROJECT_DIR / "auth-token")
limiter = FailureLimiter()

app = FastAPI(title="ohmypi-gateway", version=VERSION,
              docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")

# Bearer-token clients (desktop, mobile, other web origins) may call from any
# origin. Credentials are NOT allowed cross-origin, so the session cookie is
# never usable from a foreign page; foreign pages must hold the token.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-API-Key"],
    max_age=600,
)

PUBLIC_PATHS = {"/", "/classic", "/healthz", "/auth/login", "/auth/logout",
                "/.well-known/ompgw.json", "/manifest.webmanifest"}
UNSAFE_METHODS = {"POST", "PUT", "DELETE", "PATCH"}

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
}


def web_dist_ready() -> bool:
    return (WEB_DIST / "index.html").is_file()


def csp_for(path: str) -> str:
    # Alpine's standard build compiles expressions with Function(), hence
    # unsafe-eval for the classic dashboard only. The Svelte app needs none.
    # Without a web build, "/" is the Alpine dashboard too.
    classic = path == "/classic" or path.startswith("/static/") or (path == "/" and not web_dist_ready())
    script = "script-src 'self' 'unsafe-eval'" if classic else "script-src 'self'"
    return (
        f"default-src 'self'; {script}; "
        "style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; "
        "worker-src 'self'; manifest-src 'self'; "
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    )


def dist_root_file(name: str) -> Path | None:
    """A regular file sitting directly in WEB_DIST (never index.html, never a
    path, never a symlink that leaves the directory)."""
    if not name or name == "index.html" or name.startswith(".") or "/" in name or "\\" in name:
        return None
    try:
        p = (WEB_DIST / name).resolve()
        return p if p.is_file() and p.parent == WEB_DIST else None
    except (OSError, ValueError):
        return None


def dist_asset(rel: str) -> Path | None:
    base = WEB_DIST / "assets"
    try:
        base = base.resolve()
        p = (base / rel).resolve()
        return p if p.is_file() and base in p.parents else None
    except (OSError, ValueError):
        return None


def is_public(path: str) -> bool:
    if path in PUBLIC_PATHS or path.startswith(("/static/", "/assets/")):
        return True
    return path.count("/") == 1 and dist_root_file(path[1:]) is not None


def _peer(request_or_ws) -> str | None:
    return request_or_ws.client.host if request_or_ws.client else None


def authenticate(headers, cookies, peer: str | None) -> str | None:
    """Return 'bearer' / 'cookie' / None."""
    if tokens.check(bearer(headers)):
        return "bearer"
    if tokens.check_cookie(cookies.get(COOKIE_NAME)):
        return "cookie"
    return None


@app.middleware("http")
async def gate(request: Request, call_next):
    path = request.url.path
    ip = client_ip(request.headers, _peer(request))
    needs_auth = not is_public(path) and request.method != "OPTIONS"

    if needs_auth:
        wait = limiter.locked(ip)
        if wait:
            return JSONResponse({"error": "too many failed attempts", "retryAfterSec": int(wait)},
                                status_code=429, headers={"Retry-After": str(int(wait))})
        how = authenticate(request.headers, request.cookies, _peer(request))
        if how is None:
            # Only a presented-and-wrong credential counts toward lockout; a
            # signed-out browser probing /api/me is not an attack.
            if bearer(request.headers) or request.cookies.get(COOKIE_NAME):
                limiter.fail(ip)
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        # CSRF: cookie-authenticated state changes must come from our own origin.
        if how == "cookie" and request.method in UNSAFE_METHODS:
            if not origin_allowed(request.headers.get("origin"), request.headers.get("host"),
                                  EXTRA_ORIGINS):
                return JSONResponse({"error": "cross-origin request refused"}, status_code=403)
        request.state.auth = how

    response = await call_next(request)
    for k, v in SECURITY_HEADERS.items():
        response.headers.setdefault(k, v)
    response.headers.setdefault("Content-Security-Policy", csp_for(path))
    if path in ("/", "/classic") or path.startswith("/static/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


def cli(*args: str, timeout: float = 60) -> str:
    """Run an omp CLI subcommand and return stdout text."""
    env = dict(os.environ)
    env["PATH"] = os.path.expanduser("~/.bun/bin:") + env.get("PATH", "")
    try:
        r = subprocess.run([OMP_BIN, *args], capture_output=True, text=True,
                           timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, f"omp {' '.join(args)} timed out")
    if r.returncode != 0:
        raise HTTPException(502, (r.stderr or r.stdout or "omp failed").strip()[:2000])
    return r.stdout


async def acli(*args: str, timeout: float = 60) -> str:
    """cli() off the event loop, so slow subcommands don't stall live streams."""
    return await asyncio.to_thread(cli, *args, timeout=timeout)


def get_session_or_404(gw_id: str):
    try:
        return get_manager().get(gw_id)
    except KeyError:
        raise HTTPException(404, f"no live session {gw_id}")


async def json_body(request: Request) -> dict:
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(400, "body must be JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "body must be a JSON object")
    return body


@app.exception_handler(RpcError)
async def rpc_error_handler(request: Request, exc: RpcError):
    return JSONResponse({"error": str(exc), "code": exc.code}, status_code=400)


@app.exception_handler(ProcessDead)
async def process_dead_handler(request: Request, exc: ProcessDead):
    return JSONResponse({"error": str(exc)}, status_code=409)


@app.exception_handler(HTTPException)
async def http_error_handler(request: Request, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    """Keep the documented {"error": ...} shape for query/body validation
    (FastAPI's default is a `detail` array)."""
    def fmt(err: dict) -> str:
        loc = ".".join(str(p) for p in err.get("loc", ()) if p not in ("body", "query"))
        msg = err.get("msg", "invalid value")
        return f"{loc}: {msg}" if loc else msg

    return JSONResponse({"error": "; ".join(fmt(e) for e in exc.errors()) or "invalid request"},
                        status_code=422)


# ----------------------------------------------------------------------- auth

@app.post("/auth/login")
async def login(request: Request):
    ip = client_ip(request.headers, _peer(request))
    wait = limiter.locked(ip)
    if wait:
        return JSONResponse({"error": "too many failed attempts", "retryAfterSec": int(wait)},
                            status_code=429, headers={"Retry-After": str(int(wait))})
    if not origin_allowed(request.headers.get("origin"), request.headers.get("host"), EXTRA_ORIGINS):
        return JSONResponse({"error": "cross-origin login refused"}, status_code=403)
    body = await json_body(request)
    if not tokens.check(body.get("token")):
        limiter.fail(ip)
        return JSONResponse({"error": "invalid token"}, status_code=401)
    limiter.succeed(ip)
    resp = JSONResponse({"ok": True})
    resp.set_cookie(COOKIE_NAME, tokens.mint_cookie(), max_age=COOKIE_TTL, httponly=True,
                     secure=forwarded_https(request.headers, _peer(request)) or
                     request.url.scheme == "https",
                     samesite="strict", path="/")
    return resp


@app.post("/auth/logout")
async def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


@app.get("/api/me")
async def me(request: Request):
    return {"authenticated": True, "method": getattr(request.state, "auth", None)}


# --------------------------------------------------------------------- system

@app.get("/healthz")
async def healthz():
    """Unauthenticated liveness probe. Deliberately says nothing else."""
    return {"ok": True}


@app.get("/.well-known/ompgw.json")
async def discovery():
    """Unauthenticated client bootstrap: what this server speaks, not what it holds."""
    return {
        "name": "ohmypi-gateway",
        "version": VERSION,
        "apiBase": "/api",
        "websocket": "/omp-ws/{sessionId}",
        "auth": {"bearer": True, "cookieLogin": "/auth/login",
                 "wsFirstMessage": {"type": "auth", "token": "<token>"}},
        "openapi": "/api/openapi.json",
    }


@app.get("/api/health")
async def health():
    m = get_manager()
    return {"ok": True, "version": VERSION, "uptimeSec": round(time.time() - STARTED_AT, 1),
            "liveSessions": len(m.sessions), "maxSessions": MAX_SESSIONS}


@app.get("/api/system")
async def system():
    m = get_manager()
    omp_version = "unknown"
    with contextlib.suppress(HTTPException):
        m_ = re.search(r"(\d+\.\d+\.\d+\S*)", await acli("--version", timeout=15))
        omp_version = m_.group(1) if m_ else "unknown"
    return {
        "gateway": {"version": VERSION, "uptimeSec": round(time.time() - STARTED_AT, 1),
                    "maxSessions": MAX_SESSIONS, "idleReapSec": IDLE_REAP_SEC},
        "omp": {"version": omp_version, "agentDir": str(OMP_AGENT_DIR),
                "configFile": str(CONFIG_FILE)},
        "liveSessions": len(m.sessions),
    }


# --------------------------------------------------------------------- config

_config_lock = asyncio.Lock()


@app.get("/api/config")
async def get_config():
    if not CONFIG_FILE.exists():
        raise HTTPException(404, "config.yml not found")
    raw = CONFIG_FILE.read_text()
    try:
        parsed = yaml.safe_load(raw)
    except yaml.YAMLError as e:
        return {"raw": raw, "parsed": None, "file": str(CONFIG_FILE), "parseError": str(e)}
    return {"raw": raw, "parsed": parsed, "file": str(CONFIG_FILE)}


@app.put("/api/config")
async def put_config(request: Request):
    text = (await request.body()).decode("utf-8", "replace")
    if len(text) > 256 * 1024:
        raise HTTPException(413, "config too large")
    try:
        parsed = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise HTTPException(400, f"invalid YAML: {e}")
    if parsed is not None and not isinstance(parsed, dict):
        raise HTTPException(400, "config must be a YAML mapping")
    async with _config_lock:
        backup = CONFIG_FILE.with_name("config.yml.bak-gateway")
        backup.write_text(CONFIG_FILE.read_text())
        CONFIG_FILE.write_text(text)
        try:
            await acli("config", "get", "modelRoles", timeout=30)
        except HTTPException as e:
            CONFIG_FILE.write_text(backup.read_text())
            raise HTTPException(400, f"omp rejected the config, reverted: {e.detail}")
    return {"ok": True, "keys": sorted((parsed or {}).keys()),
            "note": "running sessions keep their old settings until restarted"}


# --------------------------------------------------------------- catalog / cli

@app.get("/api/models")
async def models(q: str | None = None):
    args = ["models"] + ([q] if q else [])
    return {"raw": (await acli(*args, timeout=90))[-40000:]}


_MODELS_TTL_SEC = 600
_models_cache: tuple[float, dict] | None = None
_models_task: asyncio.Task | None = None


async def _refresh_models() -> dict:
    out = await acli("models", "--json", timeout=180)
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        raise HTTPException(502, "omp models --json returned invalid JSON")
    if not isinstance(data, dict):
        data = {"models": data}
    global _models_cache
    _models_cache = (time.monotonic(), data)
    return data


@app.get("/api/catalog/models")
async def catalog_models(refresh: int = 0):
    """`omp models --json`, cached for 10 minutes. The RPC get_available_models
    takes minutes, so clients should use this instead. Refreshes are single-flight
    (concurrent callers coalesce onto one subprocess) and never block a cache
    hit: the lock-used-to-wrap-the-subprocess here made every hit queue behind
    an in-flight refresh for up to 3 minutes."""
    global _models_task
    now = time.monotonic()
    if not refresh and _models_cache is not None and now - _models_cache[0] <= _MODELS_TTL_SEC:
        return _models_cache[1]
    if _models_task is None or _models_task.done():
        _models_task = asyncio.create_task(_refresh_models())
    try:
        return await _models_task
    except Exception:
        # Stale-while-error: prefer the last good catalog over a 502.
        if _models_cache is not None:
            return _models_cache[1]
        raise


@app.get("/api/push/vapid")
async def push_vapid():
    """Public VAPID application server key for PushManager.subscribe().
    503 when the pywebpush dependency is not installed."""
    from . import push as push_mod
    if not push_mod.available():
        raise HTTPException(503, "web push unavailable: pywebpush not installed")
    return {"publicKey": push_mod.public_key()}


@app.post("/api/push/subscribe")
async def push_subscribe(request: Request):
    """Register a device: the browser PushSubscription as
    `{endpoint, keys: {p256dh, auth}}`. Idempotent per endpoint."""
    from . import push as push_mod
    if not push_mod.available():
        raise HTTPException(503, "web push unavailable: pywebpush not installed")
    body = await json_body(request)
    try:
        count = push_mod.subscribe(body.get("endpoint"), body.get("keys") or {})
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"ok": True, "subscriptions": count}


@app.post("/api/push/unsubscribe")
async def push_unsubscribe(request: Request):
    """Remove a device by its push service `endpoint`."""
    from . import push as push_mod
    body = await json_body(request)
    endpoint = body.get("endpoint")
    if not isinstance(endpoint, str) or not endpoint:
        raise HTTPException(422, "endpoint required")
    return {"ok": True, "subscriptions": push_mod.unsubscribe(endpoint)}


def _restore_archived(archived_path: Path) -> Path:
    """Copy a gzipped (or plain) archived transcript into the live sessions
    dir so it becomes a normal resumable file. Exact-name reuse: a second
    resume of the same archive returns the first restore's file. The copy is
    atomic: a failed restore leaves no partial file behind to poison later
    restores."""
    import gzip
    from .search import SESSIONS_DIR

    out_dir = SESSIONS_DIR / "restored"
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = archived_path.name
    for suffix in (".jsonl.gz", ".gz", ".jsonl"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    out = out_dir / f"{stem}.jsonl"
    if out.is_file():
        return out
    # Copy in chunks with a ceiling: a crafted gzip bomb must not exhaust memory.
    max_bytes = 100 * 1024 * 1024
    total = 0
    tmp = out.with_suffix(".jsonl.tmp")
    opener = gzip.open if archived_path.suffix == ".gz" else open
    try:
        with opener(archived_path, "rb") as src, open(tmp, "wb") as dst:
            while chunk := src.read(65536):
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError("archived transcript exceeds the 100 MB restore limit")
                dst.write(chunk)
        os.replace(tmp, out)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    log.info("restored archived transcript %s -> %s", archived_path, out)
    return out


@app.get("/api/search")
async def search_endpoint(q: str = Query(min_length=1), limit: int = Query(default=40, ge=1, le=200),
                          role: str | None = None, refresh: int = 0):
    """Full-text search over saved session transcripts (user/assistant text).
    Index refreshes incrementally, at most once per 30s (refresh=1 forces).
    Results carry private-use-area delimiters around matches; clients must
    escape the snippet before mapping them to <mark> elements."""
    from . import search as smod
    if role not in (None, "user", "assistant"):
        raise HTTPException(422, "role must be user|assistant")

    def run() -> dict:
        smod.ensure_fresh(force=bool(refresh))
        return smod.query(q, limit=limit, role=role)

    out = await asyncio.to_thread(run)
    await get_manager().reap_dead()
    live_by_file: dict[str, str] = {}
    restored_by_stem: dict[str, str] = {}
    from .search import SESSIONS_DIR as _SEARCH_ROOT_MOD
    restored_dir = (_SEARCH_ROOT_MOD / "restored").resolve()
    for sess in get_manager().sessions.values():
        # exited children are still registered until reaped: they are not live
        if sess.exited or not sess.omp_session_file:
            continue
        resolved = str(Path(sess.omp_session_file).resolve())
        live_by_file[resolved] = sess.gw_id
        # A restored archive transcript that is running live: search hits for
        # the archived original should open THIS session, not spawn a dupe.
        if Path(resolved).parent == restored_dir:
            restored_by_stem[Path(resolved).name.removesuffix(".jsonl")] = sess.gw_id
    for r in out["results"]:
        gw = live_by_file.get(str(Path(r["path"]).resolve()))
        if gw is None and r.get("archived"):
            stem = Path(r["path"]).name
            for suffix in (".jsonl.gz", ".gz", ".jsonl"):
                if stem.endswith(suffix):
                    stem = stem[: -len(suffix)]
                    break
            gw = restored_by_stem.get(stem)
        r["gwId"] = gw
    out["indexed"] = await asyncio.to_thread(smod.index_stats)
    return out


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
                    desc, in_front = "", False
                    for line in cand.read_text(errors="replace").splitlines()[:30]:
                        if line.strip() == "---":
                            if in_front:
                                break
                            in_front = True
                            continue
                        if in_front and line.lower().startswith("description:"):
                            desc = line.split(":", 1)[1].strip().strip("\"'>")
                            break
                    installed.append({"name": p.name, "description": desc,
                                      "symlink": p.is_symlink()})
                    break
    return {"installed": installed}


async def _cli_text(*args: str, timeout: float = 60) -> dict:
    try:
        return {"raw": (await acli(*args, timeout=timeout))[-40000:]}
    except HTTPException as e:
        return {"raw": "", "error": e.detail}


@app.get("/api/plugins")
async def plugins():
    return await _cli_text("plugin", "list", timeout=60)


@app.get("/api/usage")
async def usage():
    return await _cli_text("usage", timeout=90)


@app.get("/api/agents")
async def agents():
    return await _cli_text("agents", timeout=30)


@app.get("/api/stats")
async def stats():
    return await _cli_text("stats", timeout=60)


# ---------------------------------------------------------------- usage ledger
# Sync def on purpose: the aggregate calls block on sqlite, and FastAPI runs
# sync routes in its threadpool instead of on the event loop.

@app.get("/api/ledger")
def ledger(days: int = Query(DEFAULT_DAYS, ge=1, le=365),
           model: str | None = None, provider: str | None = None):
    """Aggregated usage ledger over completed agent turns (one row per turn,
    written by the bridge at prompt_result). Totals, per-day and per-model
    sums; `model` accepts the bare name or provider/name, `provider` is exact.
    perDay is exactly `days` gateway-local calendar buckets, zero-filled."""
    return get_ledger().aggregate(days=days, model=model or None, provider=provider or None)


@app.get("/api/ledger/sessions")
def ledger_sessions(days: int = Query(DEFAULT_DAYS, ge=1, le=365)):
    """Per-session rollup (session name + cwd) behind the usage page's session table."""
    return get_ledger().session_rollup(days=days)


# ------------------------------------------------------------------- sessions

MAX_IMAGES = 4
MAX_IMAGE_BYTES = 5 * 1024 * 1024
IMAGE_MIME_TYPES = ("image/png", "image/jpeg", "image/webp", "image/gif")

# Magic-byte signatures; the mime label alone is attacker-controlled.
_IMAGE_MAGIC = {
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/webp": (b"RIFF",),  # plus "WEBP" at offset 8
    "image/gif": (b"GIF87a", b"GIF89a"),
}


def _magic_ok(mime: str, blob: bytes) -> bool:
    sigs = _IMAGE_MAGIC.get(mime, ())
    if mime == "image/webp":
        return len(blob) >= 12 and blob[:4] == b"RIFF" and blob[8:12] == b"WEBP"
    return any(blob.startswith(s) for s in sigs)


def parse_images(raw) -> list[dict]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise HTTPException(422, "images must be a list")
    if len(raw) > MAX_IMAGES:
        raise HTTPException(422, f"at most {MAX_IMAGES} images")
    out = []
    for i, img in enumerate(raw):
        if not isinstance(img, dict) or img.get("type") != "image":
            raise HTTPException(422, f"images[{i}] must be an object with type \"image\"")
        if img.get("mimeType") not in IMAGE_MIME_TYPES:
            raise HTTPException(422, f"images[{i}].mimeType must be one of {', '.join(IMAGE_MIME_TYPES)}")
        data = img.get("data")
        if not isinstance(data, str) or not data:
            raise HTTPException(422, f"images[{i}].data must be a base64 string")
        # Cheap bound before decoding: base64 is 4 chars per 3 bytes.
        if len(data) > (MAX_IMAGE_BYTES // 3 + 1) * 4:
            raise HTTPException(422, f"images[{i}] is larger than {MAX_IMAGE_BYTES // (1024 * 1024)} MB")
        try:
            decoded = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(422, f"images[{i}].data is not valid base64")
        if not decoded:
            raise HTTPException(422, f"images[{i}].data is empty")
        if len(decoded) > MAX_IMAGE_BYTES:
            raise HTTPException(422, f"images[{i}] is larger than {MAX_IMAGE_BYTES // (1024 * 1024)} MB")
        if not _magic_ok(img["mimeType"], decoded):
            raise HTTPException(422, f"images[{i}] does not look like a real {img['mimeType']} "
                                     f"(magic bytes do not match)")
        out.append({"type": "image", "data": data, "mimeType": img["mimeType"]})
    return out

@app.get("/api/sessions")
async def list_sessions(include_saved: bool = True, limit: int = 100):
    await get_manager().reap_dead()
    live = get_manager().list_live()
    saved = scan_saved_sessions(limit=min(limit, 500)) if include_saved else []
    return {"live": live, "saved": saved}


@app.post("/api/sessions")
async def create_session(request: Request):
    body = await json_body(request)
    await get_manager().reap_dead()
    approval_mode = body.get("approvalMode", DEFAULT_APPROVAL_MODE)
    if approval_mode not in APPROVAL_MODES:
        raise HTTPException(422, "approvalMode must be always-ask|write|yolo")
    thinking = body.get("thinking")
    if thinking and thinking not in THINKING_LEVELS:
        raise HTTPException(422, "invalid thinking level")
    advisor = bool(body.get("advisor", False))
    resume = body.get("resumeFrom")
    if resume:
        rp = Path(resume).expanduser().resolve()
        # Search hits in the omp archive are resumable too: restore the
        # (possibly gzipped) transcript into the live sessions dir first.
        from .search import ARCHIVE_DIR as _ARCHIVE_ROOT, SESSIONS_DIR as _SEARCH_ROOT
        in_archive = _ARCHIVE_ROOT.resolve() in rp.parents
        if in_archive:
            if not rp.is_file():
                raise HTTPException(422, "archived transcript no longer exists")
            try:
                rp = _restore_archived(rp)
            except (ValueError, OSError) as e:
                raise HTTPException(422, str(e))
        if not rp.is_file() or _SEARCH_ROOT.resolve() not in rp.parents:
            raise HTTPException(422, "resumeFrom must be a saved session file from /api/sessions")
        resume = str(rp)
        existing = get_manager().find_by_file(resume)
        if existing is not None:
            return {**existing.info(), "alreadyLive": True}
    async with _spawn_lock:
        if len(get_manager().sessions) >= MAX_SESSIONS:
            raise HTTPException(429, f"session limit reached ({MAX_SESSIONS}); stop one first")
        cwd = body.get("cwd")
        cwd_fallback = False
        if not cwd and resume:
            saved_cwd = read_session_cwd(resume)
            if saved_cwd and Path(saved_cwd).expanduser().is_dir():
                cwd = saved_cwd
            else:
                cwd_fallback = True
        cwd = cwd or os.path.expanduser("~/projects")
        sess = await get_manager().create(cwd=cwd, model=body.get("model") or None,
                                          thinking=thinking or None, approval_mode=approval_mode,
                                          session_file=resume, advisor=advisor)
    return {**sess.info(), **({"cwdFallback": True} if cwd_fallback else {})}


@app.get("/api/sessions/{gw_id}")
async def session_info(gw_id: str):
    sess = get_session_or_404(gw_id)
    with contextlib.suppress(RpcError, ProcessDead):
        await sess.get_state()
    return sess.info()


@app.delete("/api/sessions/{gw_id}")
async def stop_session(gw_id: str):
    get_session_or_404(gw_id)
    return await get_manager().stop(gw_id)


@app.post("/api/sessions/{gw_id}/prompt")
async def prompt(gw_id: str, request: Request):
    """wait:true blocks until the turn ends. Behind Cloudflare a response must
    start within 100s, so remote clients should use wait:false + the stream."""
    sess = get_session_or_404(gw_id)
    body = await json_body(request)
    message = body.get("message")
    images = parse_images(body.get("images"))
    if not isinstance(message, str) or not (message.strip() or images):
        raise HTTPException(422, "message required")
    mode = body.get("mode") or ("steer" if body.get("steer") else "prompt")
    if mode not in ("prompt", "steer", "follow_up"):
        raise HTTPException(422, "mode must be prompt|steer|follow_up")
    wait = bool(body.get("wait"))
    sess.touch()
    if mode == "follow_up":
        # Gateway-owned queue: omp's queue is count-only (no RPC to list,
        # edit or cancel), so holding it here is what makes queued messages
        # editable. Fired head-first when the running turn ends ok.
        entry = sess.queue_add(message, images)
        out = sess.info()
        out["ack"] = {"queued": True, "id": entry["id"]}
        return out
    data = await sess.prompt(message, wait=wait, steer=(mode == "steer"),
                             timeout=float(body.get("timeout", 600)), images=images)
    out = sess.info()
    out["ack"] = data
    if wait:
        out["lastAssistantText"] = await sess.last_assistant_text()
    return out


@app.get("/api/sessions/{gw_id}/queue")
async def queue_list(gw_id: str):
    return {"queue": get_session_or_404(gw_id).queue_list()}


@app.patch("/api/sessions/{gw_id}/queue/{qid}")
async def queue_edit(gw_id: str, qid: str, request: Request):
    """Edit a queued follow-up before it fires: {message?, images?}."""
    sess = get_session_or_404(gw_id)
    body = await json_body(request)
    message = body.get("message")
    if message is not None and (not isinstance(message, str) or not message.strip()):
        raise HTTPException(422, "message must be a non-empty string")
    images = parse_images(body["images"]) if "images" in body else _UNSET
    entry = sess.queue_edit(qid, message=message, images=images)
    if entry is None:
        raise HTTPException(404, "no such queued message (already fired or cancelled)")
    return {"entry": {"id": entry["id"], "message": entry["message"], "ts": entry["ts"],
                      "images": len(entry["images"] or [])}}


@app.delete("/api/sessions/{gw_id}/queue/{qid}")
async def queue_remove(gw_id: str, qid: str):
    if not get_session_or_404(gw_id).queue_remove(qid):
        raise HTTPException(404, "no such queued message (already fired or cancelled)")
    return {"ok": True}


@app.post("/api/sessions/{gw_id}/abort")
async def abort(gw_id: str):
    return {"data": await get_session_or_404(gw_id).command("abort", timeout=15)}


@app.post("/api/sessions/{gw_id}/retry")
async def retry(gw_id: str):
    """Re-run the last failed turn (omp abort_retry). Errors at the omp layer,
    including "unknown command" on older omp, surface as 4xx like every command route."""
    return {"data": await get_session_or_404(gw_id).command("abort_retry", timeout=15)}


@app.post("/api/sessions/{gw_id}/compact")
async def compact(gw_id: str, request: Request):
    body = await json_body(request) if (await request.body()) else {}
    kw = {"customInstructions": body["instructions"]} if body.get("instructions") else {}
    return {"data": await get_session_or_404(gw_id).command("compact", timeout=300, **kw)}


@app.get("/api/sessions/{gw_id}/state")
async def state(gw_id: str):
    st = await get_session_or_404(gw_id).get_state()
    # systemPrompt + tool dumps are large and rarely wanted by clients.
    if isinstance(st, dict):
        st = {k: v for k, v in st.items() if k not in ("systemPrompt", "dumpTools")}
    return st


@app.get("/api/sessions/{gw_id}/messages")
async def messages(gw_id: str):
    return await get_session_or_404(gw_id).messages()


@app.get("/api/sessions/{gw_id}/entries")
async def entries(gw_id: str):
    """Distilled get_entries: one row per session-file message entry, with the
    entryId the fork route expects. Fork targets are user entries only."""
    data = await get_session_or_404(gw_id).entries()
    out = []
    for e in data.get("entries") or []:
        if not isinstance(e, dict) or e.get("type") != "message":
            continue
        msg = e.get("message") if isinstance(e.get("message"), dict) else {}
        ts = msg.get("timestamp", e.get("timestamp"))
        out.append({"entryId": e.get("id"), "role": msg.get("role"),
                    "timestamp": ts if isinstance(ts, (int, float)) else None})
    return {"entries": out}


def _entry_file(value) -> str | None:
    return canonical_path(value) if isinstance(value, str) and value else None


def _branched_candidate(old_file: str | None, since: float) -> str | None:
    """The branched session file on disk. omp 18.4.2 writes it at branch time
    but keeps reporting the OLD file in get_state (no session_info_update
    either), so the session folder is the only source of truth: the newest
    .jsonl modified since the branch started that is neither the old file nor
    a file owned by another live session."""
    if not old_file:
        return None
    live = {s.omp_session_file for s in get_manager().sessions.values() if s.omp_session_file}
    best: tuple[float, str] | None = None
    try:
        for p in Path(old_file).parent.glob("*.jsonl"):
            try:
                mtime = p.stat().st_mtime
            except OSError:
                continue
            if mtime < since or best is not None and mtime <= best[0]:
                continue
            f = _entry_file(str(p))
            if f is None or f == old_file or f in live:
                continue
            best = (mtime, f)
    except OSError:
        return None
    return best[1] if best else None


async def _branched_file(sess, old_file: str | None, data, since: float) -> str:
    """The session file omp branched to. omp 18.4.2 answers `branch` with
    {text, cancelled}, switches its live process to the new file itself, and
    persists the branched entries to a new file on disk right away while its
    state keeps naming the old file. So: honor explicit `path`/`sessionFile`
    keys when an omp build sends them, watch the session's own file tracking,
    and fall back to scanning the session folder."""
    want = _entry_file((data or {}).get("path") if isinstance(data, dict) else None) \
        or _entry_file((data or {}).get("sessionFile") if isinstance(data, dict) else None)
    if want == old_file:
        want = None  # omp echoes the old file until its own state update lands
    deadline = time.monotonic() + 10
    while want is None and time.monotonic() < deadline:
        if sess.omp_session_file and sess.omp_session_file != old_file:
            want = sess.omp_session_file
            break
        with contextlib.suppress(RpcError, ProcessDead):
            st = await sess.get_state()
            cand = _entry_file(st.get("sessionFile")) if isinstance(st, dict) else None
            if cand and cand != old_file:
                want = cand
        if want is None:
            want = _branched_candidate(old_file, since)
        if want is None:
            await asyncio.sleep(0.1)
    if want is None:
        raise HTTPException(500, "branch succeeded but the new session file could not be resolved")
    return want


def _model_flag(value) -> str | None:
    """A --model/--thinking string for a resumed child. The session's CURRENT
    values arrive as a model-ref dict from get_state (the launch flags were
    plain strings), and omp fuzzy-matches "provider/id" forms."""
    if isinstance(value, dict):
        mid, provider = value.get("id"), value.get("provider")
        if isinstance(mid, str) and mid:
            return f"{provider}/{mid}" if isinstance(provider, str) and provider else mid
        return None
    return value if isinstance(value, str) and value else None


# One branch at a time per session: omp's branch mutates the live process, so
# concurrent forks on one session would double-branch from the same file.
# WeakValueDictionary: a live entry survives exactly as long as some in-flight
# request (or queued waiter) still holds the Lock object, so entries vanish on
# their own and a lock can never be swapped out under a waiting fork's feet.
_fork_locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()
# Serializes every check-then-spawn section (create + fork): the MAX_SESSIONS
# check and manager.create() must not interleave across requests, or two
# concurrent POSTs both pass the cap check and overshoot it.
_spawn_lock = asyncio.Lock()

# Keys command() treats as its own call semantics; a client frame carrying them
# would silently override the gateway's timeout or correlation behavior. self
# and type_ are command()'s own parameter names: as **params keys they raise
# TypeError (multiple values) instead of reaching omp.
_CMD_RESERVED_KEYS = ("timeout", "late_errors", "self", "type_")


def _command_params(frame: dict) -> dict:
    """Whitelist client-supplied RPC parameters. Non-identifier keys would
    raise TypeError out of **params (a 500 on /rpc, a dead WS pump on the
    socket); reserved keys would hijack command() internals."""
    params = {}
    for k, v in frame.items():
        if not k.isidentifier() or k in _CMD_RESERVED_KEYS:
            raise ValueError(f"invalid RPC parameter key: {k!r}")
        params[k] = v
    return params


@app.post("/api/sessions/{gw_id}/fork")
async def fork(gw_id: str, request: Request):
    """Fork the session at a user entry (omp `branch`). omp rewrites its live
    process into a new branched session file (the original transcript stays on
    disk untouched), so the gateway registers that branched session under a new
    gw id exactly like create does, then stops the now-redundant old process."""
    body = await json_body(request)
    entry_id = body.get("entryId")
    if not isinstance(entry_id, str) or not entry_id:
        raise HTTPException(422, "entryId required")
    lock = _fork_locks.setdefault(gw_id, asyncio.Lock())
    async with lock:
        # A concurrent fork may have stopped this session while we waited.
        sess = get_session_or_404(gw_id)
        if sess.is_busy():
            raise HTTPException(409, "session is busy; wait for the turn to end before forking")
        # Validate against the live entries: omp would reject non-user entries with
        # "Invalid entry ID for branching", but the 422 says what the client did wrong.
        for e in (await sess.entries()).get("entries") or []:
            if isinstance(e, dict) and e.get("id") == entry_id:
                msg = e.get("message") if isinstance(e.get("message"), dict) else {}
                if e.get("type") == "message" and msg.get("role") == "user":
                    break
                raise HTTPException(422, "entryId is not a user message entry")
        else:
            raise HTTPException(422, "unknown entryId")
        # A fork stops the parent and registers the child: net-zero. Reap dead
        # sessions first, then discount the parent being replaced, so a fork at
        # the cap only 429s when it would really add a session.
        await get_manager().reap_dead()
        m = get_manager()
        old_file = sess.omp_session_file
        if not old_file:
            # omp only reports its session file on get_state and
            # session_info_update events; a fork target always has entries and
            # therefore a file on disk, so fetch the state once to anchor the
            # branched-file scan below.
            with contextlib.suppress(RpcError, ProcessDead):
                await sess.get_state()
            old_file = sess.omp_session_file
        branch_started = time.time()
        data = await sess.command("branch", entryId=entry_id, timeout=30)
        if isinstance(data, dict) and data.get("cancelled"):
            raise RpcError("branch", "cancelled by an extension")
        new_file = await _branched_file(sess, old_file, data, since=branch_started)
        # Stop before resuming: omp holds the branched entries in memory and
        # persists them on exit, so the resume process must start after the old
        # one has flushed the file (the reverse order reads an empty transcript).
        # Held through the respawn with _spawn_lock so the cap stays exact.
        async with _spawn_lock:
            if len(m.sessions) - (1 if gw_id in m.sessions else 0) >= MAX_SESSIONS:
                raise HTTPException(429, f"session limit reached ({MAX_SESSIONS}); stop one first")
            with contextlib.suppress(KeyError):
                await get_manager().stop(gw_id)
            # The CURRENT model/thinking, not the launch flags: mid-session /model
            # and /thinking changes must survive the fork.
            try:
                new = await get_manager().create(cwd=sess.cwd,
                                                 model=_model_flag(sess.model) or sess.requested_model,
                                                 thinking=_model_flag(sess.thinking_level) or sess.requested_thinking,
                                                 approval_mode=sess.approval_mode,
                                                 session_file=new_file,
                                                 advisor=sess.advisor)
            except Exception as exc:
                # Compensation: the parent process is already stopped, and its
                # branched transcript was flushed to old_file on exit. Restore
                # the parent from disk instead of leaving the client with no
                # live session at all. If the restore also fails, the 500 is
                # honest: nothing we can respawn from is left.
                log.exception("[%s] fork respawn failed; restoring parent from %s", gw_id, old_file)
                restored = await get_manager().create(cwd=sess.cwd,
                                                      model=_model_flag(sess.model) or sess.requested_model,
                                                      thinking=_model_flag(sess.thinking_level) or sess.requested_thinking,
                                                      approval_mode=sess.approval_mode,
                                                      session_file=old_file,
                                                      advisor=sess.advisor)
                # An error status, not a 200 with a forkError field: clients
                # treat any 2xx as a successful fork and would toast one.
                raise HTTPException(
                    500, f"fork failed, the parent session was restored as a new "
                         f"session {restored.gw_id}: {exc}")
    # omp returns the branched entry's text ("selectedText"): the fork carries
    # history strictly BEFORE that message, and clients prefill the composer
    # with it for a re-send. A root entry produces an empty session instead
    # (omp links it to the old file via parentSession).
    text = data.get("text") if isinstance(data, dict) else None
    return {"gwId": new.gw_id, "forkedFrom": old_file, "text": text if isinstance(text, str) else None}


MAX_FILE_ENTRIES = 200


def _reject_prefix(prefix: str) -> str | None:
    """Prefix problems that are rejected outright, before any path math."""
    if "\x00" in prefix:
        return "prefix contains a null byte"
    if prefix.startswith(("/", "\\")) or (len(prefix) >= 2 and prefix[1] == ":"):
        return "prefix must be relative to the session directory"
    # Split on both separators: a backslash is a legal filename character on
    # POSIX, so "sub\..\secret" must be rejected outright, never resolved.
    if any(part == ".." for part in re.split(r"[/\\]", prefix)):
        return "prefix must not contain '..'"
    return None


@app.get("/api/sessions/{gw_id}/files")
async def session_files(gw_id: str, prefix: str = ""):
    """Index-only listing of ONE directory level of the session cwd, for
    @-file mentions. Names and sizes only; file contents are never served.
    Dotfiles are excluded, entries are dirs-first then name, capped at 200.
    The requested path must resolve inside the session's real cwd: absolute
    prefixes and '..' segments are 422 outright, a symlink whose target leaves
    the cwd is 403, an unresolvable prefix (name too long, symlink loop) is
    422, and an unknown path is 404."""
    sess = get_session_or_404(gw_id)
    bad = _reject_prefix(prefix)
    if bad:
        raise HTTPException(422, bad)
    parts = [p for p in prefix.split("/") if p not in ("", ".")]
    entries: list[dict] = []
    try:
        cwd_real = os.path.realpath(sess.cwd)
        target = os.path.realpath(os.path.join(cwd_real, *parts)) if parts else cwd_real
        # is_relative_to also covers cwd == "/" (a startswith(cwd + os.sep)
        # test builds "//" there and rejects every child).
        if not Path(target).is_relative_to(Path(cwd_real)):
            raise HTTPException(403, "path escapes the session directory")
        rel_prefix = "/".join(parts)
        for de in os.scandir(target):
            if de.name.startswith("."):
                continue
            try:
                is_dir = de.is_dir()
                size = None if is_dir else de.stat().st_size
            except OSError:
                continue  # vanished (or dangling link) mid-scan; skip, don't 500
            entries.append({
                "name": de.name,
                "path": f"{rel_prefix}/{de.name}" if rel_prefix else de.name,
                "isDir": is_dir,
                "size": size,
            })
    except FileNotFoundError:
        raise HTTPException(404, "no such directory") from None
    except NotADirectoryError:
        raise HTTPException(422, "prefix is not a directory") from None
    except PermissionError:
        raise HTTPException(403, "directory is not readable") from None
    except OSError:
        # ENAMETOOLONG, ELOOP and friends: the prefix cannot be resolved or
        # listed on this filesystem, never a 500.
        raise HTTPException(422, "directory cannot be listed") from None
    entries.sort(key=lambda e: (not e["isDir"], e["name"]))
    return {"entries": entries[:MAX_FILE_ENTRIES]}


@app.get("/api/sessions/{gw_id}/subagents")
async def subagents(gw_id: str):
    """Registry snapshot for the subagent panel. Empty until omp spawns one."""
    return await get_session_or_404(gw_id).command("get_subagents", timeout=30)


@app.get("/api/sessions/{gw_id}/subagents/{sub_id}/messages")
async def subagent_messages(gw_id: str, sub_id: str, from_: int | None = Query(None, alias="from", ge=0)):
    """Read-only transcript of one subagent, incremental via nextByte.

    Unknown subagent ids surface as an omp RpcError, which the handler maps to 400.
    """
    data = await get_session_or_404(gw_id).command(
        "get_subagent_messages", subagentId=sub_id, timeout=30,
        **({"fromByte": from_} if from_ is not None else {}))
    if not isinstance(data, dict):
        data = {}
    msgs = data.get("messages")
    if msgs is None:
        msgs = data.get("entries") or []
    return {"messages": msgs, "nextByte": data.get("nextByte"),
            "reset": bool(data.get("reset")), "sessionFile": data.get("sessionFile")}


@app.post("/api/sessions/{gw_id}/model")
async def set_model(gw_id: str, request: Request):
    body = await json_body(request)
    provider, model_id = body.get("provider"), body.get("modelId")
    if not provider or not model_id:
        raise HTTPException(422, "provider and modelId required")
    return {"data": await get_session_or_404(gw_id).command(
        "set_model", provider=provider, modelId=model_id, timeout=30)}


@app.post("/api/sessions/{gw_id}/thinking")
async def set_thinking(gw_id: str, request: Request):
    body = await json_body(request)
    if body.get("level") not in THINKING_LEVELS:
        raise HTTPException(422, "invalid thinking level")
    return {"data": await get_session_or_404(gw_id).command(
        "set_thinking_level", level=body["level"], timeout=15)}


@app.post("/api/sessions/{gw_id}/name")
async def set_name(gw_id: str, request: Request):
    body = await json_body(request)
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(422, "name required")
    sess = get_session_or_404(gw_id)
    data = await sess.command("set_session_name", name=name[:200], timeout=15)
    sess.omp_session_name = name[:200]
    return {"data": data}


@app.get("/api/sessions/{gw_id}/models")
async def available_models(gw_id: str):
    return {"data": await get_session_or_404(gw_id).command("get_available_models", timeout=60)}


@app.get("/api/sessions/{gw_id}/commands")
async def available_commands(gw_id: str):
    return {"data": await get_session_or_404(gw_id).command("get_available_commands", timeout=30)}


@app.get("/api/sessions/{gw_id}/stats")
async def session_stats(gw_id: str):
    return {"data": await get_session_or_404(gw_id).command("get_session_stats", timeout=30)}


@app.post("/api/sessions/{gw_id}/rpc")
async def raw_rpc(gw_id: str, request: Request):
    """Escape hatch: any RpcCommand from docs/rpc.md, correlated and returned.
    Keeps clients at full protocol coverage without a gateway release."""
    body = await json_body(request)
    ctype = body.pop("type", None)
    if not isinstance(ctype, str) or not ctype:
        raise HTTPException(422, "type required")
    body.pop("id", None)
    timeout = float(body.pop("timeout", 60))
    try:
        params = _command_params(body)
    except ValueError as e:
        raise HTTPException(422, str(e))
    try:
        return {"data": await get_session_or_404(gw_id).command(ctype, timeout=min(timeout, 300), **params)}
    except TypeError as e:
        # A param that collides with command()'s own signature is a client bug,
        # not a gateway failure.
        raise HTTPException(422, str(e))


@app.get("/api/sessions/{gw_id}/ui")
async def ui_pending(gw_id: str):
    """Dialogs omp is blocked on (tool approvals in always-ask mode, ask-tool
    questions, extension prompts). Each is an extension_ui_request from
    docs/rpc.md."""
    return {"pending": list(get_session_or_404(gw_id).pending_ui.values())}


@app.post("/api/sessions/{gw_id}/ui/{request_id}")
async def ui_answer(gw_id: str, request_id: str, request: Request):
    """Answer a pending dialog with {value}, {confirmed} or {cancelled: true}.
    Tool approvals are selects: {"value": "Approve"} or {"value": "Deny"}.
    409 if another client already answered it."""
    body = await json_body(request)
    try:
        return {"ok": True, "sent": await get_session_or_404(gw_id).answer_ui(request_id, body)}
    except KeyError:
        raise HTTPException(409, "not pending (already answered, or the turn ended)")
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.get("/api/sessions/{gw_id}/events")
async def events(gw_id: str, after: int = 0):
    sess = get_session_or_404(gw_id)
    return {"events": [{"seq": s, "event": e} for s, e in sess.backlog_since(after)],
            "lastSeq": sess.last_seq, "gap": sess.has_gap(after)}


# ----------------------------------------------------------------- websocket

@app.websocket("/omp-ws/{gw_id}")
async def ws_session(ws: WebSocket, gw_id: str, after: int = 0):
    """Live event stream for one session.

    Auth, first match wins: Authorization header (native clients), session
    cookie with a same-origin Origin (dashboard), or a first message
    {"type":"auth","token":"..."} within 10s (browsers on other origins).

    Server frames: {"seq": n, "event": {...}}; seq=0 frames are gateway
    control messages (auth_ok, heartbeat, ws_error, rpc_response).
    Client frames: {"type":"auth",...}, "ping", or any raw RpcCommand /
    extension_ui_response object, forwarded to omp.
    """
    ip = client_ip(ws.headers, _peer(ws))
    if limiter.locked(ip):
        await ws.close(code=4429)
        return

    authed = tokens.check(bearer(ws.headers))
    if not authed and tokens.check_cookie(ws.cookies.get(COOKIE_NAME)):
        authed = origin_allowed(ws.headers.get("origin"), ws.headers.get("host"), EXTRA_ORIGINS)

    await ws.accept()
    if not authed:
        try:
            first = await asyncio.wait_for(ws.receive_text(), WS_AUTH_TIMEOUT_SEC)
            msg = json.loads(first)
            authed = msg.get("type") == "auth" and tokens.check(msg.get("token"))
        except (asyncio.TimeoutError, json.JSONDecodeError, AttributeError, WebSocketDisconnect):
            authed = False
        if not authed:
            limiter.fail(ip)
            with contextlib.suppress(Exception):
                await ws.close(code=4401)
            return
    limiter.succeed(ip)

    try:
        sess = get_manager().get(gw_id)
    except KeyError:
        await ws.close(code=4404)
        return

    q = sess.subscribe()
    last_sent = max(0, after)
    sender_lock = asyncio.Lock()

    async def send(obj: dict) -> None:
        async with sender_lock:
            await ws.send_json(obj)

    async def pump_out() -> None:
        nonlocal last_sent
        gap = sess.has_gap(last_sent)
        replay = sess.backlog_since(last_sent)
        await send({"seq": 0, "event": {"type": "auth_ok", "session": sess.info(), "gap": gap}})
        for seq, event in replay:
            await send({"seq": seq, "event": event})
            last_sent = seq
        while True:
            try:
                seq, event = await asyncio.wait_for(q.get(), WS_HEARTBEAT_SEC)
            except asyncio.TimeoutError:
                if q not in sess.subscribers:
                    # dropped as a slow consumer; client resumes with ?after=lastSeq
                    await ws.close(code=4408)
                    return
                await send({"seq": 0, "event": {"type": "heartbeat", "lastSeq": last_sent}})
                continue
            if seq <= last_sent:        # already delivered via backlog
                continue
            await send({"seq": seq, "event": event})
            last_sent = seq

    async def pump_in() -> None:
        while True:
            raw = await ws.receive_text()
            if raw in ("ping", ""):
                await send({"seq": 0, "event": {"type": "pong", "lastSeq": last_sent}})
                continue
            try:
                frame = json.loads(raw)
                if not isinstance(frame, dict) or not frame.get("type"):
                    raise ValueError("frame must be an object with a type")
            except (json.JSONDecodeError, ValueError) as e:
                await send({"seq": 0, "event": {"type": "ws_error", "error": str(e)}})
                continue
            if frame["type"] == "auth":
                continue
            sess.touch()
            if frame["type"] == "extension_ui_response":
                try:
                    await sess.answer_ui(str(frame.get("id")), frame)
                except KeyError:
                    await send({"seq": 0, "event": {"type": "ws_error", "error": "ui request is not pending (already answered?)",
                                                    "id": frame.get("id")}})
                except ValueError as e:
                    await send({"seq": 0, "event": {"type": "ws_error", "error": str(e), "id": frame.get("id")}})
                continue
            if frame["type"] in ("host_tool_result", "host_tool_update", "host_uri_result"):
                await sess.send_raw(frame)
                continue
            client_id = frame.pop("id", None)
            ctype = frame.pop("type")
            try:
                params = _command_params(frame)
            except ValueError as e:
                await send({"seq": 0, "event": {"type": "rpc_response", "id": client_id,
                                                "command": ctype, "success": False,
                                                "error": str(e)}})
                continue
            try:
                data = await sess.command(ctype, timeout=60, **params)
                await send({"seq": 0, "event": {"type": "rpc_response", "id": client_id,
                                                "command": ctype, "success": True, "data": data}})
            except (RpcError, ProcessDead, TypeError) as e:
                await send({"seq": 0, "event": {"type": "rpc_response", "id": client_id,
                                                "command": ctype, "success": False,
                                                "error": str(e)}})

    out_task = asyncio.create_task(pump_out())
    in_task = asyncio.create_task(pump_in())
    try:
        await asyncio.wait({out_task, in_task}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in (out_task, in_task):
            t.cancel()
        sess.unsubscribe(q)
        with contextlib.suppress(Exception):
            await ws.close()


# ------------------------------------------------------------- idle reaping

async def _reaper() -> None:
    while True:
        await asyncio.sleep(300)
        m = get_manager()
        await m.reap_dead()
        now = time.time()
        for gid, s in list(m.sessions.items()):
            if s.subscribers or s.is_busy():
                continue
            if now - s.last_activity > IDLE_REAP_SEC:
                with contextlib.suppress(Exception):
                    await m.stop(gid)


@app.on_event("startup")
async def _startup() -> None:
    # Create the usage ledger (schema v1) on start; a broken path must not
    # keep the gateway from booting.
    with contextlib.suppress(Exception):
        get_ledger()
    app.state.reaper = asyncio.create_task(_reaper())


@app.on_event("shutdown")
async def _shutdown() -> None:
    await get_manager().shutdown_all()
    # Close the ledger last; a later get_ledger() reconnects instead of
    # writing through a closed connection.
    with contextlib.suppress(Exception):
        close_ledger()


# ------------------------------------------------------------------- static

NO_CACHE = {"Cache-Control": "no-cache"}
# Cloudflare edge-caches .js by default and rewrites browser TTLs; no-store plus its CDN headers stops that.
NO_STORE = {"Cache-Control": "no-store", "CDN-Cache-Control": "no-store", "Cloudflare-CDN-Cache-Control": "no-store"}
IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}


@app.get("/")
async def index():
    if web_dist_ready():
        return FileResponse(WEB_DIST / "index.html", headers=NO_CACHE)
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/classic")
async def classic():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/assets/{rel:path}")
async def web_asset(rel: str):
    p = dist_asset(rel)
    if p is None:
        raise HTTPException(404, "not found")
    return FileResponse(p, headers=IMMUTABLE)


@app.get("/manifest.webmanifest")
async def manifest():
    p = dist_root_file("manifest.webmanifest")
    if p is not None:
        return FileResponse(p, media_type="application/manifest+json", headers=NO_CACHE)
    return JSONResponse({
        "name": "ohmypi", "short_name": "omp", "start_url": "/", "display": "standalone",
        "background_color": "#0d1117", "theme_color": "#0d1117",
        "icons": [{"src": "/static/icon.svg", "sizes": "any", "type": "image/svg+xml"}],
    }, media_type="application/manifest+json")


@app.get("/{name}")
async def web_root_file(name: str):
    """Root-level files of the web build (sw.js, icons, favicon). Must stay the
    last route so it never shadows an API path."""
    p = dist_root_file(name)
    if p is None:
        raise HTTPException(404, "not found")
    if name in ("sw.js", "sw-routing.js"):
        return FileResponse(p, media_type="text/javascript", headers=NO_STORE)
    return FileResponse(p, headers={"Cache-Control": "public, max-age=3600"})


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
