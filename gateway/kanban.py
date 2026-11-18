"""Per-project kanban boards: <cwd>/.omp/kanban/board.json (and archive.json).

Wire-compatible with the omp-kanban extension (~/projects/omp-kanban/src/store.ts):
same JSON schema, column ids (todo, doing, review, done), K-<n> ids, 45-minute
claim TTL, priority ordering, and atomic tmp + replace writes serialized per
board path.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger("ohmpi-gateway.kanban")

COLUMNS = ("todo", "doing", "review", "done")
COLUMN_TITLES = {
    "todo": "To do",
    "doing": "Doing",
    "review": "Review",
    "done": "Done",
}
CLAIM_TTL_SEC = 45 * 60
MAX_TITLE_LEN = 500
MAX_BODY_LEN = 100_000
MAX_NOTE_LEN = 20_000
MAX_TAGS = 32
MAX_BLOCKERS = 64

_ID_NUM_RE = re.compile(r"^K-(\d+)$", re.IGNORECASE)

_locks_guard = threading.Lock()
_board_locks: dict[str, threading.RLock] = {}


class KanbanError(Exception):
    """Bad input or a board store problem; `status` maps to the HTTP code."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.message = message
        self.status = status


def _lock_for(board_file: Path) -> threading.RLock:
    key = str(board_file)
    with _locks_guard:
        lock = _board_locks.get(key)
        if lock is None:
            lock = threading.RLock()
            _board_locks[key] = lock
        return lock


def _now_iso(now_sec: float | None = None) -> str:
    ts = time.time() if now_sec is None else now_sec
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _parse_iso(value: object) -> float | None:
    if not isinstance(value, str) or not value.strip():
        return None
    s = value.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _id_number(ticket_id: str) -> int:
    m = _ID_NUM_RE.match(ticket_id.strip())
    if m:
        return int(m.group(1))
    return 1 << 62


