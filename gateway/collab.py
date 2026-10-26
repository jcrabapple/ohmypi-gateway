"""Read-only discovery of interactive omp collab hosts.

Stock omp (>= 18.1.20) publishes one entry per interactive session with
``collab.autoStart`` enabled: ``~/.omp/run/collab-hosts/<entryId>.json``
(mode 0600) plus a per-host unix socket. This module only READS that
directory: it never writes, renames, or unlinks entries, and the poller
never requests a link capability (that is the HTTP handler's job, per tap).

Each poll lists the entries, asks every host for a snapshot over its socket
(newline JSON, one request per connection), and reconciles an in-memory,
metadata-only registry with TTL liveness and ask-identity minting on the
``inputRequired`` false->true edge.
"""

from __future__ import annotations

import asyncio
import contextlib
import errno
import json
import logging
import os
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable

from .bridge import OMP_AGENT_DIR

log = logging.getLogger(__name__)

COLLAB_DIR = Path(os.environ.get("OMPGW_COLLAB_DIR")
                  or (OMP_AGENT_DIR.parent / "run" / "collab-hosts")).expanduser()
POLL_S = float(os.environ.get("OMPGW_COLLAB_POLL_S", "10"))
TTL_S = max(3 * POLL_S, 35.0)
QUERY_TIMEOUT_S = 1.5
MAX_ENTRIES = 32
# Slots held open for hosts we have never seen. Without them, a full cap of
# long-lived tracked hosts would fill every slot with known entries and starve
# a newly started session indefinitely (tracked hosts refresh last_ok forever,
# so TTL never frees their slot).
FRESH_SLOTS = 4
MAX_TITLE = 120
MAX_RESPONSE_BYTES = 64 * 1024

_ERROR_CODES = {"malformed_request", "unsupported_protocol",
                "authentication_failed", "snapshot_unavailable",
                "invalid_operation", "invalid_access", "stale_generation",
                "access_unavailable"}


