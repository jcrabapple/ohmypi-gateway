"""Collab discovery: entry parsing, socket query, registry/TTL reconciliation.

Run: .venv/bin/python tests/test_collab.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gateway import collab  # noqa: E402


def _snap(**over) -> dict:
    base = {
        "instanceId": "i" * 8,
        "generation": 1,
        "pid": 42,
        "sessionId": "01abcdef",
        "sessionName": "my session",
        "cwd": "/tmp/proj",
        "model": {"provider": "openrouter", "id": "m"},
        "startedAt": 1793016309423,
        "participants": 1,
        "relayConnected": True,
        "inputRequired": False,
        "busy": False,
        "access": "view",
    }
    base.update(over)
    return base


class EntryTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def write_entry(self, obj: object) -> Path:
        p = self.dir / "e.json"
        p.write_text(json.dumps(obj))
        return p

    def test_valid_entry(self):
        e = collab._read_entry(self.write_entry(
            {"version": 1, "instanceId": "i" * 8, "pid": 42,
             "endpoint": "/tmp/x.sock", "createdAt": 1, "token": "t" * 64}))
        self.assertEqual((e["instanceId"], e["pid"], e["token"]),
                         ("i" * 8, 42, "t" * 64))

    def test_rejects_bad_shapes(self):
        for bad in (
            {"version": 2, "instanceId": "i", "pid": 1,
             "endpoint": "/tmp/x.sock", "token": "t"},
            {"version": 1, "instanceId": "i", "pid": "1",
             "endpoint": "/tmp/x.sock", "token": "t"},
            {"version": 1, "instanceId": "i", "pid": 1,
             "endpoint": "x.sock", "token": "t"},
            {"version": 1, "instanceId": "i", "pid": 1,
             "endpoint": "/tmp/x.sock", "token": ""},
            {"version": 1, "instanceId": "i", "pid": 1,
             "endpoint": "/tmp/x.sock"},
            {},
        ):
            self.assertIsNone(collab._read_entry(self.write_entry(bad)))
        self.assertIsNone(collab._read_entry(self.dir / "missing.json"))

    def test_rejects_pid_zero_and_bad_json(self):
        self.assertIsNone(collab._read_entry(self.write_entry(
            {"version": 1, "instanceId": "i", "pid": 0,
             "endpoint": "/x.sock", "token": "t"})))
        p = self.dir / "garbage.json"
        p.write_text("not json")
        self.assertIsNone(collab._read_entry(p))


class QueryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        sock = str(Path(self._tmp.name) / "x.sock")
        self.payload_seen = None

        async def handler(reader, writer):
            line = await reader.readline()
            self.payload_seen = json.loads(line)
            writer.write(json.dumps({"ok": True, "v": 1,
                                     "snapshot": _snap()}).encode() + b"\n")
            await writer.drain()
            writer.close()

        self.server = await asyncio.start_unix_server(handler, sock)
        self.sock = sock
        self.handler = handler

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        self._tmp.cleanup()

    async def test_success(self):
        out = await collab._query(self.sock, {"v": 1, "token": "t", "op": "snapshot"})
        self.assertEqual(out["ok"], True)
        self.assertEqual(self.payload_seen["op"], "snapshot")

    async def test_reply_without_newline(self):
        async def handler(reader, writer):
            await reader.readline()
            writer.write(json.dumps({"ok": True, "v": 1,
                                     "snapshot": _snap()}).encode())
            await writer.drain()
            writer.close()

        srv = await asyncio.start_unix_server(handler, self.sock)
        try:
            out = await collab._query(self.sock, {"op": "snapshot"})
            self.assertEqual(out["ok"], True)
        finally:
            srv.close()
            await srv.wait_closed()

    async def test_oversized_reply_is_none(self):
        async def handler(reader, writer):
            await reader.readline()
            writer.write(b"x" * (collab.MAX_RESPONSE_BYTES + 1))
            await writer.drain()
            writer.close()

        srv = await asyncio.start_unix_server(handler, self.sock)
        try:
            self.assertIsNone(await collab._query(self.sock, {"op": "snapshot"}))
        finally:
            srv.close()
            await srv.wait_closed()

    async def test_missing_socket_raises_hard(self):
        # D6: ENOENT/ECONNREFUSED are re-raised (not swallowed as None) so
        # the poller can retire the row immediately.
        with self.assertRaises(FileNotFoundError):
            await collab._query("/nonexistent/dir/x.sock", {"op": "snapshot"})


class _FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class DiscoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.clock = _FakeClock()

    def tearDown(self):
        self._tmp.cleanup()

    # helpers ---------------------------------------------------------

    def write_entry(self, name: str, instance_id: str, endpoint: str,
                    token: str = "t" * 64, mtime: float | None = None) -> Path:
        p = self.dir / name
        p.write_text(json.dumps({"version": 1, "instanceId": instance_id,
                                 "pid": 42, "endpoint": endpoint,
                                 "createdAt": 1, "token": token}))
        if mtime is not None:
            os.utime(p, (mtime, mtime))
        return p

    async def serve(self, replies: list, sock_path: str):
        """Start a unix server; each item is a dict (sent with newline), a
        str (sent raw), or None (never reply). Pops one per connection."""
        async def handler(reader, writer):
            await reader.readline()
            try:
                r = replies.pop(0)
            except IndexError:
                r = None
            if r is not None:
                body = r.encode() if isinstance(r, str) else (json.dumps(r) + "\n").encode()
                writer.write(body)
                await writer.drain()
            writer.close()

        srv = await asyncio.start_unix_server(handler, sock_path)
        return srv, handler

    def make(self, on_ask=None):
        return collab.Discovery(self.dir, clock=self.clock, on_ask=on_ask)

    async def poll_with_servers(self, d, servers, snapshots):
        for srv in servers:
            pass  # servers kept alive by caller refs
        return await d.poll_once()

    # tests -----------------------------------------------------------

    async def test_two_live_hosts_listed(self):
        s1 = str(self.dir / "a.sock")
        s2 = str(self.dir / "b.sock")
        srv1, _ = await self.serve([{"ok": True, "v": 1,
                                     "snapshot": _snap(instanceId="aaa",
                                                       startedAt=2000)}], s1)
        srv2, _ = await self.serve([{"ok": True, "v": 1,
                                     "snapshot": _snap(instanceId="bbb",
                                                       startedAt=3000)}], s2)
        try:
            self.write_entry("a.json", "aaa", s1)
            self.write_entry("b.json", "bbb", s2)
            d = self.make()
            await d.poll_once()
            rows = d.snapshot()
            self.assertEqual([r["instanceId"] for r in rows], ["bbb", "aaa"])
            self.assertEqual(rows[0]["kind"], "external")
            self.assertEqual(rows[0]["model"], {"provider": "openrouter", "id": "m"})
            self.assertEqual(rows[0]["stale"], False)
            self.assertIsNone(rows[0]["ask"])
            self.assertEqual(rows[0]["access"], "view")
        finally:
            srv1.close()
            srv2.close()

    async def test_ask_mint_and_stability(self):
        s = str(self.dir / "a.sock")
        srv, _ = await self.serve([{"ok": True, "v": 1, "snapshot": _snap(
            inputRequired=False)},
            {"ok": True, "v": 1, "snapshot": _snap(inputRequired=True)},
            {"ok": True, "v": 1, "snapshot": _snap(inputRequired=True)}], s)
        try:
            self.write_entry("a.json", "aaa", s)
            calls = []

            async def on_ask(row, ask):
                calls.append((row["instanceId"], ask))

            d = self.make(on_ask=on_ask)
            await d.poll_once()
            self.assertEqual(calls, [])
            await d.poll_once()
            self.assertEqual(len(calls), 1)
            first = d.snapshot()[0]["ask"]
            self.assertTrue(first["requestId"])
            self.assertEqual(calls[0][1], first)
            await d.poll_once()
            self.assertEqual(len(calls), 1, "must not re-fire")
            self.assertEqual(d.snapshot()[0]["ask"], first)
        finally:
            srv.close()

    async def test_ask_dropped_on_false_and_on_generation_change(self):
        s = str(self.dir / "a.sock")
        srv, _ = await self.serve([{"ok": True, "v": 1, "snapshot": _snap(
            inputRequired=True)},
            {"ok": True, "v": 1, "snapshot": _snap(inputRequired=False)},
            {"ok": True, "v": 1, "snapshot": _snap(inputRequired=True)},
            {"ok": True, "v": 1, "snapshot": _snap(inputRequired=True,
                                                   generation=2)}], s)
        try:
            self.write_entry("a.json", "aaa", s)
            d = self.make()
            await d.poll_once()
            first = d.snapshot()[0]["ask"]
            self.assertIsNotNone(first)
            await d.poll_once()
            self.assertIsNone(d.snapshot()[0]["ask"])
            await d.poll_once()
            second = d.snapshot()[0]["ask"]
            self.assertIsNotNone(second)
            self.assertNotEqual(second["requestId"], first["requestId"])
            await d.poll_once()
            self.assertIsNone(d.snapshot()[0]["ask"], "generation change drops ask")
        finally:
            srv.close()

    async def test_enoent_retires_immediately(self):
        s = str(self.dir / "a.sock")
        srv, _ = await self.serve([{"ok": True, "v": 1,
                                    "snapshot": _snap()}], s)
        try:
            self.write_entry("a.json", "aaa", s)
            d = self.make()
            await d.poll_once()
            self.assertEqual(len(d.snapshot()), 1)
            await asyncio.wait_for(asyncio.to_thread(os.unlink, s), 2)
            await d.poll_once()
            self.assertEqual(d.snapshot(), [])
        finally:
            srv.close()

    async def test_hung_server_stale_then_ttl_expiry(self):
        s = str(self.dir / "a.sock")
        srv, _ = await self.serve([
            {"ok": True, "v": 1, "snapshot": _snap()},   # good observation
            None,                                        # hung server
            None,                                        # hung again, past TTL
        ], s)
        try:
            self.write_entry("a.json", "aaa", s)
            d = self.make()
            await d.poll_once()
            self.assertEqual(d.snapshot()[0]["stale"], False)
            # still within TTL -> retained, stale
            self.clock.now += collab.TTL_S - 1
            await d.poll_once()
            row = d.snapshot()[0]
            self.assertEqual((row["stale"], row["participants"]), (True, 1))
            self.assertGreater(row["lastSeenAt"], 0)
            # past TTL -> retired
            self.clock.now += 2
            await d.poll_once()
            self.assertEqual(d.snapshot(), [])
        finally:
            srv.close()

    async def test_bad_replies_keep_row_stale(self):
        s = str(self.dir / "a.sock")
        priv = _snap()
        priv["prompt"] = "secret text"
        srv, _ = await self.serve([
            {"ok": True, "v": 1, "snapshot": _snap()},            # good row
            {"ok": False, "v": 1, "error": "snapshot_unavailable"},
            "not json at all",
            priv,
        ], s)
        try:
            self.write_entry("a.json", "aaa", s)
            d = self.make()
            await d.poll_once()
            self.assertEqual(d.snapshot()[0]["stale"], False)
            await d.poll_once()
            row = d.snapshot()[0]
            self.assertEqual(row["stale"], True)
            self.assertEqual(row["title"], "my session")
            await d.poll_once()
            self.assertEqual(d.snapshot()[0]["stale"], True)
            await d.poll_once()
            row = d.snapshot()[0]
            self.assertEqual(row["stale"], True)
            blob = json.dumps(row)
            self.assertNotIn("prompt", blob)
            self.assertNotIn("secret text", blob)
        finally:
            srv.close()

    async def test_max_entries_and_dotfiles(self):
        s = str(self.dir / "a.sock")

        async def handler(reader, writer):
            line = await reader.readline()
            tok = json.loads(line)["token"]
            n = int(tok[3:])
            writer.write((json.dumps({"ok": True, "v": 1,
                                      "snapshot": _snap(instanceId=f"id{n:03d}",
                                                        startedAt=n)}) + "\n").encode())
            await writer.drain()
            writer.close()

        srv = await asyncio.start_unix_server(handler, s)
        base = time.time()
        try:
            for i in range(collab.MAX_ENTRIES + 5):
                self.write_entry(f"{i:03d}.json", f"id{i:03d}", s,
                                 token=f"tok{i:03d}", mtime=base + i)
            (self.dir / ".hidden.json").write_text("{}")
            d = self.make()
            await d.poll_once()
            rows = d.snapshot()
            self.assertEqual(len(rows), collab.MAX_ENTRIES)
            self.assertNotIn("id041", [r["instanceId"] for r in rows])
            self.assertEqual(rows[0]["instanceId"], "id036")  # newest mtime first
        finally:
            srv.close()

    async def test_title_bounded(self):
        s = str(self.dir / "a.sock")
        srv, _ = await self.serve([{"ok": True, "v": 1,
                                    "snapshot": _snap(sessionName="x" * 5000)}], s)
        try:
            self.write_entry("a.json", "aaa", s)
            d = self.make()
            await d.poll_once()
            self.assertEqual(len(d.snapshot()[0]["title"]), collab.MAX_TITLE)
        finally:
            srv.close()

    async def test_link(self):
        s = str(self.dir / "a.sock")
        srv, _ = await self.serve([
            {"ok": True, "v": 1, "snapshot": _snap()},
            {"ok": True, "v": 1, "url": "https://my.omp.sh/#k"},
            {"ok": False, "v": 1, "error": "stale_generation"},
            {"ok": False, "v": 1, "error": "access_unavailable"},
            {"ok": False, "v": 1, "error": "authentication_failed"},
        ], s)
        try:
            self.write_entry("a.json", "aaa", s)
            d = self.make()
            await d.poll_once()
            url = await d.link("aaa", 1, "view")
            self.assertEqual(url, {"url": "https://my.omp.sh/#k"})
            with self.assertRaises(collab.CollabError) as cm:
                await d.link("aaa", 1, "view")
            self.assertEqual(cm.exception.code, "stale_generation")
            with self.assertRaises(collab.CollabError) as cm:
                await d.link("aaa", 1, "view")
            self.assertEqual(cm.exception.code, "access_unavailable")
            with self.assertRaises(collab.CollabError) as cm:
                await d.link("aaa", 1, "view")
            self.assertEqual(cm.exception.code, "unreachable")
            with self.assertRaises(collab.CollabError) as cm:
                await d.link("zzz", 1, "view")
            self.assertEqual(cm.exception.code, "not_found")
        finally:
            srv.close()

    async def test_start_stop_loop(self):
        d = self.make()
        await d.start()
        await d.start()  # idempotent
        self.assertTrue(d._task is not None and not d._task.done())
        await d.stop()
        self.assertTrue(d._task is None or d._task.done())

    async def test_wrong_typed_snapshot_never_raises_from_snapshot(self):
        """A host that reports generation as a string must not 500 the list:
        the row stays as it was (stale) instead of being cast in _public_row."""
        s = str(self.dir / "a.sock")
        srv, _ = await self.serve([
            {"ok": True, "v": 1, "snapshot": _snap(instanceId="aaa")},
            {"ok": True, "v": 1, "snapshot": _snap(instanceId="aaa",
                                                   generation="two")},
        ], s)
        try:
            self.write_entry("a.json", "aaa", s)
            d = self.make()
            await d.poll_once()
            self.assertEqual(d.snapshot()[0]["generation"], 1)
            await d.poll_once()
            rows = d.snapshot()
            self.assertEqual(rows[0]["generation"], 1)
            self.assertTrue(rows[0]["stale"])
        finally:
            srv.close()

    async def test_stats_are_counted_and_copied(self):
        s = str(self.dir / "a.sock")
        srv, _ = await self.serve([
            {"ok": True, "v": 1, "snapshot": _snap(instanceId="aaa")},
            {"ok": True, "v": 1, "snapshot": _snap(instanceId="aaa",
                                                   inputRequired=True)},
        ], s)
        try:
            self.write_entry("a.json", "aaa", s)
            d = self.make()
            st = d.stats()
            self.assertEqual((st["polls"], st["queries"], st["asksMinted"]), (0, 0, 0))
            await d.poll_once()
            await d.poll_once()
            d.note_push(2)
            d.note_push(None)
            st = d.stats()
            self.assertEqual(st["polls"], 2)
            self.assertEqual(st["queries"], 2)
            self.assertEqual(st["hostsSeenMax"], 1)
            self.assertEqual(st["asksMinted"], 1)
            self.assertEqual(st["pushesSent"], 2)
            self.assertGreater(st["lastPollMs"], 0)
            self.assertEqual(st["queryFailures"], {"noReply": 0, "gone": 0, "osError": 0})
            # A caller mutating the returned dict must not touch the registry.
            st["queryFailures"]["noReply"] = 99
            self.assertEqual(d.stats()["queryFailures"]["noReply"], 0)

            # A dead socket after the host was seen counts as "gone".
            srv.close()
            Path(s).unlink(missing_ok=True)
            await d.poll_once()
            self.assertEqual(d.stats()["queryFailures"]["gone"], 1)
        finally:
            srv.close()

    async def test_absent_directory_is_quiet(self):
        """No published hosts (collab off) is the normal empty state: no rows,
        no warning, and no state left behind that would suppress a real one."""
        d = collab.Discovery(self.dir / "does-not-exist", clock=self.clock)
        with self.assertNoLogs("gateway.collab", level="WARNING"):
            await d.poll_once()
        self.assertEqual(d.snapshot(), [])

    async def test_stalled_host_times_out_instead_of_hanging_the_round(self):
        """A socket that accepts, reads the request and never answers must not
        hang poll_once: the deadline has to cover the read, not just connect."""
        s = str(self.dir / "slow.sock")

        async def stall(reader, writer):
            await reader.readline()
            await asyncio.sleep(30)      # never reply, never close
            writer.close()

        srv = await asyncio.start_unix_server(stall, s)
        try:
            self.write_entry("a.json", "aaa", s)
            d = self.make()
            started = time.monotonic()
            await asyncio.wait_for(d.poll_once(), 10)
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 4, "poll round waited on a stalled host")
            self.assertEqual(d.snapshot(), [])
        finally:
            srv.close()

    async def test_unreadable_entry_keeps_row_and_ask(self):
        """A present entry that fails to parse this round is not evidence the
        host exited: the row and its ask identity must survive, with no second
        push for the same question."""
        s = str(self.dir / "a.sock")
        pushes: list[tuple[dict, dict]] = []

        async def on_ask(row, ask):
            pushes.append((row, ask))

        srv, _ = await self.serve([{"ok": True, "v": 1, "snapshot": _snap(
            instanceId="aaa", inputRequired=True)}], s)
        try:
            entry = self.write_entry("a.json", "aaa", s)
            d = self.make(on_ask=on_ask)
            await d.poll_once()
            ask = d.snapshot()[0]["ask"]
            self.assertEqual(len(pushes), 1)

            entry.write_text("{ not json")          # torn read, file still there
            await d.poll_once()
            rows = d.snapshot()
            self.assertEqual(len(rows), 1)
            self.assertTrue(rows[0]["stale"])
            self.assertEqual(rows[0]["ask"]["requestId"], ask["requestId"])
            self.assertEqual(len(pushes), 1, "re-minted instead of keeping the ask")
        finally:
            srv.close()

    async def test_dangling_symlink_does_not_inert_discovery(self):
        s = str(self.dir / "a.sock")
        srv, _ = await self.serve([{"ok": True, "v": 1, "snapshot": _snap(
            instanceId="aaa")}], s)
        try:
            self.write_entry("a.json", "aaa", s)
            (self.dir / "broken.json").symlink_to(self.dir / "gone.json")
            d = self.make()
            await d.poll_once()
            self.assertEqual([r["instanceId"] for r in d.snapshot()], ["aaa"])
        finally:
            srv.close()

    async def test_entry_cap_does_not_evict_tracked_hosts(self):
        """>MAX_ENTRIES newer entries must not evict an already-tracked host: its
        entry file is old only because the session is long-running."""
        s = str(self.dir / "a.sock")
        srv, _ = await self.serve([{"ok": True, "v": 1, "snapshot": _snap(
            instanceId="aaa")}], s)
        try:
            self.write_entry("aaa.json", "aaa", s, mtime=1000)
            d = self.make()
            await d.poll_once()
            self.assertEqual([r["instanceId"] for r in d.snapshot()], ["aaa"])

            for i in range(collab.MAX_ENTRIES + 8):
                self.write_entry(f"n{i:02d}.json", f"n{i:02d}",
                                 str(self.dir / f"dead{i}.sock"), mtime=5000 + i)
            await d.poll_once()
            ids = [r["instanceId"] for r in d.snapshot()]
            self.assertIn("aaa", ids)
        finally:
            srv.close()

    async def test_fresh_host_admitted_when_the_cap_is_saturated(self):
        """A full cap of long-lived tracked hosts must not starve a brand new
        session off the rail: a few slots stay reserved for unseen entries."""
        by_endpoint: dict[str, str] = {}

        async def fake_query(endpoint, payload):
            return {"ok": True, "v": 1, "snapshot": _snap(
                instanceId=by_endpoint[endpoint])}

        from unittest import mock
        with mock.patch.object(collab, "_query", fake_query):
            for i in range(collab.MAX_ENTRIES):
                sock = str(self.dir / f"k{i:02d}.sock")
                iid = f"k{i:02d}"
                by_endpoint[sock] = iid
                self.write_entry(f"k{i:02d}.json", iid, sock)
            d = self.make()
            await d.poll_once()
            self.assertEqual(len(d.snapshot()), collab.MAX_ENTRIES)

            # A session started now, with every slot already taken by hosts
            # that keep answering (so TTL never frees one).
            sock = str(self.dir / "new.sock")
            by_endpoint[sock] = "zz-new"
            self.write_entry("new.json", "zz-new", sock, mtime=9999)
            await d.poll_once()
            rows = d.snapshot()
            ids = [r["instanceId"] for r in rows]
            self.assertIn("zz-new", ids)
            # The cap bounds how many hosts are QUERIED per round. A tracked
            # host squeezed out of this round may linger stale until TTL (its
            # entry file still exists), so only fresh rows are capped.
            self.assertLessEqual(sum(1 for r in rows if not r["stale"]),
                                 collab.MAX_ENTRIES)
            self.assertTrue(any(r["stale"] for r in rows))

    async def test_last_seen_is_last_success_not_now(self):
        s = str(self.dir / "a.sock")
        srv, _ = await self.serve([{"ok": True, "v": 1, "snapshot": _snap(
            instanceId="aaa")}, None], s)
        try:
            self.write_entry("a.json", "aaa", s)
            d = self.make()
            await d.poll_once()
            seen = d.snapshot()[0]["lastSeenAt"]
            # Time passes (under TTL_S) and then the host goes quiet.
            self.clock.now += 20
            await d.poll_once()
            row = d.snapshot()[0]
            self.assertTrue(row["stale"])
            self.assertEqual(row["lastSeenAt"], seen)
        finally:
            srv.close()

    async def test_link_when_socket_vanished_is_unreachable(self):
        """A dead endpoint surfaces as CollabError('unreachable'), never as a
        bare FileNotFoundError that would escape the HTTP handler as a 500."""
        s = str(self.dir / "a.sock")
        srv, _ = await self.serve([{"ok": True, "v": 1, "snapshot": _snap(
            instanceId="aaa")}], s)
        try:
            self.write_entry("a.json", "aaa", s)
            d = self.make()
            await d.poll_once()
        finally:
            srv.close()
        Path(s).unlink(missing_ok=True)
        with self.assertRaises(collab.CollabError) as cm:
            await d.link("aaa", 1, "view")
        self.assertEqual(cm.exception.code, "unreachable")

    async def test_listing_failure_does_not_retire_rows(self):
        """iterdir/stat failing is not evidence a host exited: the rows and the
        ask identity survive the round, and no reconciliation happens."""
        s = str(self.dir / "a.sock")
        srv, _ = await self.serve([{"ok": True, "v": 1, "snapshot": _snap(
            instanceId="aaa", inputRequired=True)}], s)
        try:
            self.write_entry("a.json", "aaa", s)
            d = self.make()
            await d.poll_once()
            ask = d.snapshot()[0]["ask"]
            self.assertIsNotNone(ask)
            from unittest import mock
            with mock.patch.object(d, "_list_entries",
                                   side_effect=OSError(5, "boom")):
                await d.poll_once()
                await d.poll_once()  # second failure must not spam or retire
            rows = d.snapshot()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["ask"]["requestId"], ask["requestId"])
        finally:
            srv.close()


if __name__ == "__main__":
    unittest.main()