def _is_finite_number(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def _clean_number(value: object) -> int | float:
    assert _is_finite_number(value)
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value  # type: ignore[return-value]


def resolve_cwd(raw: str | None) -> Path:
    """Resolve a project working directory on the host."""
    if not isinstance(raw, str) or not raw.strip():
        raise KanbanError("cwd is required", 422)
    if "\x00" in raw:
        raise KanbanError("cwd contains a NUL byte", 422)
    expanded = os.path.expanduser(raw.strip())
    try:
        real = os.path.realpath(expanded)
    except OSError:
        raise KanbanError("cwd cannot be resolved", 422) from None
    p = Path(real)
    if not p.exists():
        raise KanbanError(f"no such directory: {raw.strip()}", 404)
    if not p.is_dir():
        raise KanbanError("cwd is not a directory", 422)
    return p


def _check_confined(cwd: Path, target: Path) -> None:
    """Ensure board files inside .omp/kanban never symlink out of `cwd`."""
    # Walk existing segments up to cwd so a symlinked .omp or kanban folder
    # pointing outside `cwd` is caught before reading or writing.
    cur = target
    while True:
        if cur.exists() or cur.is_symlink():
            try:
                resolved = Path(os.path.realpath(cur))
            except OSError:
                raise KanbanError("board path cannot be resolved", 422) from None
            if not resolved.is_relative_to(cwd):
                raise KanbanError("board path escapes the project directory", 403)
            break
        if cur == cwd or cur == cur.parent:
            break
        cur = cur.parent


def board_path(cwd: Path) -> Path:
    return cwd / ".omp" / "kanban" / "board.json"


def archive_path(cwd: Path) -> Path:
    return cwd / ".omp" / "kanban" / "archive.json"


def empty_board() -> dict[str, Any]:
    return {
        "version": 1,
        "next_id": 1,
        "columns": [{"id": c, "title": COLUMN_TITLES[c]} for c in COLUMNS],
        "tickets": [],
    }


def _normalize_ticket(raw: object) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    tid = raw.get("id")
    title = raw.get("title")
    if not isinstance(tid, str) or not tid.strip() or not isinstance(title, str):
        return None
    col = raw.get("column")
    column = col if isinstance(col, str) and col in COLUMNS else "todo"
    prio_raw = raw.get("priority")
    priority = _clean_number(prio_raw) if _is_finite_number(prio_raw) else 100
    tags_raw = raw.get("tags")
    tags = [t for t in tags_raw if isinstance(t, str)] if isinstance(tags_raw, list) else []
    blocked_raw = raw.get("blocked_by")
    blocked_by = (
        [b for b in blocked_raw if isinstance(b, str)]
        if isinstance(blocked_raw, list)
        else []
    )
    now = _now_iso()
    created = raw.get("created") if isinstance(raw.get("created"), str) else now
    updated = raw.get("updated") if isinstance(raw.get("updated"), str) else now
    notes_raw = raw.get("notes")
    notes: list[dict[str, str]] = []
    if isinstance(notes_raw, list):
        for n in notes_raw:
            if isinstance(n, dict) and isinstance(n.get("text"), str):
                notes.append({
                    "at": n["at"] if isinstance(n.get("at"), str) else now,
                    "text": n["text"],
                })
    ticket: dict[str, Any] = {
        "id": tid,
        "title": title,
        "body": raw.get("body") if isinstance(raw.get("body"), str) else "",
        "column": column,
        "priority": priority,
        "tags": tags,
        "blocked_by": blocked_by,
        "created": created,
        "updated": updated,
        "notes": notes,
    }
    if isinstance(raw.get("claimed_by"), str) and raw["claimed_by"]:
        ticket["claimed_by"] = raw["claimed_by"]
    if isinstance(raw.get("claimed_at"), str) and raw["claimed_at"]:
        ticket["claimed_at"] = raw["claimed_at"]
    return ticket


def normalize_board(raw: object) -> dict[str, Any]:
    board = empty_board()
    if not isinstance(raw, dict):
        return board
    nid = raw.get("next_id")
    if _is_finite_number(nid) and nid > 0:
        board["next_id"] = int(nid)
    tickets_raw = raw.get("tickets")
    if isinstance(tickets_raw, list):
        for item in tickets_raw:
            t = _normalize_ticket(item)
            if t is not None:
                board["tickets"].append(t)
    for t in board["tickets"]:
        n = _id_number(t["id"])
        if n < (1 << 62) and n >= board["next_id"]:
            board["next_id"] = n + 1
    return board


def _load_board_unlocked(cwd: Path) -> tuple[dict[str, Any], bool]:
    path = board_path(cwd)
    _check_confined(cwd, path)
    if not path.exists():
        return empty_board(), False
    if not path.is_file():
        raise KanbanError("board.json is not a regular file", 409)
    try:
        text = path.read_text(encoding="utf-8")
        data = json.loads(text)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise KanbanError(f"could not read board.json: {exc}", 409) from None
    return normalize_board(data), True


def _atomic_write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}-{threading.get_ident()}")
    payload = json.dumps(data, indent=2) + "\n"
    try:
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _board_response(cwd: Path, board: dict[str, Any], exists: bool) -> dict[str, Any]:
    return {
        **board,
        "cwd": str(cwd),
        "path": str(board_path(cwd)),
        "exists": exists,
    }


def get_board(raw_cwd: str | None) -> dict[str, Any]:
    cwd = resolve_cwd(raw_cwd)
    path = board_path(cwd)
    with _lock_for(path):
        board, exists = _load_board_unlocked(cwd)
    return _board_response(cwd, board, exists)


def init_board(raw_cwd: str | None) -> dict[str, Any]:
    cwd = resolve_cwd(raw_cwd)
    path = board_path(cwd)
    with _lock_for(path):
        board, exists = _load_board_unlocked(cwd)
        if not exists:
            _check_confined(cwd, path)
            _atomic_write_json(path, board)
    return _board_response(cwd, board, True)


