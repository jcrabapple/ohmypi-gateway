"""Unit tests for crash supervision: an unexpected child exit restarts the
session with backoff on the same OmpSession (kept gw_id, event backlog and
replay cursor), a successful restart refills the budget, exhausting the
budget marks the session failed, and a deliberate stop never restarts.

Run: .venv/bin/python tests/test_supervisor.py
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gateway.bridge import OmpSession, RESTART_BUDGET  # noqa: E402


def make_session(tmp: str) -> OmpSession:
    s = OmpSession(cwd=tmp)
    s.RESTART_BACKOFF_BASE_S = 0.005
    s.RESTART_BACKOFF_MAX_S = 0.02
    return s


async def wait_for(pred, timeout: float = 2.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while not pred():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.005)


def crash(s: OmpSession) -> None:
    """Kill the (fake) child. Retrieve the ProcessDead the ready future
    carries so asyncio does not log it at GC time."""
    s._on_exit()
    s.ready.exception()


class SupervisorTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ompgw-supervisor-")

    def tearDown(self):
        self.tmp.cleanup()

    def supervise(self, s: OmpSession):
        task = asyncio.create_task(s._supervise())
        self.addCleanup(self.cancel, task)
        return task

    def cancel(self, task: asyncio.Task):
        task.cancel()

    def lifecycle_events(self, s: OmpSession) -> list[str]:
        return [e.get("lifecycle") for _, e in s.backlog if e.get("type") == "lifecycle"]

    async def test_crash_restarts_with_resume_file(self):
        s = make_session(self.tmp.name)
        starts = []
        started = asyncio.Event()

        async def fake_start(self, startup_timeout: float = 60.0):
            starts.append(self.resume_session_file)
            started.set()

        with mock.patch.object(OmpSession, "start", fake_start):
            self.supervise(s)
            # The child reported a session file before dying mid-turn.
            s.omp_session_file = "/tmp/ompgw-test/some-session.jsonl"
            crash(s)
            await wait_for(lambda: bool(starts) and s.lifecycle == "running")
        self.assertEqual(s.omp_session_file, starts[-1])
        self.assertEqual(starts[-1].endswith("some-session.jsonl"), True)
        self.assertEqual(s.crash_count, 0)
        self.assertEqual(s.total_crashes, 1)
        # Same object identity: gw_id, subscribers and the backlog survive.
        self.assertIn("lifecycle", [e.get("type") for _, e in s.backlog])
        self.assertEqual(self.lifecycle_events(s), ["restarting", "running"])

    async def test_budget_exhaustion_marks_failed(self):
        s = make_session(self.tmp.name)

        async def failing_start(self, startup_timeout: float = 60.0):
            raise RuntimeError("omp refuses to start")

        with mock.patch.object(OmpSession, "start", failing_start):
            self.supervise(s)
            crash(s)
            await wait_for(lambda: s.lifecycle == "failed")
        self.assertEqual(s.total_crashes, RESTART_BUDGET)
        self.assertIn("omp refuses to start", s.restart_reason)
        self.assertEqual(self.lifecycle_events(s)[-1], "failed")

    async def test_successful_restart_refills_budget(self):
        s = make_session(self.tmp.name)
        starts = 0

        async def fake_start(self, startup_timeout: float = 60.0):
            nonlocal starts
            starts += 1

        with mock.patch.object(OmpSession, "start", fake_start):
            self.supervise(s)
            for i in range(RESTART_BUDGET + 1):
                crash(s)
                await wait_for(lambda: starts == i + 1)
        self.assertEqual(starts, RESTART_BUDGET + 1)
        self.assertEqual(s.crash_count, 0)
        self.assertEqual(s.lifecycle, "running")

    async def test_deliberate_stop_never_restarts(self):
        s = make_session(self.tmp.name)
        starts = []

        async def fake_start(self, startup_timeout: float = 60.0):
            starts.append(1)

        with mock.patch.object(OmpSession, "start", fake_start):
            self.supervise(s)
            await s.stop()
            s.ready.exception()  # the fake never awaits it; mark retrieved
            await asyncio.sleep(0.05)
            self.assertEqual(s.lifecycle, "stopped")
            self.assertEqual(starts, [])
            self.assertEqual(self.lifecycle_events(s), [])

    async def test_reaper_keeps_failed_drops_stopped(self):
        s = make_session(self.tmp.name)
        from gateway.bridge import SessionManager
        m = SessionManager()
        s.exited = True
        s.lifecycle = "failed"
        m.sessions[s.gw_id] = s
        dead = make_session(self.tmp.name)
        dead.exited = True
        dead.lifecycle = "stopped"
        m.sessions[dead.gw_id] = dead
        await m.reap_dead()
        self.assertIn(s.gw_id, m.sessions)
        self.assertNotIn(dead.gw_id, m.sessions)

    async def test_count_children_ignores_records(self):
        s = make_session(self.tmp.name)
        from gateway.bridge import SessionManager
        m = SessionManager()
        m.sessions[s.gw_id] = s
        self.assertEqual(m.count_children(), 1)
        s.exited = True
        self.assertEqual(m.count_children(), 0)
        s.lifecycle = "restarting"
        self.assertEqual(m.count_children(), 1)
        s.lifecycle = "failed"
        self.assertEqual(m.count_children(), 0)
        s.lifecycle = "asleep"
        self.assertEqual(m.count_children(), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
