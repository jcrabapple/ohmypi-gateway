"""Cross-session search: FTS5 over saved omp transcripts.

Indexes ~/.omp/agent/sessions/**/*.jsonl into a local SQLite FTS5 database
(path: OMPGW_SEARCH_DB, default search-index.db next to auth-token). Only
user/assistant TEXT blocks are indexed - thinking blocks are scratch, and tool
results are huge and rarely what "which session did I fix X in" means.

Refreshes are incremental (per-file mtime+size) and pruned (deleted files drop
out). Every disk touch runs in a worker thread via the route layer; the module
itself is synchronous and lock-guarded, never called on the event loop.

The user query is tokenized defensively: only word-ish characters survive, and
each token becomes a prefixed term, so raw FTS5 syntax from the client can
neither error the query nor widen it.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time
from pathlib import Path

log = logging.getLogger("ohmpi-gateway.search")

PROJECT_DIR = Path(__file__).resolve().parent.parent
SEARCH_DB = Path(os.environ.get("OMPGW_SEARCH_DB") or PROJECT_DIR / "search-index.db")
SESSIONS_DIR = Path(
    os.environ.get("OMPGW_SESSIONS_DIR") or str(Path.home() / ".omp" / "agent" / "sessions")
)
SCHEMA_VERSION = 1
# How long a fresh-enough index is trusted before the next route call rescans.
REFRESH_MIN_INTERVAL_S = 30
_TOKEN = re.compile(r"[\w][\w./+-]*")
_TITLE_CAP = 90
# Out-of-band snippet delimiters (Unicode private use area): a transcript that
# literally contains <mark> must never turn into live markup on the client.
# The client maps these to <mark>/</mark> AFTER HTML-escaping the snippet.
_MARK_OPEN = ""
_MARK_CLOSE = ""

# RLock: ensure_fresh holds it while calling refresh(), which locks too.
_lock = threading.RLock()
_last_refresh = 0.0


def _connect() -> sqlite3.Connection:
    SEARCH_DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(SEARCH_DB, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    _ensure_schema(con)
    return con


def _ensure_schema(con: sqlite3.Connection) -> None:
    version = con.execute("PRAGMA user_version").fetchone()[0]
    if version == SCHEMA_VERSION:
        return
    if version > SCHEMA_VERSION:
        raise RuntimeError(
            f"search index schema v{version} is newer than this gateway (v{SCHEMA_VERSION}); "
            "delete the index file or upgrade")
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            mtime REAL NOT NULL,
            size INTEGER NOT NULL,
            session_id TEXT,
            cwd TEXT,
            title TEXT
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
            body,
            path UNINDEXED,
            line UNINDEXED,
            role UNINDEXED,
            ts UNINDEXED,
            tokenize='porter unicode61'
        );
        """
    )
    con.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
    con.commit()


# ------------------------------------------------------------------ indexing

def _title_of(head_user_text: str) -> str:
    text = " ".join(head_user_text.split())
    return text[:_TITLE_CAP]


def _parse_file(path: Path) -> tuple[list[dict], dict]:
    """(message rows, file meta). Bad lines are skipped; the session header
    supplies cwd/session id (same format bridge.read_session_cwd relies on)."""
    rows: list[dict] = []
    session_id = cwd = None
    first_user = ""
    try:
        with path.open("rb") as fh:
            for line_no, raw in enumerate(fh, 1):
                try:
                    obj = json.loads(raw)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                if not isinstance(obj, dict):
                    continue
                if obj.get("type") == "session":
                    session_id = obj.get("id")
                    cwd = obj.get("cwd")
                    continue
                if obj.get("type") != "message":
                    continue
                msg = obj.get("message")
                if not isinstance(msg, dict):
                    continue
                role = msg.get("role")
                if role not in ("user", "assistant"):
                    continue
                text = " ".join(
                    block.get("text") or "" for block in msg.get("content") or []
                    if isinstance(block, dict) and block.get("type") == "text"
                ).strip()
                if not text:
                    continue
                if role == "user" and not first_user:
                    first_user = text
                rows.append({
                    "body": text[:20000],
                    "path": str(path),
                    "line": line_no,
                    "role": role,
                    "ts": obj.get("timestamp") or "",
                })
    except OSError as e:
        log.warning("search index: unreadable %s: %s", path, e)
        return [], {}
    return rows, {
        "path": str(path),
        "session_id": session_id,
        "cwd": cwd,
        "title": _title_of(first_user),
    }