def get_archive(raw_cwd: str | None) -> dict[str, Any]:
    cwd = resolve_cwd(raw_cwd)
    path = archive_path(cwd)
    _check_confined(cwd, path)
    if not path.exists():
        return {"cwd": str(cwd), "tickets": []}
    if not path.is_file():
        raise KanbanError("archive.json is not a regular file", 409)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise KanbanError(f"could not read archive.json: {exc}", 409) from None
    tickets = [t for t in (_normalize_ticket(x) for x in data) if t is not None] if isinstance(data, list) else []
    return {"cwd": str(cwd), "tickets": tickets}


def _find_ticket(board: dict[str, Any], ticket_id: object) -> dict[str, Any]:
    if not isinstance(ticket_id, str) or not ticket_id.strip():
        raise KanbanError("id is required", 422)
    wanted = ticket_id.strip().upper()
    for t in board["tickets"]:
        if t["id"].upper() == wanted:
            return t
    raise KanbanError(f"no ticket {ticket_id.strip()}", 404)


def _as_column(value: object, *, default: str | None = None) -> str:
    if value is None and default is not None:
        return default
    if isinstance(value, str) and value in COLUMNS:
        return value
    raise KanbanError(f"column must be one of {', '.join(COLUMNS)}", 422)


def _as_string_list(value: object, name: str, *, limit: int, upper: bool = False,
                    strip_hash: bool = False) -> list[str]:
    if not isinstance(value, list):
        raise KanbanError(f"{name} must be a list of strings", 422)
    if len(value) > limit:
        raise KanbanError(f"{name} may have at most {limit} entries", 422)
    out: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise KanbanError(f"{name} must contain strings only", 422)
        s = item.strip()
        if strip_hash:
            s = s.lstrip("#").strip()
        if not s:
            continue
        if upper:
            s = s.upper()
        if s not in out:
            out.append(s)
    return out


def _apply_move(board: dict[str, Any], ticket: dict[str, Any], column: str,
                position: object = None) -> None:
    ticket["column"] = column
    ticket["updated"] = _now_iso()
    if column in ("review", "done"):
        ticket.pop("claimed_by", None)
        ticket.pop("claimed_at", None)
    if position is not None:
        if not _is_finite_number(position):
            raise KanbanError("position must be a finite number", 422)
        peers = sorted(
            [t for t in board["tickets"] if t["column"] == column and t["id"] != ticket["id"]],
            key=lambda t: (t["priority"], _id_number(t["id"])),
        )
        clamped = max(0, min(math.floor(float(position)), len(peers)))
        before = peers[clamped - 1] if clamped > 0 else None
        after = peers[clamped] if clamped < len(peers) else None
        if before is None and after is not None:
            ticket["priority"] = _clean_number(after["priority"] - 1)
        elif before is not None and after is None:
            ticket["priority"] = _clean_number(before["priority"] + 1)
        elif before is not None and after is not None:
            ticket["priority"] = _clean_number((before["priority"] + after["priority"]) / 2)


def _is_claimed(ticket: dict[str, Any], now_sec: float | None = None) -> bool:
    at = _parse_iso(ticket.get("claimed_at"))
    if at is None:
        return False
    now = time.time() if now_sec is None else now_sec
    return (now - at) < CLAIM_TTL_SEC


