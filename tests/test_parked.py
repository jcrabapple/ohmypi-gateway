"""Unit tests for the parked-session registry: shutdown records every live
session with a transcript, boot restores them as asleep rows under their
original gw ids, broken rows are skipped, and stopped/failed sessions are
never parked.

Run: .venv/bin/python tests/test_parked.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gateway.bridge as bridge  # noqa: E402
from gateway.bridge import OmpSession, SessionManager  # noqa: E402


class ParkedTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ompgw-parked-")
        self.parked = Path(self.tmp.name) / "run" / "gateway-parked.json"
        patcher = mock.patch.object(bridge, "PARKED_PATH", self.parked)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.transcript = Path(self.tmp.name) / "s1.jsonl"
        self.transcript.write_text("{}\n")
        self.transcript2 = Path(self.tmp.name) / "s2.jsonl"
        self.transcript2.write_text("{}\n")

    def tearDown(self):
        self.tmp.cleanup()

    def live_session(self, gw_id: str, lifecycle: str = "running",
                     session_file: Path | None = None) -> OmpSession:
        s = OmpSession(cwd=self.tmp.name, session_file=str(session_file or self.transcript))
        s.gw_id = gw_id
        s.lifecycle = lifecycle
        return s

    async def test_write_and_restore_round_trip(self):
        m = SessionManager()
        s = self.live_session("gwA")
        asleep = self.live_session("gwB", lifecycle="asleep", session_file=self.transcript2)
        m.sessions = {"gwA": s, "gwB": asleep}
        await m.shutdown_all()
        self.assertTrue(self.parked.exists())
        rows = json.loads(self.parked.read_text())["parked"]
        self.assertEqual([r["gwId"] for r in rows], ["gwA", "gwB"])

        m2 = SessionManager()
        with mock.patch.object(bridge, "get_manager", lambda: m2):
            n = bridge.restore_parked()
        self.assertEqual(n, 2)
        self.assertEqual(sorted(m2.sessions), ["gwA", "gwB"])
        for gid, orig in (("gwA", s), ("gwB", asleep)):
            row = m2.sessions[gid]
            self.assertEqual(row.lifecycle, "asleep")
            self.assertTrue(row.exited)
            self.assertEqual(row.gw_id, orig.gw_id)
            self.assertEqual(row.omp_session_file, orig.omp_session_file)
            self.assertEqual(row.cwd, orig.cwd)
        self.assertEqual(m2.count_children(), 0)

    async def test_stopped_and_failed_never_parked(self):
        m = SessionManager()
        m.sessions = {
            "run": self.live_session("run"),
            "stop": self.live_session("stop", lifecycle="stopped"),
            "fail": self.live_session("fail", lifecycle="failed"),
        }
        await m.shutdown_all()
        rows = json.loads(self.parked.read_text())["parked"]
        self.assertEqual([r["gwId"] for r in rows], ["run"])

    async def test_broken_rows_skipped(self):
        m = SessionManager()
        gone = self.live_session("gone", session_file=self.tmp.name + "/missing.jsonl")
        m.sessions = {"ok": self.live_session("ok"), "gone": gone}
        await m.shutdown_all()
        m2 = SessionManager()
        with mock.patch.object(bridge, "get_manager", lambda: m2):
            n = bridge.restore_parked()
        self.assertEqual(n, 1)
        self.assertEqual(sorted(m2.sessions), ["ok"])

    async def test_empty_registry_unlinks_file(self):
        m = SessionManager()
        m.sessions = {"stop": self.live_session("stop", lifecycle="stopped")}
        self.parked.parent.mkdir(parents=True, exist_ok=True)
        self.parked.write_text('{"version":1,"parked":[]}')
        await m.shutdown_all()
        self.assertFalse(self.parked.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
