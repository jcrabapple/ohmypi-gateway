"""Unit tests for the usage ledger: aggregation math, calendar-day range
filtering, zero-filled per-day buckets, filters (bare and provider/model),
session rollup, empty-database first run, migration versioning, and the
never-raise sink. Also the bridge's turn-event ordering: the ledger row must
wait for prompt_result (which carries the final status), not agent_end.

Run: .venv/bin/python tests/test_ledger.py
"""

import asyncio
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gateway.bridge as bridge_mod  # noqa: E402
import gateway.ledger as ledger_mod  # noqa: E402
from gateway.ledger import DEFAULT_DAYS, Ledger, record_turn, split_model_id  # noqa: E402

NOW = int(time.time())
DAY = 86400


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ompgw-ledger-test-")
        self.db = Path(self.tmp.name) / "ledger.db"
        ledger_mod._instance = None
        self.ledger = Ledger(self.db)

    def tearDown(self):
        self.ledger.close()
        ledger_mod._instance = None
        self.tmp.cleanup()

    # ------------------------------------------------------------- first run

    def test_empty_db_first_run(self):
        a = self.ledger.aggregate(30)
        self.assertEqual(a["days"], 30)
        self.assertEqual(a["totals"], {
            "turns": 0, "turnsOk": 0, "input": 0, "output": 0,
            "cacheRead": 0, "cacheWrite": 0, "cost": 0.0})
        # Exactly `days` zero-filled gateway-local buckets, oldest first.
        self.assertEqual([d["date"] for d in a["perDay"]],
                         [(date.today() - timedelta(days=29 - k)).isoformat()
                          for k in range(30)])
        self.assertTrue(all(d["input"] == 0 and d["output"] == 0 and d["cost"] == 0
                            for d in a["perDay"]))
        self.assertEqual(a["perModel"], [])
        self.assertEqual(self.ledger.session_rollup(30),
                         {"days": 30, "sessions": []})
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal")

    # ------------------------------------------------------------ aggregates

    def seed(self):
        # Today, model A: one ok turn, one failed turn.
        self.ledger.record_turn(ts=NOW - 3600, gw_id="g1", session_name="probe", cwd="/w/a",
                                provider="z-ai", model="glm-5.3-flashx",
                                input_tokens=100, output_tokens=50, cache_read=10,
                                cache_write=5, cost_usd=0.5, ok=True)
        self.ledger.record_turn(ts=NOW - 60, gw_id="g1", session_name="probe", cwd="/w/a",
                                provider="z-ai", model="glm-5.3-flashx",
                                input_tokens=20, output_tokens=0, cost_usd=0.25, ok=False)
        # Yesterday, model B (cheaper cost, larger input than model A's ok turn).
        self.ledger.record_turn(ts=NOW - DAY - 60, session_name="other", cwd="/w/b",
                                provider="ollama", model="devstral:24b",
                                input_tokens=200, output_tokens=10, cache_read=30,
                                cost_usd=0.2, ok=True)
        # 40 days ago: outside every default window.
        self.ledger.record_turn(ts=NOW - 40 * DAY, session_name="old", cwd="/w/c",
                                provider="z-ai", model="glm-5.3-flashx",
                                input_tokens=999, output_tokens=999, cost_usd=9.0, ok=True)

    def test_totals_and_range_filtering(self):
        self.seed()
        a30 = self.ledger.aggregate(30)
        self.assertEqual(a30["totals"]["turns"], 3)
        self.assertEqual(a30["totals"]["turnsOk"], 2)
        self.assertEqual(a30["totals"]["input"], 320)
        self.assertEqual(a30["totals"]["output"], 60)
        self.assertEqual(a30["totals"]["cacheRead"], 40)
        self.assertEqual(a30["totals"]["cacheWrite"], 5)
        self.assertAlmostEqual(a30["totals"]["cost"], 0.95)
        # The 40-day-old row stays out of a 30-day window and rides in at 90.
        self.assertNotIn("old", [s["sessionName"] for s in self.ledger.session_rollup(30)["sessions"]])
        self.assertIn("old", [s["sessionName"] for s in self.ledger.session_rollup(90)["sessions"]])
        a90 = self.ledger.aggregate(90)
        self.assertEqual(a90["totals"]["turns"], 4)
        self.assertEqual(a90["totals"]["input"], 1319)

    def test_per_day_rows(self):
        self.seed()
        per_day = self.ledger.aggregate(30)["perDay"]
        today = time.strftime("%Y-%m-%d", time.localtime(NOW))
        yesterday = time.strftime("%Y-%m-%d", time.localtime(NOW - DAY))
        by_date = {d["date"]: d for d in per_day}
        self.assertEqual(by_date[today]["input"], 120)   # both of today's turns
        self.assertEqual(by_date[today]["output"], 50)
        self.assertAlmostEqual(by_date[today]["cost"], 0.75)
        self.assertEqual(by_date[yesterday]["input"], 200)
        self.assertEqual(by_date[yesterday]["output"], 10)

    def test_per_day_exactly_days_buckets(self):
        self.seed()
        a30 = self.ledger.aggregate(30)
        self.assertEqual(len(a30["perDay"]), 30)
        self.assertEqual([d["date"] for d in a30["perDay"]],
                         [(date.today() - timedelta(days=29 - k)).isoformat()
                          for k in range(30)])
        # Chart bars sum to the totals: idle days are zero-filled, not missing.
        self.assertEqual(sum(d["input"] for d in a30["perDay"]), a30["totals"]["input"])
        a7 = self.ledger.aggregate(7)
        self.assertEqual(len(a7["perDay"]), 7)
        # Today (120) and yesterday (200) are inside the 7-day calendar window;
        # the 40-day-old row stays out.
        self.assertEqual(sum(d["input"] for d in a7["perDay"]), 320)
        a1 = self.ledger.aggregate(1)
        self.assertEqual(len(a1["perDay"]), 1)
        # The calendar boundary includes the whole current local day.
        self.assertEqual(a1["perDay"][0]["date"], time.strftime("%Y-%m-%d", time.localtime(NOW)))
        self.assertEqual(a1["perDay"][0]["input"], 120)

    def test_per_model_breakdown_and_filters(self):
        self.seed()
        per_model = self.ledger.aggregate(30)["perModel"]
        # Ordered by cost desc: the z-ai pair (0.75) before ollama (0.2).
        self.assertEqual([m["provider"] for m in per_model], ["z-ai", "ollama"])
        self.assertEqual(per_model[0]["turns"], 2)
        self.assertEqual(per_model[0]["input"], 120)
        self.assertEqual(per_model[1]["cacheRead"], 30)
        # Exact filters.
        only_a = self.ledger.aggregate(30, model="glm-5.3-flashx")
        self.assertEqual(only_a["totals"]["turns"], 2)
        self.assertEqual(only_a["totals"]["input"], 120)
        only_o = self.ledger.aggregate(30, provider="ollama")
        self.assertEqual(only_o["totals"]["turns"], 1)
        self.assertEqual(only_o["totals"]["cost"], 0.2)
        self.assertEqual(self.ledger.aggregate(30, provider="nobody")["totals"]["turns"], 0)

    def test_model_filter_accepts_provider_form(self):
        self.seed()
        full = self.ledger.aggregate(30, model="z-ai/glm-5.3-flashx")
        self.assertEqual(full["totals"]["turns"], 2)
        self.assertEqual(full["totals"]["input"], 120)
        bare = self.ledger.aggregate(30, model="glm-5.3-flashx")
        self.assertEqual(bare["totals"]["turns"], 2)
        # provider/name matches on the whole pair, not the bare name.
        other = self.ledger.aggregate(30, model="ollama/glm-5.3-flashx")
        self.assertEqual(other["totals"]["turns"], 0)
        self.assertEqual(self.ledger.session_rollup(30)["sessions"][0]["turns"], 2)

    def test_days_clamped(self):
        self.assertEqual(self.ledger.aggregate(0)["days"], DEFAULT_DAYS)
        self.assertEqual(self.ledger.aggregate(-5)["days"], DEFAULT_DAYS)
        self.assertEqual(self.ledger.aggregate(100000)["days"], 365)
        self.assertEqual(self.ledger.session_rollup(100000)["days"], 365)

    def test_session_rollup(self):
        self.seed()
        sessions = self.ledger.session_rollup(90)["sessions"]
        # Newest activity first: the probe session's failed turn is 60s old.
        self.assertEqual([s["sessionName"] for s in sessions], ["probe", "other", "old"])
        probe = sessions[0]
        self.assertEqual(probe["cwd"], "/w/a")
        self.assertEqual(probe["turns"], 2)
        self.assertEqual(probe["input"], 120)
        self.assertEqual(probe["output"], 50)
        self.assertAlmostEqual(probe["cost"], 0.75)
        self.assertEqual(probe["lastTs"], NOW - 60)

    # ------------------------------------------------------------ write path

    def test_record_turn_defaults_and_ok_flag(self):
        self.assertTrue(self.ledger.record_turn(gw_id="gx"))
        row = self.ledger.aggregate(1)
        self.assertEqual(row["totals"]["turns"], 1)
        self.assertEqual(row["totals"]["turnsOk"], 1)
        self.assertTrue(self.ledger.record_turn(gw_id="gy", ok=False, cost_usd=1.5))
        self.assertEqual(self.ledger.aggregate(1)["totals"]["turnsOk"], 1)
        self.assertAlmostEqual(self.ledger.aggregate(1)["totals"]["cost"], 1.5)

    def test_split_model_id(self):
        self.assertEqual(split_model_id("z-ai/glm-5.3-flashx"), ("z-ai", "glm-5.3-flashx"))
        self.assertEqual(split_model_id("devstral:24b"), (None, "devstral:24b"))
        self.assertEqual(split_model_id("/weird"), (None, "weird"))
        self.assertEqual(split_model_id(None), (None, None))
        self.assertEqual(split_model_id(""), (None, None))

    def test_sink_never_raises_on_bad_path(self):
        blocker = Path(self.tmp.name) / "blocker"
        blocker.write_text("a file, so the db path below cannot be created")
        old = os.environ.get("OMPGW_LEDGER_DB")
        os.environ["OMPGW_LEDGER_DB"] = str(blocker / "x" / "l.db")
        try:
            # Parent is a file -> construction fails -> False, no raise.
            self.assertFalse(record_turn(gw_id="g1"))
        finally:
            if old is None:
                os.environ.pop("OMPGW_LEDGER_DB", None)
            else:
                os.environ["OMPGW_LEDGER_DB"] = old

    def test_sink_writes_through_env_path(self):
        scratch = Path(self.tmp.name) / "env.db"
        old = os.environ.get("OMPGW_LEDGER_DB")
        os.environ["OMPGW_LEDGER_DB"] = str(scratch)
        try:
            self.assertTrue(record_turn(gw_id="gz", input_tokens=7, output_tokens=3, cost_usd=0.1))
        finally:
            if old is None:
                os.environ.pop("OMPGW_LEDGER_DB", None)
            else:
                os.environ["OMPGW_LEDGER_DB"] = old
        led = Ledger(scratch)
        try:
            self.assertEqual(led.aggregate(1)["totals"]["input"], 7)
        finally:
            led.close()


    # ------------------------------------------------------------- migration

    def test_future_schema_refuses_and_degrades(self):
        with sqlite3.connect(self.db) as db:
            db.execute("PRAGMA user_version=99")
            db.commit()
        # A database from a NEWER gateway is never touched; the sink and the
        # read routes degrade to no-ops instead of corrupting it.
        led = Ledger(self.db)
        try:
            self.assertFalse(led.record_turn(gw_id="g1"))
            a = led.aggregate(7)
            self.assertEqual(a["totals"]["turns"], 0)
            self.assertEqual(a["perDay"], [])
            self.assertEqual(led.session_rollup(7)["sessions"], [])
            with sqlite3.connect(self.db) as db:
                self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 99)
        finally:
            led.close()


