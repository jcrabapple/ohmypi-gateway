"""Unit tests for idle sleep/wake: sleep stops the child but keeps the
session record (identity, backlog), the next command or find-by-file wakes
the record instead of duplicating the child, and asleep rows never occupy a
child slot.

Run: .venv/bin/python tests/test_sleep.py
"""

from __future__ import annotations

import asyncio
import contextlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gateway.bridge import OmpSession, ProcessDead, SessionManager  # noqa: E402


def make_session(tmp: str) -> OmpSession:
    return OmpSession(cwd=tmp)


async def put_to_sleep(s: OmpSession) -> None:
    s.ready.exception() if s.ready.done() else None
    await s.sleep()
    with contextlib.suppress(ProcessDead):
        s.ready.exception()


class SleepTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ompgw-sleep-")

    def tearDown(self):
        self.tmp.cleanup()

    async def test_sleep_keeps_the_record(self):
        s = make_session(self.tmp.name)
        s.omp_session_file = "/tmp/ompgw-test/some-session.jsonl"
        await put_to_sleep(s)
        self.assertEqual(s.lifecycle, "asleep")
        self.assertTrue(s.exited)
        m = SessionManager()
        m.sessions[s.gw_id] = s
        await m.reap_dead()
        self.assertIn(s.gw_id, m.sessions)
        self.assertEqual(m.count_children(), 0)
        self.assertEqual(m.list_live()[0]["lifecycle"], "asleep")

    async def test_command_wakes_a_sleeping_session(self):
        s = make_session(self.tmp.name)
        s.omp_session_file = "/tmp/ompgw-test/some-session.jsonl"
        await put_to_sleep(s)
        starts: list[str] = []

        async def fake_start(self, startup_timeout: float = 60.0):
            starts.append(self.resume_session_file)

        async def fake_send(self, frame):
            raise RuntimeError("no child in the fake")

        with mock.patch.object(OmpSession, "start", fake_start), \
                mock.patch.object(OmpSession, "send_raw", fake_send):
            # The command itself fails (no real child), but the wake must
            # have happened first and stuck.
            with contextlib.suppress(Exception):
                await s.command("get_state")
        self.assertEqual(len(starts), 1)
        self.assertTrue(starts[0].endswith("some-session.jsonl"))
        self.assertEqual(s.lifecycle, "running")

    async def test_wake_failure_marks_failed(self):
        s = make_session(self.tmp.name)
        await put_to_sleep(s)

        async def failing_start(self, startup_timeout: float = 60.0):
            raise RuntimeError("resume refused")

        with mock.patch.object(OmpSession, "start", failing_start):
            with contextlib.suppress(Exception):
                await s.command("get_state")
        self.assertEqual(s.lifecycle, "failed")
        self.assertIn("resume refused", s.restart_reason)

    async def test_find_by_file_prefers_the_asleep_record(self):
        s = make_session(self.tmp.name)
        s.omp_session_file = "/tmp/ompgw-test/some-session.jsonl"
        await put_to_sleep(s)
        m = SessionManager()
        m.sessions[s.gw_id] = s
        found = m.find_by_file("/tmp/ompgw-test/some-session.jsonl")
        self.assertIs(found, s)

    async def test_sleep_clears_pending_ui(self):
        s = make_session(self.tmp.name)
        s.pending_ui["req-1"] = {"id": "req-1", "method": "confirm"}
        await put_to_sleep(s)
        self.assertEqual(s.pending_ui, {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