def add_ticket(raw_cwd: str | None, body: dict[str, Any]) -> dict[str, Any]:
    title_raw = body.get("title")
    if not isinstance(title_raw, str) or not title_raw.strip():
        raise KanbanError("title is required", 422)
    title = title_raw.strip()
    if len(title) > MAX_TITLE_LEN:
        raise KanbanError(f"title exceeds {MAX_TITLE_LEN} characters", 422)

    body_text = ""
    if body.get("body") is not None:
        if not isinstance(body["body"], str):
            raise KanbanError("body must be a string", 422)
        if len(body["body"]) > MAX_BODY_LEN:
            raise KanbanError(f"body exceeds {MAX_BODY_LEN} characters", 422)
        body_text = body["body"].strip()

    column = _as_column(body.get("column"), default="todo")
    priority: int | float = 100
    if body.get("priority") is not None:
        if not _is_finite_number(body["priority"]):
            raise KanbanError("priority must be a finite number", 422)
        priority = _clean_number(body["priority"])

    tags = (
        _as_string_list(body["tags"], "tags", limit=MAX_TAGS, strip_hash=True)
        if body.get("tags") is not None
        else []
    )
    blocked_by = (
        _as_string_list(body["blocked_by"], "blocked_by", limit=MAX_BLOCKERS, upper=True)
        if body.get("blocked_by") is not None
        else []
    )

    cwd = resolve_cwd(raw_cwd)
    path = board_path(cwd)
    with _lock_for(path):
        board, _ = _load_board_unlocked(cwd)
        now = _now_iso()
        ticket: dict[str, Any] = {
            "id": f"K-{board['next_id']}",
            "title": title,
            "body": body_text,
            "column": column,
            "priority": priority,
            "tags": tags,
            "blocked_by": blocked_by,
            "created": now,
            "updated": now,
            "notes": [],
        }
        board["next_id"] += 1
        board["tickets"].append(ticket)
        _check_confined(cwd, path)
        _atomic_write_json(path, board)
    return {"ticket": ticket, "board": _board_response(cwd, board, True)}


def move_ticket(raw_cwd: str | None, body: dict[str, Any]) -> dict[str, Any]:
    column = _as_column(body.get("column"))
    position = body.get("position")
    if position is not None and not _is_finite_number(position):
        raise KanbanError("position must be a finite number", 422)

    cwd = resolve_cwd(raw_cwd)
    path = board_path(cwd)
    with _lock_for(path):
        board, _ = _load_board_unlocked(cwd)
        target = _find_ticket(board, body.get("id"))
        _apply_move(board, target, column, position)
        _check_confined(cwd, path)
        _atomic_write_json(path, board)
    return {"ticket": target, "board": _board_response(cwd, board, True)}


def update_ticket(raw_cwd: str | None, body: dict[str, Any]) -> dict[str, Any]:
    if "title" in body and body["title"] is not None:
        if not isinstance(body["title"], str) or not body["title"].strip():
            raise KanbanError("title must be a non-empty string", 422)
        if len(body["title"].strip()) > MAX_TITLE_LEN:
            raise KanbanError(f"title exceeds {MAX_TITLE_LEN} characters", 422)
    if "body" in body and body["body"] is not None:
        if not isinstance(body["body"], str):
            raise KanbanError("body must be a string", 422)
        if len(body["body"]) > MAX_BODY_LEN:
            raise KanbanError(f"body exceeds {MAX_BODY_LEN} characters", 422)
    if "priority" in body and body["priority"] is not None:
        if not _is_finite_number(body["priority"]):
            raise KanbanError("priority must be a finite number", 422)
    tags = None
    if "tags" in body and body["tags"] is not None:
        tags = _as_string_list(body["tags"], "tags", limit=MAX_TAGS, strip_hash=True)
    blocked_by = None
    if "blocked_by" in body and body["blocked_by"] is not None:
        blocked_by = _as_string_list(body["blocked_by"], "blocked_by", limit=MAX_BLOCKERS, upper=True)
    column = None
    if "column" in body and body["column"] is not None:
        column = _as_column(body["column"])
    position = body.get("position")
    if position is not None and not _is_finite_number(position):
        raise KanbanError("position must be a finite number", 422)

    cwd = resolve_cwd(raw_cwd)
    path = board_path(cwd)
    with _lock_for(path):
        board, _ = _load_board_unlocked(cwd)
        target = _find_ticket(board, body.get("id"))
        if "title" in body and body["title"] is not None:
            target["title"] = body["title"].strip()
        if "body" in body and body["body"] is not None:
            target["body"] = body["body"]
        if "priority" in body and body["priority"] is not None:
            target["priority"] = _clean_number(body["priority"])
        if tags is not None:
            target["tags"] = tags
        if blocked_by is not None:
            if any(b == target["id"].upper() for b in blocked_by):
                raise KanbanError("a ticket cannot block itself", 422)
            target["blocked_by"] = blocked_by
        if column is not None:
            _apply_move(board, target, column, position)
        target["updated"] = _now_iso()
        _check_confined(cwd, path)
        _atomic_write_json(path, board)
    return {"ticket": target, "board": _board_response(cwd, board, True)}