def refresh(root: Path | None = None) -> dict:
    """Incremental index update. Returns {added, updated, removed, files, messages}."""
    root = root or SESSIONS_DIR
    with _lock:
        con = _connect()
        try:
            on_disk: dict[str, tuple[float, int]] = {}
            if root.is_dir():
                for p in root.rglob("*.jsonl"):
                    try:
                        st = p.stat()
                    except OSError:
                        continue
                    on_disk[str(p.resolve())] = (st.st_mtime, st.st_size)
            known = {r["path"]: (r["mtime"], r["size"])
                     for r in con.execute("SELECT path, mtime, size FROM files")}
            added = updated = removed = 0
            for path, (mtime, size) in on_disk.items():
                if known.get(path) == (mtime, size):
                    continue
                rows, meta = _parse_file(Path(path))
                if not meta:
                    # unreadable file (permissions, vanished mid-scan): skip it
                    # this round rather than inserting a half-empty row
                    continue
                meta["mtime"], meta["size"] = mtime, size
                con.execute("DELETE FROM messages WHERE path = ?", (path,))
                con.execute("DELETE FROM files WHERE path = ?", (path,))
                con.execute(
                    "INSERT INTO files (path, mtime, size, session_id, cwd, title) "
                    "VALUES (:path, :mtime, :size, :session_id, :cwd, :title)", meta)
                con.executemany(
                    "INSERT INTO messages (body, path, line, role, ts) "
                    "VALUES (:body, :path, :line, :role, :ts)", rows)
                if path in known:
                    updated += 1
                else:
                    added += 1
            for path in set(known) - set(on_disk):
                con.execute("DELETE FROM messages WHERE path = ?", (path,))
                con.execute("DELETE FROM files WHERE path = ?", (path,))
                removed += 1
            con.commit()
            if added or updated or removed:
                log.info("search index: +%d new, ~%d updated, -%d removed", added, updated, removed)
            return {"added": added, "updated": updated, "removed": removed}
        finally:
            con.close()


def ensure_fresh(force: bool = False) -> bool:
    """Refresh at most once per REFRESH_MIN_INTERVAL_S (unless forced). True
    when a refresh actually ran. Call from a worker thread."""
    global _last_refresh
    if not force and time.monotonic() - _last_refresh < REFRESH_MIN_INTERVAL_S:
        return False
    with _lock:
        if not force and time.monotonic() - _last_refresh < REFRESH_MIN_INTERVAL_S:
            return False
        refresh()
        _last_refresh = time.monotonic()
        return True


# ------------------------------------------------------------------ querying

def fts_query(q: str) -> str | None:
    """Client query -> safe FTS5 MATCH expression (every term prefix-matched),
    or None when nothing in q is searchable."""
    terms = [t for t in (m.group(0).replace('"', "") for m in _TOKEN.finditer(q)) if t]
    if not terms:
        return None
    return " ".join(f'"{t}"*' for t in terms[:12])


def stats(con: sqlite3.Connection) -> dict:
    files = con.execute("SELECT COUNT(*) c FROM files").fetchone()["c"]
    messages = con.execute("SELECT COUNT(*) c FROM messages").fetchone()["c"]
    return {"files": files, "messages": messages}


def index_stats() -> dict:
    con = _connect()
    try:
        return stats(con)
    finally:
        con.close()


def query(q: str, limit: int = 40, role: str | None = None) -> dict:
    """Search the index. Returns {total, results}; results are message rows
    with session meta joined in. Call from a worker thread."""
    match = fts_query(q)
    if match is None:
        return {"total": 0, "results": []}
    limit = max(1, min(int(limit), 200))
    con = _connect()
    try:
        where = "WHERE messages MATCH ?"
        args: list = [match]
        if role in ("user", "assistant"):
            where += " AND role = ?"
            args.append(role)
        total = con.execute(f"SELECT count(*) c FROM messages {where}", args).fetchone()["c"]
        rows = con.execute(
            f"""
            SELECT m.path, m.line, m.role, m.ts,
                   snippet(messages, 0, '{_MARK_OPEN}', '{_MARK_CLOSE}', '…', 24) AS snippet,
                   f.session_id AS session_id, f.cwd, f.title
            FROM messages m
            LEFT JOIN files f ON f.path = m.path
            {where}
            ORDER BY rank, ts DESC
            LIMIT {limit}
            """,
            args,
        ).fetchall()
        results = []
        for r in rows:
            results.append({
                "path": r["path"],
                "line": r["line"],
                "role": r["role"],
                "ts": r["ts"],
                "snippet": r["snippet"],
                "sessionId": r["session_id"],
                "cwd": r["cwd"],
                "title": r["title"],
            })
        return {"total": total, "results": results}
    finally:
        con.close()
