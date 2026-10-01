"""Async bridge to the oh-my-pi (omp) RPC protocol.

Speaks newline-delimited JSON over stdio with `omp --mode rpc`.
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

from .ledger import record_turn, split_model_id

log = logging.getLogger("ohmpi-gateway.bridge")

OMP_BIN = os.path.expanduser("~/.bun/bin/omp")
# Resolved once: omp reports symlink-free paths (/home -> /var/home on Fedora
# Atomic), so every session file path the gateway emits or compares is canonical.
OMP_AGENT_DIR = Path(os.path.expanduser("~/.omp/agent")).resolve()

APPROVAL_MODES = ("yolo", "write", "always-ask")
DEFAULT_APPROVAL_MODE = os.environ.get("OMPGW_DEFAULT_APPROVAL", "yolo")
if DEFAULT_APPROVAL_MODE not in APPROVAL_MODES:
    raise SystemExit(f"OMPGW_DEFAULT_APPROVAL must be one of {APPROVAL_MODES}")



# extension_ui_request methods that block omp until answered. The rest
# (notify, setStatus, setWidget, setTitle, set_editor_text) are fire-and-forget.
UI_DIALOG_METHODS = frozenset({"select", "confirm", "input", "editor"})

STDOUT_LINE_LIMIT = 64 * 1024 * 1024  # bytes per stdout line from omp
_MAX_CHUNK_GROUPS = 64  # unfinished rpc_chunk reassembly buffers before eviction

# prompt_result statuses that mark a turn failed or aborted (ok = 0 in the ledger).
_TURN_FAILURE_STATUSES = ("error", "failed", "aborted")
# omp emits agent_end BEFORE prompt_result, so the ledger row waits for
# prompt_result (it carries the turn's final status). If prompt_result never
# arrives, this timer writes the row so the turn is not lost.
_LEDGER_PROMPT_GRACE_S = 30.0

def canonical_path(p: str | os.PathLike | None) -> str | None:
    if not p:
        return None
    return str(Path(p).expanduser().resolve())


def _cwd_from_lines(lines) -> str | None:
    """cwd of the first {"type":"session"} line among the first ~20 lines."""
    for i, line in enumerate(lines):
        if i >= 20:
            break
        if '"session"' not in line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and obj.get("type") == "session":
            cwd = obj.get("cwd")
            return cwd if isinstance(cwd, str) and cwd else None
    return None


def read_session_cwd(path: str | os.PathLike) -> str | None:
    """Working directory a saved omp session was recorded in, or None."""
    try:
        with open(path, "rb") as fh:
            head = [fh.readline(1 << 20).decode("utf-8", "replace") for _ in range(20)]
    except OSError:
        return None
    return _cwd_from_lines(head)


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
        advisor: bool = False,
    ):
        self.gw_id = uuid.uuid4().hex[:12]
        self.cwd = str(Path(cwd).expanduser().resolve())
        self.requested_model = model
        self.requested_thinking = thinking
        self.approval_mode = approval_mode
        self.advisor = bool(advisor)
        self.resume_session_file = canonical_path(session_file)

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
        self._omp_session_file: str | None = self.resume_session_file
        self.omp_session_id: str | None = None
        self.omp_session_name: str | None = None
        self.model: dict | None = None
        self.thinking_level: str | None = None
        self.last_state: dict | None = None

        self._turn_waiters: list[asyncio.Future] = []
        # Usage ledger: usage is reported per assistant message, a tool loop is
        # several messages but ONE turn. omp emits agent_end BEFORE
        # prompt_result, so the row is flushed at prompt_result (which carries
        # the final status); agent_end only pre-computes the accumulator and
        # arms the fallback timer.
        self._turn_acc: dict | None = None
        self._turn_failed = False
        self._turn_flushed = False
        self._turn_flush_timer: asyncio.TimerHandle | None = None
        self._negotiation: asyncio.Task | None = None
        # Keep a reference: asyncio only keeps weak refs to tasks, an unreferenced
        # one can be garbage-collected mid-flight.
        self._subagent_sub: asyncio.Task | None = None
        # Dialog-style extension UI requests (tool approvals, questions) omp is
        # blocked on. Tracked so late-joining and REST-only clients can see and
        # answer them. First answer wins.
        self.pending_ui: dict[str, dict] = {}
        # Dialog ids already web-pushed (one push per dialog, wherever it leaves pending_ui).
        self._pushed_dialogs: set[str] = set()

        self.proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        self._stderr_path = OMP_AGENT_DIR / "gateway-logs" / f"{self.gw_id}.stderr.log"

    @property
    def omp_session_file(self) -> str | None:
        return self._omp_session_file

    @omp_session_file.setter
    def omp_session_file(self, value: str | None) -> None:
        self._omp_session_file = canonical_path(value)

    # --- start

    async def _negotiate_v2(self) -> None:
        try:
            data = await self.command("negotiate_protocol", protocolVersion=2, timeout=15)
            if isinstance(data, dict) and data.get("protocolVersion") == 2:
                self.protocol_version = 2
                # The subagent panel needs progress frames and omp defaults the
                # subscription to off. Fire and forget on its own task: older omp
                # builds reject the command and should keep working either way.
                self._subagent_sub = asyncio.get_running_loop().create_task(
                    self._subscribe_subagents())
        except (RpcError, ProcessDead):
            log.warning("[%s] v2 negotiation failed, staying on v1", self.gw_id)

    async def _subscribe_subagents(self) -> None:
        """progress level: lifecycle + current tool + tokens/cost, no text deltas."""
        try:
            await self.command("set_subagent_subscription", level="progress", timeout=15)
        except (RpcError, ProcessDead) as e:
            log.info("[%s] subagent subscription unavailable: %s", self.gw_id, e)

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
        if self.advisor:
            # Launch-time only in omp (no mid-session RPC toggle): the flag is
            # set at spawn and carried through forks/resumes.
            args += ["--advisor"]
        return args

    async def start(self, startup_timeout: float = 60.0) -> None:
        self._stderr_path.parent.mkdir(parents=True, exist_ok=True)
        stderr_fh = open(self._stderr_path, "ab")
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *self._build_args(),
                cwd=self.cwd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=stderr_fh,
                # omp writes one JSON object per line and some (the model catalog,
                # big tool results) exceed asyncio's 64 KiB default; overrunning it
                # crashes the reader and the session looks dead.
                limit=STDOUT_LINE_LIMIT,
            )
        except BaseException:
            stderr_fh.close()
            raise
        # The child keeps its own dup of the fd; holding the parent handle open
        # for the session's life leaks one fd per spawn attempt.
        stderr_fh.close()
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
        if ftype == "agent_start":
            self.streaming = True
            self._turn_reset()
        elif ftype == "extension_ui_request" and obj.get("method") in UI_DIALOG_METHODS:
            self.pending_ui[obj["id"]] = obj
            self._maybe_push_dialog(obj)
        elif ftype == "message_end":
            msg = obj.get("message")
            if isinstance(msg, dict):
                self._turn_accumulate(msg)
        elif ftype == "prompt_result":
            if obj.get("status") in _TURN_FAILURE_STATUSES:
                self._turn_failed = True
            # prompt_result carries the turn's final status and follows
            # agent_end, so this is where the ledger row is written. acc is
            # None when no turn is open (stray event) or agent_end never ran;
            # either way there is nothing to record.
            if not self._turn_flushed and self._turn_acc is not None:
                await self._ledger_flush()
        elif ftype == "agent_end":
            self.streaming = False
            if not self._turn_flushed:
                if self._turn_acc is None:
                    # Builds that never send per-message usage: fall back to
                    # the message list agent_end carries, so prompt_result can
                    # flush a complete row (it has no messages itself).
                    self._turn_acc = {"input": 0, "output": 0, "cache_read": 0,
                                      "cache_write": 0, "cost": 0.0, "model": None}
                    for m in obj.get("messages") or []:
                        if isinstance(m, dict):
                            self._turn_accumulate(m)
                # The row waits for prompt_result; the timer is the fallback
                # if it never arrives.
                self._turn_flush_timer = asyncio.get_running_loop().call_later(
                    _LEDGER_PROMPT_GRACE_S, self._ledger_flush_soon)
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
            if len(self._chunks) >= _MAX_CHUNK_GROUPS:
                # A chunk dropped mid-frame leaves its group unfinished forever
                # (parts are megabyte-scale base64); evict the oldest instead of
                # growing without bound over a long-lived session.
                self._chunks.pop(next(iter(self._chunks)), None)
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

    # ----------------------------------------------------------- usage ledger

    def _turn_reset(self) -> None:
        """Start a fresh turn: drop any state (and fallback timer) a previous
        turn left behind."""
        self._cancel_flush_timer()
        self._turn_acc = None
        self._turn_failed = False
        self._turn_flushed = False

    def _turn_accumulate(self, msg: dict) -> None:
        """Sum one message's usage into the open turn. Ignores user echoes and
        messages without usage; missing fields just contribute zero. Never
        raises: a malformed frame must not kill the session reader."""
        try:
            self._turn_sum(msg)
        except Exception:
            log.exception("[%s] usage accumulate failed", self.gw_id)

    def _turn_sum(self, msg: dict) -> None:
        usage = msg.get("usage")
        if not isinstance(usage, dict):
            return
        acc = self._turn_acc
        if acc is None:
            acc = self._turn_acc = {"input": 0, "output": 0, "cache_read": 0,
                                    "cache_write": 0, "cost": 0.0, "model": None}

        def num(key: str) -> float:
            v = usage.get(key)
            return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0

        acc["input"] += int(num("input"))
        acc["output"] += int(num("output"))
        acc["cache_read"] += int(num("cacheRead"))
        acc["cache_write"] += int(num("cacheWrite"))
        cost = usage.get("cost")
        if isinstance(cost, dict):
            total = cost.get("total")
            if isinstance(total, (int, float)) and not isinstance(total, bool):
                acc["cost"] += total
        if acc["model"] is None and isinstance(msg.get("model"), str) and msg["model"]:
            acc["model"] = msg["model"]

    def _cancel_flush_timer(self) -> None:
        if self._turn_flush_timer is not None:
            self._turn_flush_timer.cancel()
            self._turn_flush_timer = None

    def _ledger_flush_soon(self) -> None:
        """Schedule the flush as a task: safe from call_later timers and from
        non-async exit paths, and the write itself runs in a thread."""
        try:
            asyncio.get_running_loop().create_task(self._ledger_flush())
        except RuntimeError:
            pass  # no loop left (interpreter shutdown); the row is lost, accepted

    async def _ledger_flush(self) -> None:
        """Write the finished turn as ONE row. Never raises, never blocks a turn.

        The SQLite write runs in a worker thread: this is called from the stdout
        reader's dispatch path, which must never do synchronous disk I/O."""
        self._cancel_flush_timer()
        if self._turn_flushed:
            return
        self._turn_flushed = True
        try:
            acc = self._turn_acc or {"input": 0, "output": 0, "cache_read": 0,
                                     "cache_write": 0, "cost": 0.0, "model": None}
            provider, model = split_model_id(acc.get("model"))
            await asyncio.to_thread(
                record_turn,
                gw_id=self.gw_id, session_name=self.omp_session_name, cwd=self.cwd,
                provider=provider, model=model,
                input_tokens=acc["input"], output_tokens=acc["output"],
                cache_read=acc["cache_read"], cache_write=acc["cache_write"],
                cost_usd=acc["cost"], ok=not self._turn_failed)
        except Exception:
            log.exception("[%s] ledger flush failed", self.gw_id)
        finally:
            self._turn_acc = None
            self._turn_failed = False

    # ----------------------------------------------------------------- writes

    def _maybe_push_dialog(self, obj: dict) -> None:
        """Web Push for "needs you": when a blocking dialog appears and NO
        WebSocket is subscribed to this session, someone left a turn running
        unattended. One push per dialog id; cleared wherever the dialog leaves
        pending_ui. Best effort: never raises, never delays dispatch."""
        if self.subscribers or str(obj.get("id")) in self._pushed_dialogs:
            return
        from . import push as push_mod
        if not push_mod.available():
            return
        self._pushed_dialogs.add(str(obj.get("id")))
        task = asyncio.get_running_loop().create_task(
            push_mod.push_dialog(self.gw_id, self.omp_session_name, obj))
        task.add_done_callback(self._log_push_error)

    @staticmethod
    def _log_push_error(task: asyncio.Task) -> None:
        if not task.cancelled() and task.exception() is not None:
            log.warning("push_dialog task failed", exc_info=task.exception())

    async def answer_ui(self, request_id: str, response: dict) -> dict:
        """Answer a pending dialog. Raises KeyError if it is not pending
        (already answered by another client, or never existed)."""
        req = self.pending_ui.pop(request_id)
        self._pushed_dialogs.discard(request_id)
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
            self._pushed_dialogs.discard(request_id)
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
            try:
                await asyncio.wait_for(late_fut, 0.25)
            except asyncio.TimeoutError:
                pass
            except RpcError as e:
                # The ack already went out, so the caller can't get an error
                # from here; log it so late failures aren't invisible.
                log.warning("[%s] late error for %s: %s", self.gw_id, type_, e)
            finally:
                # Keep the late: key in self.pending for the WHOLE wait window:
                # _dispatch correlates the late error through it, so popping
                # early (the old shape) made every late response a drop.
                self.pending.pop(f"late:{rid}", None)
        if not resp.get("success"):
            raise RpcError(resp.get("command", type_), resp.get("error", "unknown"), resp.get("code"))
        return resp.get("data")

    # ------------------------------------------------------------- high level

    async def prompt(self, message: str, wait: bool = False, steer: bool = False,
                     timeout: float = 600.0, images: list[dict] | None = None) -> dict:
        """Send a prompt. wait=True resolves when the agent turn ends."""
        cmd = "steer" if steer else "prompt"
        extra = {"images": images} if images else {}
        # late_errors: a same-id error response can arrive after the ack (omp
        # accepts the prompt, then fails to start the turn). Without this the
        # error finds no pending future and is discarded with nothing in the
        # log; the turn failure itself still surfaces via prompt_result events,
        # which is what the client Retry chip keys on.
        data = await self.command(cmd, message=message, timeout=30, late_errors=True, **extra)
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
        """Full message list via the paged endpoint.

        omp refuses get_messages_page while a turn streams or compacts
        (code session_busy) and when the list changes between pages
        (stale_cursor). Like omp's own RpcClient, drop the partial pages and
        fall back to the unpaged get_messages, so opening a busy session
        works instead of failing with "Cannot page messages while the
        session is changing".
        """
        out: list = []
        cursor: str | None = None
        try:
            for _ in range(50):  # hard cap; 50 pages * 256 msgs
                params: dict = {"limit": min(limit, 256)}
                if cursor:
                    params["cursor"] = cursor
                data = await self.command("get_messages_page", timeout=30, **params)
                out.extend(data.get("messages") or [])
                cursor = data.get("nextCursor")
                if not cursor:
                    break
        except RpcError as exc:
            if exc.code not in ("session_busy", "stale_cursor"):
                raise
            data = await self.command("get_messages", timeout=30)
            out = list((data or {}).get("messages") or [])
        return {"messages": out, "totalMessages": len(out)}

    async def entries(self) -> dict:
        """Raw session-file entries via get_entries: {entries, leafId}. Entry ids
        are the fork targets; only user message entries branch (omp rejects the
        rest with "Invalid entry ID for branching")."""
        data = await self.command("get_entries", timeout=30)
        return data if isinstance(data, dict) else {}

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

    def has_gap(self, after: int) -> bool:
        """True when events after `after` were dropped from the backlog."""
        return after > 0 and bool(self.backlog) and self.backlog[0][0] > after + 1

    # ------------------------------------------------------------------- stop

    def _on_exit(self) -> None:
        self.exited = True
        if self.proc is not None:
            self.exit_code = self.proc.returncode
        # A dead child can still have a finished-but-unflushed turn: write the
        # row instead of dropping it. If agent_end never ran (crash mid-turn)
        # the partial accumulator is real usage but the turn did not complete,
        # so it is recorded as a failure, never a silent ok.
        if not self._turn_flushed and self._turn_acc is not None:
            if self._turn_flush_timer is None:  # agent_end never ran
                self._turn_failed = True
            self._ledger_flush_soon()
        else:
            self._cancel_flush_timer()
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
            "advisor": self.advisor,
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
                     session_file: str | None = None,
                     advisor: bool = False) -> OmpSession:
        if not Path(OMP_BIN).exists():
            raise RpcError("create", f"omp binary not found at {OMP_BIN}")
        if not Path(cwd).expanduser().is_dir():
            raise RpcError("create", f"cwd does not exist: {cwd}")
        sess = OmpSession(cwd=cwd, model=model, thinking=thinking,
                          approval_mode=approval_mode, session_file=session_file,
                          advisor=advisor)
        await sess.start()
        self.sessions[sess.gw_id] = sess
        with contextlib.suppress(Exception):
            await sess.get_state()
        return sess

    def find_by_file(self, session_file: str) -> OmpSession | None:
        want = canonical_path(session_file)
        for s in self.sessions.values():
            if not s.exited and s.omp_session_file == want:
                return s
        return None

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