def add_note(raw_cwd: str | None, body: dict[str, Any]) -> dict[str, Any]:
    text_raw = body.get("text")
    if not isinstance(text_raw, str) or not text_raw.strip():
        raise KanbanError("text is required", 422)
    text = text_raw.strip()
    if len(text) > MAX_NOTE_LEN:
        raise KanbanError(f"note exceeds {MAX_NOTE_LEN} characters", 422)

    cwd = resolve_cwd(raw_cwd)
    path = board_path(cwd)
    with _lock_for(path):
        board, _ = _load_board_unlocked(cwd)
        target = _find_ticket(board, body.get("id"))
        now = _now_iso()
        target["notes"].append({"at": now, "text": text})
        target["updated"] = now
        _check_confined(cwd, path)
        _atomic_write_json(path, board)
    return {"ticket": target, "board": _board_response(cwd, board, True)}


def claim_ticket(raw_cwd: str | None, body: dict[str, Any], *, now_sec: float | None = None) -> dict[str, Any]:
    by_raw = body.get("by")
    if by_raw is not None and (not isinstance(by_raw, str) or not by_raw.strip()):
        raise KanbanError("by must be a non-empty string", 422)
    claimer = by_raw.strip() if isinstance(by_raw, str) else "omai"

    cwd = resolve_cwd(raw_cwd)
    path = board_path(cwd)
    with _lock_for(path):
        board, _ = _load_board_unlocked(cwd)
        target = _find_ticket(board, body.get("id"))
        if _is_claimed(target, now_sec=now_sec) and target.get("claimed_by") != claimer:
            holder = target.get("claimed_by") or "another session"
            raise KanbanError(f"{target['id']} is claimed by {holder}", 409)
        now = _now_iso(now_sec)
        target["claimed_by"] = claimer
        target["claimed_at"] = now
        target["column"] = "doing"
        target["updated"] = now
        _check_confined(cwd, path)
        _atomic_write_json(path, board)
    return {"ticket": target, "board": _board_response(cwd, board, True)}


def release_ticket(raw_cwd: str | None, body: dict[str, Any]) -> dict[str, Any]:
    note_raw = body.get("note")
    if note_raw is not None and not isinstance(note_raw, str):
        raise KanbanError("note must be a string", 422)
    note = note_raw.strip() if isinstance(note_raw, str) else ""
    if len(note) > MAX_NOTE_LEN:
        raise KanbanError(f"note exceeds {MAX_NOTE_LEN} characters", 422)

    cwd = resolve_cwd(raw_cwd)
    path = board_path(cwd)
    with _lock_for(path):
        board, _ = _load_board_unlocked(cwd)
        target = _find_ticket(board, body.get("id"))
        now = _now_iso()
        target.pop("claimed_by", None)
        target.pop("claimed_at", None)
        if note:
            target["notes"].append({"at": now, "text": note})
        target["updated"] = now
        _check_confined(cwd, path)
        _atomic_write_json(path, board)
    return {"ticket": target, "board": _board_response(cwd, board, True)}


def delete_ticket(raw_cwd: str | None, body: dict[str, Any]) -> dict[str, Any]:
    cwd = resolve_cwd(raw_cwd)
    path = board_path(cwd)
    with _lock_for(path):
        board, _ = _load_board_unlocked(cwd)
        target = _find_ticket(board, body.get("id"))
        board["tickets"] = [t for t in board["tickets"] if t["id"] != target["id"]]
        _check_confined(cwd, path)
        _atomic_write_json(path, board)
    return {"deleted": target, "board": _board_response(cwd, board, True)}


