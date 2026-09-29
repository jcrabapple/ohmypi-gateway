"""Async bridge to the oh-my-pi (omp) RPC protocol.

Speaks newline-delimited JSON over stdio with `omp --mode rpc --no-ui`.
Handles: request correlation by id, protocol v2 negotiation with rpc_chunk
reassembly, event fan-out to subscribers, and a replay backlog for late
subscribers.

Protocol reference: https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md
"""

from __future__ import annotations

import asyncio
import base64
import collections
import contextlib
import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator

log = logging.getLogger("ohmpi-gateway.bridge")

OMP_BIN = os.path.expanduser("~/.bun/bin/omp")
OMP_AGENT_DIR = Path(os.path.expanduser("~/.omp/agent"))

APPROVAL_MODES = ("yolo", "write", "always-ask")
DEFAULT_APPROVAL_MODE = os.environ.get("OMPGW_DEFAULT_APPROVAL", "yolo")
if DEFAULT_APPROVAL_MODE not in APPROVAL_MODES:
    raise SystemExit(f"OMPGW_DEFAULT_APPROVAL must be one of {APPROVAL_MODES}")



# extension_ui_request methods that block omp until answered. The rest
# (notify, setStatus, setWidget, setTitle, set_editor_text) are fire-and-forget.
UI_DIALOG_METHODS = frozenset({"select", "confirm", "input", "editor"})

class RpcError(Exception):
    """A command failed at the omp layer (success: false)."""

    def __init__(self, command: str, error: str, code: str | None = None):
        self.command = command
        self.error = error
        self.code = code
        super().__init__(f"{command}: {error}")


class ProcessDead(Exception):
    pass


