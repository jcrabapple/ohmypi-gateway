"""Persistent usage ledger: one append-only SQLite row per completed agent turn.

The database lives at ~/.omp/ompgw-ledger.db by default (override with
OMPGW_LEDGER_DB, which the e2e suite points at a scratch file so tests never
touch the operator's omp state). The bridge calls record_turn() once per turn
from the same place turns are finalized; the call can never raise. Reads are
the two aggregates behind GET /api/ledger and GET /api/ledger/sessions. Only
session names, cwd, provider and model are stored, nothing else per turn.
"""

from __future__ import annotations

import contextlib
import logging
import os
import sqlite3
import threading
import time
from datetime import date, timedelta
from pathlib import Path

log = logging.getLogger("ohmpi-gateway.ledger")

SCHEMA_VERSION = 1
DEFAULT_PATH = "~/.omp/ompgw-ledger.db"
MAX_DAYS = 365
DEFAULT_DAYS = 30

_SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS turns (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    gw_id         TEXT,
    session_name  TEXT,
    cwd           TEXT,
    provider      TEXT,
    model         TEXT,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read    INTEGER NOT NULL DEFAULT 0,
    cache_write   INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL    NOT NULL DEFAULT 0,
    ok            INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);
CREATE INDEX IF NOT EXISTS idx_turns_model ON turns(provider, model);
"""

# Migrations[target] upgrades a database stamped at `target - 1` to `target`.
# Every script must be idempotent (CREATE ... IF NOT EXISTS): a crash between
# the DDL and the user_version stamp replays the step on the next start.
_MIGRATIONS: dict[int, str] = {1: _SCHEMA_V1}


class _LedgerVersionError(Exception):
    pass


def ledger_path() -> Path:
    return Path(os.environ.get("OMPGW_LEDGER_DB") or DEFAULT_PATH).expanduser()


def split_model_id(selector: str | None) -> tuple[str | None, str | None]:
    """omp reports models as `provider/model` (e.g. z-ai/glm-5.3-flashx)."""
    if not selector:
        return (None, None)
    if "/" in selector:
        provider, model = selector.split("/", 1)
        return (provider or None, model or None)
    return (None, selector)


class Ledger:
    def __init__(self, path: str | os.PathLike):
        self.path = Path(path).expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(self.path), check_same_thread=False)
        # Set when the database was written by a NEWER gateway: reads and
        # writes no-op rather than risk corrupting an unknown schema.
        self._disabled = False
        try:
            self._migrate()
        except _LedgerVersionError as e:
            self._disabled = True
            log.error("usage ledger %s: %s; sink disabled", self.path, e)
            return
        # WAL: readers never block the (single) writer. NORMAL is the usual
        # pairing; a machine crash may lose the last transaction, which is
        # acceptable for usage stats.
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.commit()

    def _migrate(self) -> None:
        """Stamp or stepwise-upgrade the schema; refuse anything newer."""
        version = self._db.execute("PRAGMA user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            raise _LedgerVersionError(
                f"schema version {version} is newer than this gateway supports (v{SCHEMA_VERSION})")
        for step in range(version, SCHEMA_VERSION):
            script = _MIGRATIONS.get(step + 1)
            if script is None:
                raise _LedgerVersionError(f"no migration path to v{step + 1}")
            self._db.executescript(script)
            self._db.execute(f"PRAGMA user_version={step + 1}")
            self._db.commit()

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._db.close()

    def record_turn(self, *, gw_id: str | None = None, session_name: str | None = None,
                    cwd: str | None = None, provider: str | None = None, model: str | None = None,
                    input_tokens: int = 0, output_tokens: int = 0, cache_read: int = 0,
                    cache_write: int = 0, cost_usd: float = 0.0, ok: bool = True,
                    ts: int | None = None) -> bool:
        """Append one turn row. Returns True when written; never raises."""
        if self._disabled:
            return False
        try:
            with self._lock:
                self._db.execute(
                    "INSERT INTO turns (ts, gw_id, session_name, cwd, provider, model,"
                    " input_tokens, output_tokens, cache_read, cache_write, cost_usd, ok)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (int(ts if ts is not None else time.time()), gw_id, session_name, cwd,
                     provider, model, int(input_tokens), int(output_tokens), int(cache_read),
                     int(cache_write), float(cost_usd), 1 if ok else 0),
                )
                self._db.commit()
            return True
        except Exception:
            log.exception("ledger write failed (%s)", self.path)
            return False

    # ------------------------------------------------------------- aggregates

    @staticmethod
    def _window(days: int) -> int:
        if not isinstance(days, int) or days <= 0:
            return DEFAULT_DAYS
        return min(days, MAX_DAYS)

    def _filters(self, days: int, model: str | None, provider: str | None) -> tuple[str, list]:
        # Calendar-day boundary in server-local time, not rolling seconds:
        # the per-day buckets group on local dates, so the window must be a
        # whole number of local days or chart bars stop summing to the totals.
        start = date.today() - timedelta(days=self._window(days) - 1)
        where = ["ts >= ?"]
        args: list = [int(time.mktime(start.timetuple()))]
        if model:
            if "/" in model:
                # Accept both the bare model name and omp's provider/model form.
                where.append("provider || '/' || model = ?")
            else:
                where.append("model = ?")
            args.append(model)
        if provider:
            where.append("provider = ?")
            args.append(provider)
        return " AND ".join(where), args

    @staticmethod
    def _empty_aggregate(days: int) -> dict:
        return {
            "days": days,
            "totals": {"turns": 0, "turnsOk": 0, "input": 0, "output": 0,
                       "cacheRead": 0, "cacheWrite": 0, "cost": 0.0},
            "perDay": [],
            "perModel": [],
        }

    def aggregate(self, days: int = DEFAULT_DAYS, model: str | None = None,
                  provider: str | None = None) -> dict:
        """Totals, per-day and per-model sums. Costs are raw sums of per-turn
        USD floats; clients round for display. perDay is exactly `days`
        gateway-local calendar buckets, zero-filled, oldest first, keyed by
        ISO date."""
        if self._disabled:
            return self._empty_aggregate(self._window(days))
        where, args = self._filters(days, model, provider)
        with self._lock:
            totals = self._db.execute(
                f"SELECT COUNT(*), COALESCE(SUM(ok = 1), 0), COALESCE(SUM(input_tokens), 0),"
                f" COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cache_read), 0),"
                f" COALESCE(SUM(cache_write), 0), COALESCE(SUM(cost_usd), 0)"
                f" FROM turns WHERE {where}", args).fetchone()
            rows = self._db.execute(
                f"SELECT date(ts, 'unixepoch', 'localtime') AS d, COALESCE(SUM(input_tokens), 0),"
                f" COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cost_usd), 0)"
                f" FROM turns WHERE {where} GROUP BY d ORDER BY d", args).fetchall()
            per_model = self._db.execute(
                f"SELECT provider, model, COUNT(*), COALESCE(SUM(input_tokens), 0),"
                f" COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cache_read), 0),"
                f" COALESCE(SUM(cost_usd), 0) FROM turns WHERE {where}"
                f" GROUP BY provider, model ORDER BY 7 DESC, 4 DESC", args).fetchall()
        n, ok_n, tin, tout, tread, twrite, cost = totals
        # Zero-fill: GROUP BY only emits buckets with turns, but the chart
        # wants one bar per day in the range. Calendar arithmetic on date
        # parts (never ms subtraction) stays correct across DST.
        by_date = {d: (i, o, c) for d, i, o, c in rows}
        first = date.today() - timedelta(days=self._window(days) - 1)
        per_day = []
        for k in range(self._window(days)):
            d = (first + timedelta(days=k)).isoformat()
            i, o, c = by_date.get(d, (0, 0, 0.0))
            per_day.append({"date": d, "input": i, "output": o, "cost": c})
        return {
            "days": self._window(days),
            "totals": {"turns": n, "turnsOk": ok_n, "input": tin, "output": tout,
                       "cacheRead": tread, "cacheWrite": twrite, "cost": cost},
            "perDay": per_day,
            "perModel": [{"provider": p, "model": m, "turns": t, "input": i, "output": o,
                          "cacheRead": cr, "cost": c} for p, m, t, i, o, cr, c in per_model],
        }

    def session_rollup(self, days: int = DEFAULT_DAYS) -> dict:
        if self._disabled:
            return {"days": self._window(days), "sessions": []}
        where, args = self._filters(days, None, None)
        with self._lock:
            rows = self._db.execute(
                f"SELECT session_name, cwd, COUNT(*), COALESCE(SUM(input_tokens), 0),"
                f" COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cache_read), 0),"
                f" COALESCE(SUM(cost_usd), 0), MAX(ts) FROM turns WHERE {where}"
                f" GROUP BY session_name, cwd ORDER BY 8 DESC", args).fetchall()
        return {
            "days": self._window(days),
            "sessions": [{"sessionName": n, "cwd": cw, "turns": t, "input": i, "output": o,
                          "cacheRead": cr, "cost": cs, "lastTs": ts}
                         for n, cw, t, i, o, cr, cs, ts in rows],
        }


_instance: Ledger | None = None
_instance_lock = threading.Lock()


def get_ledger() -> Ledger:
    """Process-wide ledger at the default (or OMPGW_LEDGER_DB) path."""
    global _instance
    with _instance_lock:
        if _instance is None:
            _instance = Ledger(ledger_path())
        return _instance


def record_turn(**kw) -> bool:
    """Bridge-facing sink. Never raises, even if the database cannot open."""
    try:
        return get_ledger().record_turn(**kw)
    except Exception:
        log.exception("ledger write failed")
        return False


def close_ledger() -> None:
    """Close the process-wide ledger (gateway shutdown). A later get_ledger()
    reconnects cleanly instead of using a closed connection."""
    global _instance
    with _instance_lock:
        if _instance is not None:
            _instance.close()
            _instance = None