def archive_tickets(raw_cwd: str | None, body: dict[str, Any], *, now_sec: float | None = None) -> dict[str, Any]:
    days_raw = body.get("older_than_days")
    if days_raw is None:
        days_raw = 7
    if not _is_finite_number(days_raw) or days_raw < 0:
        raise KanbanError("older_than_days must be a non-negative number", 422)
    now = time.time() if now_sec is None else now_sec
    cutoff = now - float(days_raw) * 86400.0

    cwd = resolve_cwd(raw_cwd)
    bpath = board_path(cwd)
    apath = archive_path(cwd)
    with _lock_for(bpath):
        board, exists = _load_board_unlocked(cwd)
        keep: list[dict[str, Any]] = []
        moved: list[dict[str, Any]] = []
        for t in board["tickets"]:
            updated_ts = _parse_iso(t.get("updated"))
            if t["column"] == "done" and updated_ts is not None and updated_ts < cutoff:
                moved.append(t)
            else:
                keep.append(t)
        if not moved:
            return {
                "moved": 0,
                "archivedIds": [],
                "board": _board_response(cwd, board, exists),
            }
        _check_confined(cwd, apath)
        existing: list[Any] = []
        if apath.exists():
            if not apath.is_file():
                raise KanbanError("archive.json is not a regular file", 409)
            try:
                loaded = json.loads(apath.read_text(encoding="utf-8"))
                if isinstance(loaded, list):
                    existing = loaded
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise KanbanError(f"could not read archive.json: {exc}", 409) from None
        _atomic_write_json(apath, [*existing, *moved])
        board["tickets"] = keep
        _check_confined(cwd, bpath)
        _atomic_write_json(bpath, board)
    return {
        "moved": len(moved),
        "archivedIds": [t["id"] for t in moved],
        "board": _board_response(cwd, board, True),
    }


def _summarize_board(cwd: Path, board: dict[str, Any]) -> dict[str, Any]:
    counts = {c: 0 for c in COLUMNS}
    latest_ts = 0.0
    latest_iso: str | None = None
    for t in board["tickets"]:
        counts[t["column"]] += 1
        ts = _parse_iso(t.get("updated"))
        if ts is not None and ts >= latest_ts:
            latest_ts = ts
            latest_iso = t.get("updated")
    if latest_iso is None:
        try:
            st = board_path(cwd).stat()
            latest_ts = st.st_mtime
            latest_iso = _now_iso(st.st_mtime)
        except OSError:
            pass
    return {
        "cwd": str(cwd),
        "name": cwd.name or str(cwd),
        "path": str(board_path(cwd)),
        "counts": counts,
        "total": len(board["tickets"]),
        "updated": latest_iso,
        "_sortTs": latest_ts,
    }


def discover_boards(
    *,
    projects_root: Path | None = None,
    extra_cwds: list[str] | None = None,
) -> dict[str, Any]:
    """Scan `~/projects`, its direct subfolders, and known session cwds for
    `.omp/kanban/board.json`."""
    candidates: list[Path] = []
    seen: set[str] = set()

    def add_dir(raw: str | Path | None) -> None:
        if not raw:
            return
        try:
            real = Path(os.path.realpath(os.path.expanduser(str(raw))))
        except OSError:
            return
        key = str(real)
        if key in seen or not real.is_dir():
            return
        seen.add(key)
        candidates.append(real)

    home = Path(os.path.realpath(os.path.expanduser("~")))
    proj = projects_root or (home / "projects")
    add_dir(proj)
    if proj.is_dir():
        try:
            with os.scandir(proj) as it:
                for de in it:
                    if de.name.startswith("."):
                        continue
                    try:
                        if de.is_dir():
                            add_dir(de.path)
                    except OSError:
                        continue
        except OSError:
            pass

    for c in extra_cwds or ():
        add_dir(c)

    boards: list[dict[str, Any]] = []
    for cwd in candidates:
        bpath = board_path(cwd)
        try:
            _check_confined(cwd, bpath)
            if not bpath.is_file():
                continue
            with _lock_for(bpath):
                board, exists = _load_board_unlocked(cwd)
        except KanbanError:
            continue
        if exists:
            boards.append(_summarize_board(cwd, board))

    boards.sort(key=lambda b: (-b["_sortTs"], b["name"].lower()))
    for b in boards:
        b.pop("_sortTs", None)
    return {"boards": boards}