class OmpSession:
    """One live omp child process, addressable over RPC."""

    def __init__(
        self,
        cwd: str,
        model: str | None = None,
        thinking: str | None = None,
        approval_mode: str = DEFAULT_APPROVAL_MODE,
        session_file: str | None = None,
    ):
        self.gw_id = uuid.uuid4().hex[:12]
        self.cwd = str(Path(cwd).expanduser().resolve())
        self.requested_model = model
        self.requested_thinking = thinking
        self.approval_mode = approval_mode
        self.resume_session_file = session_file

        self.created_at = time.time()
        self.exited = False
        self.exit_code: int | None = None

        self.protocol_version = 1
        self.max_frame_bytes = 1_048_576
        self.ready = asyncio.get_running_loop().create_future()

        self.pending: dict[str, asyncio.Future] = {}
        self._chunks: dict[str, dict] = {}
        self._next_id = 0
        self._stdin_lock = asyncio.Lock()

        self.subscribers: set[asyncio.Queue] = set()
        self.backlog: collections.deque[tuple[int, dict]] = collections.deque(maxlen=3000)
        self._backlog_seq = 0
        self.last_activity = time.time()
        self.streaming = False

        # Session metadata, filled from events / get_state.
        self.omp_session_file: str | None = session_file
        self.omp_session_id: str | None = None
        self.omp_session_name: str | None = None
        self.model: dict | None = None
        self.thinking_level: str | None = None
        self.last_state: dict | None = None

        self._turn_waiters: list[asyncio.Future] = []
        self._negotiation: asyncio.Task | None = None
        # Dialog-style extension UI requests (tool approvals, questions) omp is
        # blocked on. Tracked so late-joining and REST-only clients can see and
        # answer them. First answer wins.
        self.pending_ui: dict[str, dict] = {}

        self.proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        self._stderr_path = OMP_AGENT_DIR / "gateway-logs" / f"{self.gw_id}.stderr.log"

    # --- start

    async def _negotiate_v2(self) -> None:
        try:
            data = await self.command("negotiate_protocol", protocolVersion=2, timeout=15)
            if isinstance(data, dict) and data.get("protocolVersion") == 2:
                self.protocol_version = 2
        except (RpcError, ProcessDead):
            log.warning("[%s] v2 negotiation failed, staying on v1", self.gw_id)

    def _build_args(self) -> list[str]:
        # No --no-ui: the gateway is a real UI host. Dialogs (tool approvals in
        # write/always-ask, ask-tool questions) surface as pendingUi for clients
        # to answer; with --no-ui omp just fails approval-gated tool calls.
        args = [OMP_BIN, "--mode", "rpc", "--no-title",
                "--cwd", self.cwd, "--approval-mode", self.approval_mode]
        if self.resume_session_file:
            args += ["-r", self.resume_session_file]
        if self.requested_model:
            args += ["--model", self.requested_model]
        if self.requested_thinking:
            args += ["--thinking", self.requested_thinking]
        return args

    async def start(self, startup_timeout: float = 60.0) -> None:
        self._stderr_path.parent.mkdir(parents=True, exist_ok=True)
        stderr_fh = open(self._stderr_path, "ab")
        self.proc = await asyncio.create_subprocess_exec(
            *self._build_args(),
            cwd=self.cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr_fh,
        )
        self._reader_task = asyncio.create_task(self._reader(), name=f"omp-reader-{self.gw_id}")
        try:
            await asyncio.wait_for(self.ready, startup_timeout)
        except asyncio.TimeoutError:
            await self.stop()
            raise RpcError("start", f"omp did not signal ready within {startup_timeout}s")
        if self._negotiation is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._negotiation, 20)

    # ------------------------------------------------------------------ reads

    async def _reader(self) -> None:
        assert self.proc and self.proc.stdout
        try:
            while True:
                line = await self.proc.stdout.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    log.warning("[%s] undecodable frame dropped", self.gw_id)
                    continue
                await self._dispatch(obj)
        except Exception:
            if not self.exited:
                log.exception("[%s] reader crashed", self.gw_id)
        finally:
            self._on_exit()

    async def _dispatch(self, obj: dict) -> None:
        ftype = obj.get("type")

        if ftype == "rpc_chunk":
            reassembled = self._reassemble_chunk(obj)
            if reassembled is not None:
                await self._dispatch(reassembled)
            return

        if ftype == "ready":
            self.max_frame_bytes = obj.get("maxFrameBytes", self.max_frame_bytes)
            supported = obj.get("supportedProtocolVersions") or [obj.get("protocolVersion", 1)]
            if not self.ready.done():
                self.ready.set_result(True)
            if 2 in supported:
                # Never await commands inline in the reader loop: the response
                # can only be read by this same loop. Schedule instead; start()
                # awaits the task so callers see the final protocol version.
                self._negotiation = asyncio.get_running_loop().create_task(self._negotiate_v2())
            return

        if ftype == "response":
            rid = obj.get("id")
            fut = self.pending.get(rid) if rid else None
            if fut is not None and not fut.done():
                if obj.get("success"):
                    fut.set_result(obj)
                else:
                    fut.set_exception(RpcError(obj.get("command", "?"),
                                               obj.get("error", "unknown"),
                                               obj.get("code")))
            elif rid:
                # prompt can emit a same-id error response after its ack.
                fut = self.pending.get(f"late:{rid}")
                if fut is not None and not fut.done():
                    fut.set_exception(RpcError(obj.get("command", "?"),
                                               obj.get("error", "unknown"),
                                               obj.get("code")))
            return

        # Everything else is an event.
        if ftype == "session_info_update":
            info = obj.get("sessionInfo") or obj
            self.omp_session_file = info.get("sessionFile") or self.omp_session_file
            self.omp_session_id = info.get("sessionId") or self.omp_session_id
            self.omp_session_name = info.get("name") or info.get("sessionName") or self.omp_session_name
        elif ftype == "agent_start":
            self.streaming = True
        elif ftype == "extension_ui_request" and obj.get("method") in UI_DIALOG_METHODS:
            self.pending_ui[obj["id"]] = obj
        elif ftype == "agent_end":
            self.streaming = False
            if self.pending_ui:
                # omp abandons open dialogs when a turn ends (abort, error).
                for rid in list(self.pending_ui):
                    await self._resolve_ui_locally(rid, "turn ended")
            for w in list(self._turn_waiters):
                if not w.done():
                    w.set_result(True)
            self._turn_waiters.clear()

        await self._publish(obj)

    def _reassemble_chunk(self, obj: dict) -> dict | None:
        cid = obj.get("chunkId")
        buf = self._chunks.get(cid)
        if buf is None:
            buf = {
                "count": obj.get("count"),
                "byteLength": obj.get("byteLength"),
                "parts": {},
            }
            self._chunks[cid] = buf
        idx = obj.get("index")
        if idx in buf["parts"]:
            log.warning("[%s] duplicate chunk %s/%s", self.gw_id, cid, idx)
            return None
        buf["parts"][idx] = obj.get("data", "")
        if len(buf["parts"]) < buf["count"]:
            return None
        self._chunks.pop(cid, None)
        try:
            ordered = "".join(buf["parts"][i] for i in range(buf["count"]))
            raw = base64.b64decode(ordered)
            if len(raw) != buf["byteLength"]:
                raise ValueError(f"byteLength mismatch: {len(raw)} != {buf['byteLength']}")
            return json.loads(raw.decode("utf-8"))
        except Exception:
            log.exception("[%s] chunk reassembly failed for %s", self.gw_id, cid)
            return None

    async def _publish(self, event: dict) -> None:
        self.last_activity = time.time()
        self._backlog_seq += 1
        item = (self._backlog_seq, event)
        self.backlog.append(item)
        for q in list(self.subscribers):
            try:
                q.put_nowait(item)
            except asyncio.QueueFull:
                # Slow consumer: drop it; the client reconnects with ?after=seq.
                self.subscribers.discard(q)

    # ----------------------------------------------------------------- writes

    async def answer_ui(self, request_id: str, response: dict) -> dict:
        """Answer a pending dialog. Raises KeyError if it is not pending
        (already answered by another client, or never existed)."""
        req = self.pending_ui.pop(request_id)
        frame = {"type": "extension_ui_response", "id": request_id}
        for k in ("value", "confirmed", "cancelled"):
            if k in response:
                frame[k] = response[k]
        if len(frame) == 2:
            raise ValueError("response needs one of: value, confirmed, cancelled")
        opts = req.get("options")
        if "value" in frame and req.get("method") == "select" and opts and frame["value"] not in opts:
            self.pending_ui[request_id] = req
            raise ValueError(f"value must be one of {opts}")
        await self.send_raw(frame)
        await self._publish({"type": "ui_resolved", "id": request_id, "method": req.get("method"),
                             "response": {k: v for k, v in frame.items() if k not in ("type", "id")}})
        return frame

    async def _resolve_ui_locally(self, request_id: str, reason: str) -> None:
        if self.pending_ui.pop(request_id, None) is not None:
            await self._publish({"type": "ui_resolved", "id": request_id, "reason": reason})

    async def send_raw(self, frame: dict) -> None:
        if not self.proc or self.proc.stdin is None or self.proc.stdin.is_closing():
            raise ProcessDead(f"session {self.gw_id} is not running")
        data = (json.dumps(frame) + "\n").encode()
        async with self._stdin_lock:
            self.proc.stdin.write(data)
            await self.proc.stdin.drain()

    async def command(self, type_: str, timeout: float = 60.0, late_errors: bool = False,
                      **params: Any) -> Any:
        """Send an RpcCommand and await its correlated response.

        late_errors: also wait (same timeout budget) for a same-id error
        response that may arrive after the initial ack (prompt semantics).
        """
        self._next_id += 1
        rid = f"gw-{self._next_id}"
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        late_fut: asyncio.Future | None = None
        if late_errors:
            late_fut = asyncio.get_running_loop().create_future()
            self.pending[f"late:{rid}"] = late_fut
        await self.send_raw({"id": rid, "type": type_, **params})
        try:
            resp = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise RpcError(type_, f"timed out after {timeout}s")
        finally:
            self.pending.pop(rid, None)
        if late_errors:
            self.pending.pop(f"late:{rid}", None)
            try:
                await asyncio.wait_for(late_fut, 0.25)
            except (asyncio.TimeoutError, RpcError):
                pass
        if not resp.get("success"):
            raise RpcError(resp.get("command", type_), resp.get("error", "unknown"), resp.get("code"))
        return resp.get("data")

    # ------------------------------------------------------------- high level

    async def prompt(self, message: str, wait: bool = False, steer: bool = False,
                     timeout: float = 600.0) -> dict:
        """Send a prompt. wait=True resolves when the agent turn ends."""
        cmd = "steer" if steer else "prompt"
        data = await self.command(cmd, message=message, timeout=30)
        if wait:
            loop = asyncio.get_running_loop()
            waiter = loop.create_future()
            self._turn_waiters.append(waiter)
            try:
                await asyncio.wait_for(waiter, timeout)
            except asyncio.TimeoutError:
                with contextlib.suppress(ValueError):
                    self._turn_waiters.remove(waiter)
                raise RpcError(cmd, f"agent turn did not finish within {timeout}s")
        return data if isinstance(data, dict) else {}

    async def get_state(self) -> dict:
        state = await self.command("get_state", timeout=15)
        if isinstance(state, dict):
            self.last_state = state
            self.model = state.get("model") or self.model
            self.thinking_level = state.get("thinkingLevel") or self.thinking_level
            self.omp_session_file = state.get("sessionFile") or self.omp_session_file
            self.omp_session_id = state.get("sessionId") or self.omp_session_id
            self.omp_session_name = state.get("sessionName") or self.omp_session_name
        return state or {}

    async def messages(self, limit: int = 200) -> dict:
        """Full message list via the paged endpoint."""
        out: list = []
        cursor: str | None = None
        for _ in range(50):  # hard cap; 50 pages * 256 msgs
            params: dict = {"limit": min(limit, 256)}
            if cursor:
                params["cursor"] = cursor
            data = await self.command("get_messages_page", timeout=30, **params)
            out.extend(data.get("messages") or [])
            cursor = data.get("nextCursor")
            if not cursor:
                break
        return {"messages": out, "totalMessages": len(out)}

    async def last_assistant_text(self) -> str | None:
        data = await self.command("get_last_assistant_text", timeout=15)
        if isinstance(data, dict):
            return data.get("text") or data.get("assistantText")
        return data if isinstance(data, str) else None

    @property
    def last_seq(self) -> int:
        return self._backlog_seq

    def touch(self) -> None:
        self.last_activity = time.time()

    def is_busy(self) -> bool:
        st = self.last_state or {}
        return self.streaming or bool(st.get("isCompacting"))

    def subscribe(self, after_seq: int = 0) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=5000)
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)

    def backlog_since(self, seq: int) -> list[tuple[int, dict]]:
        return [item for item in self.backlog if item[0] > seq]

    # ------------------------------------------------------------------- stop

    def _on_exit(self) -> None:
        self.exited = True
        if self.proc is not None:
            self.exit_code = self.proc.returncode
        for fut in list(self.pending.values()):
            if not fut.done():
                fut.set_exception(ProcessDead(f"omp exited (code {self.exit_code})"))
        self.pending.clear()
        for w in self._turn_waiters:
            if not w.done():
                w.set_result(True)
        self._turn_waiters.clear()
        if not self.ready.done():
            self.ready.set_exception(ProcessDead("omp exited before ready"))
        log.info("[%s] omp exited code=%s", self.gw_id, self.exit_code)

    async def stop(self, grace: float = 5.0) -> None:
        if self.exited:
            return
        # 1. graceful: close stdin (omp exits 0 on stdin close), then wait a few s.
        with contextlib.suppress(Exception):
            if self.proc and self.proc.stdin and not self.proc.stdin.is_closing():
                self.proc.stdin.close()
                await self.proc.stdin.wait_closed()
        if self.proc is not None:
            try:
                await asyncio.wait_for(self.proc.wait(), grace)
            except asyncio.TimeoutError:
                pass
        # 2. SIGTERM, then SIGKILL escalation. Do not give up with a live child.
        if self.proc is not None and (self.exited is False or self.proc.returncode is None):
            with contextlib.suppress(ProcessLookupError):
                self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), 3)
            except asyncio.TimeoutError:
                if self.proc.returncode is None:
                    with contextlib.suppress(ProcessLookupError):
                        self.proc.kill()
                    await self.proc.wait()
        # drain the reader task so no late frames race a reaped process
        with contextlib.suppress(asyncio.TimeoutError):
            if self._reader_task is not None:
                await asyncio.wait_for(asyncio.shield(self._reader_task), 2)
        self._on_exit()

    # ------------------------------------------------------------------ meta

    def info(self) -> dict:
        st = self.last_state or {}
        return {
            "gwId": self.gw_id,
            "cwd": self.cwd,
            "approvalMode": self.approval_mode,
            "resumedFrom": self.resume_session_file,
            "ompSessionId": self.omp_session_id,
            "ompSessionFile": self.omp_session_file,
            "ompSessionName": self.omp_session_name,
            "model": self.model or self.requested_model,
            "thinkingLevel": self.thinking_level or self.requested_thinking,
            "isStreaming": self.streaming,
            "idleSec": round(time.time() - self.last_activity, 1),
            "exited": self.exited,
            "exitCode": self.exit_code,
            "protocolVersion": self.protocol_version,
            "uptimeSec": round(time.time() - self.created_at, 1),
            "subscribers": len(self.subscribers),
            "messageCount": st.get("messageCount"),
            "contextUsage": st.get("contextUsage"),
            "lastEventSeq": self._backlog_seq,
            "pendingUi": list(self.pending_ui.values()),
        }