def _safe_stat(p: Path) -> os.stat_result | None:
    """stat that survives a file vanishing mid-scan (omp gc runs concurrently)."""
    try:
        return p.stat()
    except OSError:
        return None


def scan_saved_sessions(limit: int = 200) -> list[dict]:
    """Saved omp sessions on disk, newest first, with a light title parse."""
    results: list[dict] = []
    root = OMP_AGENT_DIR / "sessions"
    if not root.is_dir():
        return results
    stats: list[tuple[Path, os.stat_result]] = []
    for p in root.rglob("*.jsonl"):
        st = _safe_stat(p)
        if st is not None:
            stats.append((p, st))
    stats.sort(key=lambda t: t[1].st_mtime, reverse=True)
    live_files = {s.omp_session_file for s in _manager.sessions.values() if s.omp_session_file}
    for p, st in stats[:limit]:
        p = p.resolve()
        entry = {
            "file": str(p),
            "mtime": st.st_mtime,
            "sizeBytes": st.st_size,
            "cwdFolder": p.parent.name,
            "cwd": None,
            "cwdExists": None,
            # '' rather than None: sessions with no prompt snippet have no title,
            # and a null here crashes every client that trims it.
            "title": "",
            "running": str(p) in live_files,
        }
        # parse head for a user snippet as the title
        try:
            with open(p, "rb") as fh:
                head = fh.read(256 * 1024).decode("utf-8", "replace")
            lines = head.splitlines()
            entry["cwd"] = _cwd_from_lines(lines)
            if entry["cwd"]:
                # Clients offer recent cwds as one-tap folder picks; a folder
                # deleted since (e2e temp dirs, removed checkouts) must not be
                # offered. Only the gateway can see the filesystem.
                entry["cwdExists"] = os.path.isdir(os.path.expanduser(entry["cwd"]))
            for line in lines:
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