class CollabError(Exception):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _read_entry(path: Path) -> dict | None:
    """Parse one discovery file. Returns None for anything that is not a
    version-1 publication with an absolute socket path."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        if data["version"] != 1 or type(data["version"]) is not int:
            return None
        instance_id = data["instanceId"]
        pid = data["pid"]
        endpoint = data["endpoint"]
        token = data["token"]
    except (KeyError, TypeError):
        return None
    if not (isinstance(instance_id, str) and instance_id):
        return None
    if not (isinstance(pid, int) and not isinstance(pid, bool) and pid > 0):
        return None
    if not (isinstance(endpoint, str) and endpoint.startswith("/")):
        return None
    if not (isinstance(token, str) and token):
        return None
    return {"instanceId": instance_id, "pid": pid,
            "endpoint": endpoint, "token": token}


async def _query(endpoint: str, payload: dict) -> dict | None:
    """One bounded request/reply against a unix socket. Returns a dict or
    None on any transport/protocol failure. ENOENT/ECONNREFUSED are
    re-raised so the caller can apply hard-failure liveness (D6).

    The deadline covers connect AND the write/read exchange: a host whose
    socket accepts but never answers must not hang the poll round (one wedged
    peer would otherwise stall discovery for every session forever)."""
    writer = None
    try:
        async with asyncio.timeout(QUERY_TIMEOUT_S):
            reader, writer = await asyncio.open_unix_connection(endpoint)
            writer.write((json.dumps(payload) + "\n").encode())
            await writer.drain()
            buf = b""
            while len(buf) <= MAX_RESPONSE_BYTES:
                chunk = await reader.read(65536)
                if not chunk:
                    break
                buf += chunk
                if buf.endswith(b"\n"):
                    break
            if len(buf) > MAX_RESPONSE_BYTES:
                return None
            obj = json.loads(buf.decode() or "null")
    except (FileNotFoundError, ConnectionRefusedError):
        # hard liveness failures (D6): re-raised so the poller can retire the
        # row immediately; every other transport error collapses to None.
        raise
    except (OSError, ValueError, asyncio.IncompleteReadError):
        # TimeoutError is an OSError subclass: a stalled host reads as "no
        # answer this round" (stale), never as a retirement.
        return None
    finally:
        if writer is not None:
            writer.close()
            with contextlib.suppress(Exception):
                # wait_closed can itself hang on a wedged peer; bound it.
                await asyncio.wait_for(writer.wait_closed(), 0.5)
    return obj if isinstance(obj, dict) else None


@dataclass
class Host:
    entry: dict
    snapshot: dict | None = None
    last_ok: float | None = None   # monotonic; None until first success
    stale: bool = True
    ask: dict | None = None
    had_required: bool = False
    born: float = 0.0
    born_ms: int = 0        # wall clock at first sighting, for display
    last_seen_ms: int = 0   # wall clock of the last SUCCESSFUL snapshot


def _epoch_ms() -> int:
    """Wall-clock milliseconds, for the fields a client displays. Liveness and
    TTL use the injected monotonic clock instead."""
    return int(time.time() * 1000)


class Discovery:
    """In-memory registry of external omp collab hosts."""

    def __init__(self, directory: Path = COLLAB_DIR, *,
                 clock: Callable[[], float] = time.monotonic,
                 on_ask: Callable[[dict, dict], Awaitable[None]] | None = None) -> None:
        self.dir = directory
        self.clock = clock
        self.on_ask = on_ask
        self._hosts: dict[str, Host] = {}
        self._task: asyncio.Task | None = None
        self._mints: list[tuple[Host, dict]] = []
        # instanceId -> discovery file, so retirement can ask "is the entry still
        # there?" instead of "did it miss one round?" (D6).
        self._paths: dict[str, Path] = {}
        # Last listing failure signature: an unreadable directory must not warn
        # on every poll, and must not read as "no hosts" (see poll_once).
        self._last_list_error: str | None = None

    # -- reconciliation ------------------------------------------------

    def _validate_snapshot(self, snap: object) -> dict | None:
        """Accept only a snapshot whose documented fields have the documented
        types. `_public_row` casts several of them, so a wrong type here would
        surface as a 500 on /api/sessions instead of a stale row."""
        if not isinstance(snap, dict):
            return None
        for key in ("prompt", "question", "options", "prefill", "answer",
                    "requestId", "count"):
            if key in snap:
                return None
        iid = snap.get("instanceId")
        gen = snap.get("generation")
        pid = snap.get("pid")
        started = snap.get("startedAt")
        access = snap.get("access")
        required = snap.get("inputRequired")
        cwd = snap.get("cwd")
        participants = snap.get("participants")
        if not (isinstance(iid, str) and iid):
            return None
        if not (isinstance(gen, int) and not isinstance(gen, bool) and gen >= 1):
            return None
        if not (isinstance(pid, int) and not isinstance(pid, bool) and pid > 0):
            return None
        if not (isinstance(started, int) and not isinstance(started, bool)):
            return None
        if access not in ("view", "control"):
            return None
        if not isinstance(required, bool):
            return None
        if not (isinstance(cwd, str) and cwd):
            return None
        if not (isinstance(participants, int) and not isinstance(participants, bool)):
            return None
        for key in ("sessionId", "sessionName", "busy"):
            if snap.get(key) is not None and not isinstance(
                    snap[key], str if key != "busy" else bool):
                return None
        model = snap.get("model")
        if model is not None:
            if not isinstance(model, dict):
                return None
            if not (isinstance(model.get("provider"), str)
                    and isinstance(model.get("id"), str)):
                return None
        return snap

    def _mint_ask(self, host: Host) -> dict:
        return {"requestId": secrets.token_urlsafe(8), "since": _epoch_ms()}

    async def poll_once(self) -> None:
        """List entries, query each host concurrently, reconcile."""
        try:
            paths = self._list_entries()
        except OSError as exc:
            # A failed listing is NOT evidence that any host finished. Retiring
            # rows here would blank the rail on a transient stat/iterdir error,
            # so skip this round entirely. Warn once per distinct failure.
            signature = f"{type(exc).__name__}:{exc.errno}"
            if signature != self._last_list_error:
                self._last_list_error = signature
                if isinstance(exc, (FileNotFoundError, NotADirectoryError)):
                    # Nothing has published yet (collab off, or no interactive
                    # session has started): the normal empty state, not a fault.
                    log.debug("collab discovery dir absent: %s", exc)
                else:
                    log.warning("collab discovery dir unreadable: %s", exc)
            return
        if self._last_list_error is not None:
            log.info("collab discovery dir readable again")
            self._last_list_error = None
        entries = [(p, _read_entry(p)) for p in paths]
        valid = [(p, e) for p, e in entries if e is not None]
        seen: dict[str, tuple[Path, dict]] = {}
        for p, e in valid:
            iid = e["instanceId"]
            if iid not in seen:
                seen[iid] = (p, e)
        valid = list(seen.values())
        # Hosts we already track are queried first, so a busy directory cannot
        # evict a long-running session just because its entry file is old. A
        # few slots stay reserved for unseen hosts, otherwise a saturated cap
        # of long-lived sessions would keep new ones off the rail forever.
        known = [x for x in valid if x[1]["instanceId"] in self._hosts]
        fresh = [x for x in valid if x[1]["instanceId"] not in self._hosts]
        reserved = min(len(fresh), FRESH_SLOTS)
        valid = (known[:MAX_ENTRIES - reserved] + fresh[:MAX_ENTRIES])[:MAX_ENTRIES]
        for p, e in valid:
            self._paths[e["instanceId"]] = p
        self._mints = []
        results = await asyncio.gather(
            *(_query(e["endpoint"], {"v": 1, "token": e["token"],
                                     "op": "snapshot"})
              for _, e in valid),
            return_exceptions=True)

        now = self.clock()
        seen_ids: set[str] = set()
        for (path, entry), res in zip(valid, results):
            iid = entry["instanceId"]
            seen_ids.add(iid)
            host = self._hosts.get(iid)
            if host is None:
                host = Host(entry=entry, born=now, born_ms=_epoch_ms())
                self._hosts[iid] = host
            else:
                host.entry = entry
            snap = res if isinstance(res, dict) else None
            if snap is not None and snap.get("ok") is True:
                vs = self._validate_snapshot(snap.get("snapshot"))
                if vs is not None:
                    self._apply(host, vs, now)
                    continue
                # privacy regression or invalid shape: keep previous row
                host.stale = True
                continue
            self._mark_failure(host, res, now)

        for host, ask in self._mints:
            row = self._public_row(host)
            if row is None:
                continue
            if self.on_ask is not None:
                try:
                    await self.on_ask(row, ask)
                except Exception as exc:  # noqa: BLE001 - callback must not kill poll
                    log.warning("collab on_ask callback failed: %r", exc)

        # Retire a row only when its discovery entry is actually gone (or its
        # host answered hard-dead, which _mark_failure already handled). An
        # unreadable-but-present entry, or one dropped by the MAX_ENTRIES cap,
        # is not evidence the host finished: keep it stale and let TTL decide.
        for iid in [k for k in self._hosts if k not in seen_ids]:
            path = self._paths.get(iid)
            if path is None or not path.exists():
                self._drop(iid, now)
            else:
                self._hosts[iid].stale = True
        for iid, host in list(self._hosts.items()):
            anchor = host.last_ok if host.last_ok is not None else host.born
            if now - anchor > TTL_S:
                self._drop(iid, now)

    def _list_entries(self) -> list[Path]:
        """Every *.json entry, newest first. One path whose stat() fails (a
        dangling symlink, a file pruned between iterdir and stat) is skipped:
        it must not make discovery permanently inert. An iterdir failure
        propagates, so the caller can skip the round rather than treat it as
        "no hosts"."""
        found: list[tuple[float, Path]] = []
        for p in self.dir.iterdir():
            if p.name.startswith(".") or not p.name.endswith(".json"):
                continue
            try:
                found.append((p.stat().st_mtime, p))
            except OSError:
                continue
        found.sort(key=lambda t: t[0], reverse=True)
        return [p for _, p in found]

    def _apply(self, host: Host, vs: dict, now: float) -> None:
        if (host.snapshot is not None
                and vs.get("generation") != host.snapshot.get("generation")):
            host.ask = None
            # a fresh edge is required to mint again after a generation change
            host.had_required = bool(vs.get("inputRequired"))
        host.snapshot = vs
        host.last_ok = now
        host.last_seen_ms = _epoch_ms()
        host.stale = False
        required = bool(vs.get("inputRequired"))
        if required and not host.had_required:
            host.had_required = True
            host.ask = self._mint_ask(host)
            self._mints.append((host, dict(host.ask)))
        elif not required and host.had_required:
            host.had_required = False
            host.ask = None

    def _mark_failure(self, host: Host, res: object, now: float) -> None:
        """Only ENOENT/ECONNREFUSED retires a row immediately; every other
        failure keeps the last known row stale until TTL."""
        if (isinstance(res, OSError)
                and getattr(res, "errno", None) in (errno.ENOENT, errno.ECONNREFUSED)):
            self._drop(host.entry["instanceId"], now)
            return
        if res is not None and not isinstance(res, (BaseException, dict)):
            log.warning("collab query crashed: %r", res)
        host.stale = True

    def _drop(self, iid: str, now: float) -> None:
        self._hosts.pop(iid, None)
        self._paths.pop(iid, None)

    # -- public surface --------------------------------------------------

    def _public_row(self, host: Host) -> dict | None:
        vs = host.snapshot
        if vs is None:
            return None
        return {
                "kind": "external",
                "instanceId": str(vs["instanceId"]),
                "generation": int(vs["generation"]),
                "pid": int(vs["pid"]),
                "sessionId": vs.get("sessionId")
                if isinstance(vs.get("sessionId"), str) else None,
                "title": (str(vs["sessionName"])[:MAX_TITLE]
                          if isinstance(vs.get("sessionName"), str) else None),
                "cwd": str(vs["cwd"]),
                "model": vs.get("model")
                if isinstance(vs.get("model"), dict) else None,
                "startedAt": int(vs["startedAt"]),
                "participants": int(vs.get("participants", 1)),
                "access": str(vs["access"]),
                "busy": vs.get("busy") if isinstance(vs.get("busy"), bool) else None,
                "inputRequired": bool(vs.get("inputRequired")),
                "ask": dict(host.ask) if host.ask else None,
                # Last SUCCESSFUL observation, not "now": a stale row must not
                # advertise a fresh last-seen time (docs/API.md). The born_ms
                # fallback is unreachable today (a row only exists once
                # _apply set both snapshot and last_seen_ms); it stays as a
                # guard so a future non-snapshot row cannot emit 0.
                "lastSeenAt": host.last_seen_ms or host.born_ms,
                "stale": host.stale,
            }

    def snapshot(self) -> list[dict]:
        rows = [r for r in (self._public_row(h) for h in self._hosts.values())
                if r is not None]
        with_ask = [r for r in rows if r["ask"]]
        without = [r for r in rows if not r["ask"]]
        with_ask.sort(key=lambda r: r["ask"]["since"])
        without.sort(key=lambda r: r["startedAt"], reverse=True)
        return with_ask + without

    async def link(self, instance_id: str, generation: int,
                   access: str) -> dict:
        """Fetch a one-shot capability URL for a host, per tap, never cached."""
        host = self._hosts.get(instance_id)
        if host is None:
            raise CollabError("not_found")
        payload = {"v": 1, "token": host.entry["token"], "op": "link",
                   "access": access, "generation": generation}
        try:
            res = await _query(host.entry["endpoint"], payload)
        except (FileNotFoundError, ConnectionRefusedError):
            # `_query` re-raises the hard liveness errors; for a launch they are
            # just "this host is gone", which the handler maps to 502.
            raise CollabError("unreachable") from None
        if res is None:
            raise CollabError("unreachable")
        if res.get("ok") is True and isinstance(res.get("url"), str):
            return {"url": res["url"]}
        err = res.get("error")
        if err in ("stale_generation", "access_unavailable"):
            raise CollabError(err)
        raise CollabError("unreachable")

    # -- loop -----------------------------------------------------------

    async def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task
        self._task = None

    async def _loop(self) -> None:
        while True:
            try:
                await self.poll_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - never take gateway down
                log.warning("collab poll failed: %r", exc)
            await asyncio.sleep(POLL_S)


_singleton: Discovery | None = None


def get_discovery() -> Discovery:
    global _singleton
    if _singleton is None:
        _singleton = Discovery()
    return _singleton