class SessionManager:
    def __init__(self):
        self.sessions: dict[str, OmpSession] = {}

    async def create(self, cwd: str, model: str | None = None, thinking: str | None = None,
                     approval_mode: str = DEFAULT_APPROVAL_MODE,
                     session_file: str | None = None) -> OmpSession:
        if not Path(OMP_BIN).exists():
            raise RpcError("create", f"omp binary not found at {OMP_BIN}")
        if not Path(cwd).expanduser().is_dir():
            raise RpcError("create", f"cwd does not exist: {cwd}")
        sess = OmpSession(cwd=cwd, model=model, thinking=thinking,
                          approval_mode=approval_mode, session_file=session_file)
        await sess.start()
        self.sessions[sess.gw_id] = sess
        with contextlib.suppress(Exception):
            await sess.get_state()
        return sess

    def get(self, gw_id: str) -> OmpSession:
        sess = self.sessions.get(gw_id)
        if sess is None:
            raise KeyError(gw_id)
        return sess

    async def stop(self, gw_id: str) -> dict:
        sess = self.get(gw_id)
        await sess.stop()
        self.sessions.pop(gw_id, None)
        return {"stopped": gw_id}

    async def reap_dead(self) -> None:
        for gid, s in list(self.sessions.items()):
            if s.exited:
                self.sessions.pop(gid, None)

    def list_live(self) -> list[dict]:
        return [s.info() for s in self.sessions.values()]

    async def shutdown_all(self) -> None:
        for gid in list(self.sessions):
            with contextlib.suppress(Exception):
                await self.sessions[gid].stop()
            self.sessions.pop(gid, None)


