"""Unit tests for the gateway-owned follow-up queue: add-while-streaming
stays queued, fires head-first on a successful prompt_result, is retained on
aborted/failed turns, fires FIFO across consecutive turns, retries after a
refused submit, and survives task cancellation without losing entries.

Run: .venv/bin/python tests/test_queue.py
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gateway.bridge import OmpSession, RpcError  # noqa: E402


def make_session(tmp: str) -> OmpSession:
    return OmpSession(cwd=tmp)


class QueueTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ompgw-queue-")
        self.fired: list[str] = []
        fired = self.fired  # the mock's `self` is the OmpSession, not the test

        async def fake_prompt(self, message, wait=False, steer=False, timeout=600.0, images=None):
            fired.append(message)

        self.patchers = [mock.patch.object(OmpSession, "prompt", fake_prompt)]
        for p in self.patchers:
            p.start()

    def tearDown(self):
        for p in self.patchers:
            p.stop()
        self.tmp.cleanup()

    def turn_ok(self, s: OmpSession) -> None:
        """Drive a completed turn in omp's real order: agent_start, agent_end,
        then prompt_result (the queue fires there)."""
        async def run():
            await s._dispatch({"type": "agent_start"})
            await s._dispatch({"type": "agent_end", "messages": []})
            await s._dispatch({"type": "prompt_result", "status": "ok"})
        return run()

    def turn_aborted(self, s: OmpSession) -> None:
        async def run():
            await s._dispatch({"type": "agent_start"})
            await s._dispatch({"type": "agent_end", "messages": []})
            await s._dispatch({"type": "prompt_result", "status": "aborted"})
        return run()

    async def test_add_while_streaming_stays_queued(self):
        s = make_session(self.tmp.name)
        await s._dispatch({"type": "agent_start"})
        s.queue_add("first follow-up", None)
        await asyncio.sleep(0)
        self.assertEqual(len(s.queue), 1)
        self.assertEqual(self.fired, [])

    async def test_fires_on_successful_prompt_result(self):
        s = make_session(self.tmp.name)
        await s._dispatch({"type": "agent_start"})
        s.queue_add("first follow-up", None)
        await self.turn_ok(s)
        await asyncio.sleep(0.05)
        self.assertEqual(self.fired, ["first follow-up"])
        self.assertEqual(s.queue, [])
        # the fired prompt ran as its own turn: the next ok fires the next entry
        s.queue_add("second follow-up", None)
        await self.turn_ok(s)
        await asyncio.sleep(0.05)
        self.assertEqual(self.fired, ["first follow-up", "second follow-up"])

    async def test_fifo_order(self):
        s = make_session(self.tmp.name)
        await s._dispatch({"type": "agent_start"})
        s.queue_add("one", None)
        s.queue_add("two", None)
        s.queue_add("three", None)
        await self.turn_ok(s)
        await asyncio.sleep(0.05)
        self.assertEqual(self.fired, ["one"])
        self.assertEqual([e["message"] for e in s.queue], ["two", "three"])
        await self.turn_ok(s)
        await asyncio.sleep(0.05)
        self.assertEqual(self.fired, ["one", "two"])

    async def test_aborted_turn_keeps_queue(self):
        s = make_session(self.tmp.name)
        await s._dispatch({"type": "agent_start"})
        s.queue_add("keep me", None)
        await self.turn_aborted(s)
        await asyncio.sleep(0)
        self.assertEqual(len(s.queue), 1)
        self.assertEqual(self.fired, [])

    async def test_edit_and_remove(self):
        s = make_session(self.tmp.name)
        entry = s.queue_add("before", None)
        edited = s.queue_edit(entry["id"], message="after")
        self.assertEqual(edited["message"], "after")
        self.assertTrue(s.queue_remove(entry["id"]))
        self.assertFalse(s.queue_remove(entry["id"]))
        self.assertEqual(s.queue, [])

    async def test_refused_submit_retries_then_gives_up(self):
        s = make_session(self.tmp.name)
        attempts: list[str] = []

        async def refuse_then_accept(self, message, wait=False, steer=False, timeout=600.0, images=None):
            attempts.append(message)
            if len(attempts) < 3:
                raise RpcError("prompt", "session_busy", "session_busy")

        with mock.patch.object(OmpSession, "prompt", refuse_then_accept):
            s.QUEUE_RETRY_BASE_S = 0.01  # before the add: the first retry schedules on add
            s.queue_add("stubborn", None)
            await asyncio.sleep(0)
            for _ in range(20):
                await asyncio.sleep(0.05)
            self.assertEqual(attempts.count("stubborn"), 3)
            self.assertEqual(s.queue, [])  # accepted on the third attempt

    async def test_refused_submit_gives_up_after_five(self):
        s = make_session(self.tmp.name)
        s.QUEUE_RETRY_BASE_S = 0.01

        async def refuse(self, message, wait=False, steer=False, timeout=600.0, images=None):
            raise RpcError("prompt", "session_busy", "session_busy")

        with mock.patch.object(OmpSession, "prompt", refuse):
            s.QUEUE_RETRY_BASE_S = 0.01
            s.queue_add("doomed", None)
            await asyncio.sleep(0)
            for _ in range(40):
                await asyncio.sleep(0.02)
            self.assertEqual(len(s.queue), 1)  # stays queued, still visible/editable
            self.assertEqual(s.queue[0]["retries"], 6)

    async def test_cancelled_submit_keeps_entry(self):
        s = make_session(self.tmp.name)

        async def cancel_submit(self, message, wait=False, steer=False, timeout=600.0, images=None):
            raise asyncio.CancelledError()

        with mock.patch.object(OmpSession, "prompt", cancel_submit):
            s.queue_add("precious", None)
            await asyncio.sleep(0.05)
            self.assertEqual(len(s.queue), 1)
            self.assertEqual(s.queue[0]["message"], "precious")


if __name__ == "__main__":
    unittest.main(verbosity=1)