class BridgeLedgerTest(unittest.IsolatedAsyncioTestCase):
    """Drives OmpSession._dispatch directly (no child process) to pin the
    turn-event order: omp emits agent_end BEFORE prompt_result, so the row
    must wait for prompt_result, which carries the final status."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ompgw-ledger-bridge-")
        self.rows: list[dict] = []
        self._orig = bridge_mod.record_turn
        bridge_mod.record_turn = self._capture

    def _capture(self, **kw) -> bool:
        self.rows.append(kw)
        return True

    def tearDown(self):
        bridge_mod.record_turn = self._orig
        self.tmp.cleanup()

    def sess(self) -> bridge_mod.OmpSession:
        return bridge_mod.OmpSession(cwd=self.tmp.name)

    async def test_row_flushes_at_prompt_result_after_agent_end(self):
        s = self.sess()
        await s._dispatch({"type": "agent_start"})
        await s._dispatch({"type": "message_end", "message": {
            "role": "assistant", "model": "z-ai/glm-5.3-flashx",
            "usage": {"input": 10, "output": 5, "cacheRead": 2, "cacheWrite": 1,
                      "cost": {"total": 0.01}}}})
        await s._dispatch({"type": "agent_end", "messages": []})
        # agent_end alone must NOT write the row: the status is not final yet.
        self.assertEqual(self.rows, [])
        await s._dispatch({"type": "prompt_result", "status": "error"})
        self.assertEqual(len(self.rows), 1)
        row = self.rows[0]
        self.assertFalse(row["ok"])
        self.assertEqual(row["input_tokens"], 10)
        self.assertEqual(row["output_tokens"], 5)
        self.assertEqual(row["cache_read"], 2)
        self.assertEqual((row["provider"], row["model"]), ("z-ai", "glm-5.3-flashx"))
        # Late duplicate events never double-write.
        await s._dispatch({"type": "agent_end", "messages": []})
        await s._dispatch({"type": "prompt_result", "status": "ok"})
        self.assertEqual(len(self.rows), 1)

    async def test_ok_turn_records_ok_row(self):
        s = self.sess()
        await s._dispatch({"type": "agent_start"})
        await s._dispatch({"type": "message_end",
                           "message": {"usage": {"input": 3, "output": 2}}})
        await s._dispatch({"type": "agent_end", "messages": []})
        await s._dispatch({"type": "prompt_result", "status": "ok"})
        self.assertEqual(len(self.rows), 1)
        self.assertTrue(self.rows[0]["ok"])

    async def test_aborted_prompt_result_marks_failure(self):
        s = self.sess()
        await s._dispatch({"type": "agent_start"})
        await s._dispatch({"type": "message_end",
                           "message": {"usage": {"input": 3, "output": 2}}})
        await s._dispatch({"type": "agent_end", "messages": []})
        await s._dispatch({"type": "prompt_result", "status": "aborted"})
        self.assertEqual(len(self.rows), 1)
        self.assertFalse(self.rows[0]["ok"])

    async def test_agent_end_fallback_flushes_without_prompt_result(self):
        old = bridge_mod._LEDGER_PROMPT_GRACE_S
        bridge_mod._LEDGER_PROMPT_GRACE_S = 0.01
        try:
            s = self.sess()
            await s._dispatch({"type": "agent_start"})
            await s._dispatch({"type": "message_end",
                               "message": {"usage": {"input": 4, "output": 1}}})
            await s._dispatch({"type": "agent_end", "messages": []})
            await asyncio.sleep(0.05)
            self.assertEqual(len(self.rows), 1)
            self.assertTrue(self.rows[0]["ok"])
        finally:
            bridge_mod._LEDGER_PROMPT_GRACE_S = old

    async def test_stray_prompt_result_writes_nothing(self):
        s = self.sess()
        await s._dispatch({"type": "prompt_result", "status": "error"})
        self.assertEqual(self.rows, [])

    async def test_new_turn_resets_and_cancels_fallback(self):
        # agent_end without prompt_result, then a new turn starts: the stale
        # fallback timer must not fire into the new turn's accumulator.
        old = bridge_mod._LEDGER_PROMPT_GRACE_S
        bridge_mod._LEDGER_PROMPT_GRACE_S = 60.0
        try:
            s = self.sess()
            await s._dispatch({"type": "agent_start"})
            await s._dispatch({"type": "message_end",
                               "message": {"usage": {"input": 4, "output": 1}}})
            await s._dispatch({"type": "agent_end", "messages": []})
            await s._dispatch({"type": "agent_start"})
            await asyncio.sleep(0.02)
            self.assertEqual(self.rows, [])
            self.assertIsNone(s._turn_acc)
        finally:
            bridge_mod._LEDGER_PROMPT_GRACE_S = old


if __name__ == "__main__":
    unittest.main(verbosity=2)
