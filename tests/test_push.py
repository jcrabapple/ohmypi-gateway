"""Unit tests for Web Push: VAPID generation/persistence, subscription
validation + dedupe, dead-subscription pruning, and the bridge's push trigger
(fires only when no WS subscriber is watching, one push per dialog).

Run: .venv/bin/python tests/test_push.py
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gateway.push as push_mod  # noqa: E402
from gateway.bridge import OmpSession  # noqa: E402

SUB = {"endpoint": "https://push.example.com/a", "keys": {"p256dh": "k", "auth": "a"}}
SUB2 = {"endpoint": "https://push.example.com/b", "keys": {"p256dh": "k2", "auth": "a2"}}


class PushTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ompgw-push-")
        self.patchers = [
            mock.patch.object(push_mod, "VAPID_FILE", Path(self.tmp.name) / "vapid.json"),
            mock.patch.object(push_mod, "SUBS_FILE", Path(self.tmp.name) / "subs.json"),
            mock.patch.object(push_mod, "_vapid", None),
        ]
        for p in self.patchers:
            p.start()

    def tearDown(self):
        for p in self.patchers:
            p.stop()
        self.tmp.cleanup()

    def test_vapid_generated_once_and_persisted(self):
        self.assertTrue(push_mod.available(), push_mod.unavailable_reason())
        first = push_mod.public_key()
        self.assertEqual(len(first), 87)  # uncompressed P-256 point, base64url
        push_mod._vapid = None  # force a reload from disk
        self.assertEqual(push_mod.public_key(), first)

    def test_subscribe_validates(self):
        with self.assertRaises(ValueError):
            push_mod.subscribe("http://insecure/x", SUB["keys"])  # not https
        with self.assertRaises(ValueError):
            push_mod.subscribe(SUB["endpoint"], {"p256dh": "k"})  # no auth
        self.assertEqual(push_mod.subscription_count(), 0)

    def test_subscribe_idempotent_per_endpoint(self):
        self.assertEqual(push_mod.subscribe(**SUB), 1)
        self.assertEqual(push_mod.subscribe(**SUB), 1)
        self.assertEqual(push_mod.subscribe(**SUB2), 2)
        self.assertEqual(push_mod.unsubscribe(SUB["endpoint"]), 1)
        self.assertEqual(push_mod.unsubscribe("https://push.example.com/gone"), 1)

    async def _push(self, sends, session=None):
        def fake_send(sub, payload):
            sends.append((sub["endpoint"], json.loads(payload)))
            return sub["endpoint"].endswith("/a")  # /b reports gone

        with mock.patch.object(push_mod, "_send_one", fake_send):
            return await push_mod.push_dialog(
                session or "gwt", "my session",
                {"id": "d1", "method": "select", "title": "Allow tool: bash\nCommand: ls"})

    async def test_push_dialog_payload_and_prune(self):
        push_mod.subscribe(**SUB)
        push_mod.subscribe(**SUB2)
        sends: list = []
        delivered = await self._push(sends)
        self.assertEqual(delivered, 1)
        endpoint, payload = sends[0]
        self.assertEqual(payload["gwId"], "gwt")
        self.assertIn("#/s/gwt", payload["url"])
        self.assertIn("Allow tool: bash", payload["body"])
        self.assertNotIn("\n", payload["body"])
        # the dead subscription is pruned from disk
        self.assertEqual(push_mod.subscription_count(), 1)

    async def test_push_dialog_no_subscribers_is_noop(self):
        sends: list = []
        self.assertEqual(await self._push(sends), 0)
        self.assertEqual(sends, [])


class BridgePushTriggerTest(unittest.IsolatedAsyncioTestCase):
    """Drives OmpSession._dispatch with no child: the dialog push fires only
    when nobody is subscribed to the session's events, once per dialog."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ompgw-push-bridge-")
        self.pushed: list[dict] = []

        async def fake_push_dialog(gw_id, session_name, dialog):
            self.pushed.append({"gwId": gw_id, "dialog": dialog})
            return 1

        self.patches = [
            mock.patch.object(push_mod, "push_dialog", fake_push_dialog),
            mock.patch.dict(sys.modules, {"gateway.push": push_mod}),
        ]
        for p in self.patches:
            p.start()

    async def asyncSetUp(self):
        self.sess = OmpSession(cwd=self.tmp.name)

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    async def dispatch_ui(self, dialog_id: str) -> None:
        await self.sess._dispatch({"type": "extension_ui_request", "id": dialog_id,
                                   "method": "select", "title": "Allow tool: bash",
                                   "options": ["Approve", "Deny"]})
        await asyncio.sleep(0)  # let the push task run

    async def test_pushes_once_without_subscribers(self):
        await self.dispatch_ui("r1")
        await self.dispatch_ui("r1")  # same dialog again: no second push
        self.assertEqual(len(self.pushed), 1)
        self.assertEqual(self.pushed[0]["gwId"], self.sess.gw_id)
        await self.dispatch_ui("r2")
        self.assertEqual(len(self.pushed), 2)

    async def test_no_push_when_a_client_is_watching(self):
        self.sess.subscribe()
        await self.dispatch_ui("r1")
        self.assertEqual(self.pushed, [])
        # once the watcher is gone, a NEW dialog pushes
        self.sess.unsubscribe(next(iter(self.sess.subscribers)))
        await self.dispatch_ui("r2")
        self.assertEqual(len(self.pushed), 1)
        self.assertEqual(self.pushed[0]["dialog"]["id"], "r2")

    async def test_answer_clears_dedupe_for_new_requests(self):
        await self.dispatch_ui("r1")
        self.sess.pending_ui.pop("r1", None)
        self.sess._pushed_dialogs.discard("r1")
        await self.dispatch_ui("r1")  # omp re-asks the same id: push again
        self.assertEqual(len(self.pushed), 2)

    async def test_push_disabled_is_quiet(self):
        with mock.patch.object(push_mod, "available", lambda: False):
            await self.dispatch_ui("r1")
        self.assertEqual(self.pushed, [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