def scan_saved_sessions(limit: int = 200) -> list[dict]:
    """Saved omp sessions on disk, newest first, with a light title parse."""
    results: list[dict] = []
    root = OMP_AGENT_DIR / "sessions"
    if not root.is_dir():
        return results
    files = sorted(root.rglob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    live_files = {s.omp_session_file for s in _manager.sessions.values() if s.omp_session_file}
    for p in files:
        entry = {
            "file": str(p),
            "mtime": p.stat().st_mtime,
            "sizeBytes": p.stat().st_size,
            "cwdFolder": p.parent.name,
            "title": None,
            "running": str(p) in live_files,
        }
        # parse head for a user snippet as the title
        try:
            with open(p, "rb") as fh:
                head = fh.read(256 * 1024).decode("utf-8", "replace")
            for line in head.splitlines():
                if not line.strip() or '"user"' not in line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = obj.get("message") or obj
                if msg.get("role") != "user":
                    continue
                content = msg.get("content")
                text = None
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict) and c.get("type") == "text":
                            text = c.get("text")
                            break
                if text and not text.startswith("<"):
                    entry["title"] = text.strip()[:120].replace("\n", " ")
                    break
        except OSError:
            pass
        results.append(entry)
    return results


# Single manager instance for the app.
_manager = SessionManager()


def get_manager() -> SessionManager:
    return _manager
