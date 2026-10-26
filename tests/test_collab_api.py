"""Unit tests for the collab HTTP surface (Lane A): push_attention payload
shape, dead-subscription pruning through _fan_out, and the CollabError ->
HTTP status mapping used by POST /api/collab/{instanceId}/link.

Run: .venv/bin/python tests/test_collab_api.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gateway.push as push_mod  # noqa: E402
from gateway import collab  # noqa: E402
from gateway.main import _COLLAB_LINK_STATUS  # noqa: E402

# Same well-formed keys as tests/test_push.py (65-byte P-256 point, 16-byte
# auth secret, base64url).
import base64  # noqa: E402

_POINT = bytes([0x04]) + bytes(((i * 7 + 1) % 256 for i in range(64)))
P256DH = base64.urlsafe_b64encode(_POINT).rstrip(b"=").decode()
AUTH = base64.urlsafe_b64encode(bytes(range(16))).rstrip(b"=").decode()
KEYS = {"p256dh": P256DH, "auth": AUTH}
SUB = {"endpoint": "https://push.example.com/a", "keys": KEYS}
SUB2 = {"endpoint": "https://push.example.com/b", "keys": KEYS}


class PushTest(unittest.IsolatedAsyncioTestCase):
    """IsolatedAsyncioTestCase on purpose: async tests on plain TestCase
    never run their assertions."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ompgw-collab-api-")
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

    async def test_push_attention_payload_shape(self):
        push_mod.subscribe(**SUB)
        seen: list[tuple[str, dict]] = []

        def fake_send(sub, payload):
            seen.append((sub["endpoint"], json.loads(payload)))
            return True

        with mock.patch.object(push_mod, "_send_one", fake_send):
            delivered = await push_mod.push_attention("inst-1", "my session", "req-9")
        self.assertEqual(delivered, 1)
        _, payload = seen[0]
        self.assertEqual(payload["title"], "omp needs you")
        self.assertEqual(payload["body"], "my session is waiting for input")
        self.assertEqual(payload["tag"], "omp-attention-inst-1-req-9")
        self.assertEqual(payload["url"], "/")

    async def test_push_attention_body_is_capped(self):
        push_mod.subscribe(**SUB)
        seen: list[dict] = []

        def fake_send(sub, payload):
            seen.append(json.loads(payload))
            return True

        with mock.patch.object(push_mod, "_send_one", fake_send):
            await push_mod.push_attention("inst", "x" * 500, "req")
        self.assertEqual(len(seen[0]["body"]), 280)

    async def test_push_attention_no_subscribers_is_noop(self):
        seen: list = []
        with mock.patch.object(push_mod, "_send_one", lambda s, p: seen.append(p)):
            delivered = await push_mod.push_attention("inst", "label", "req")
        self.assertEqual(delivered, 0)
        self.assertEqual(seen, [])

    async def test_fan_out_prunes_gone_subscription(self):
        push_mod.subscribe(**SUB)
        push_mod.subscribe(**SUB2)

        def fake_send(sub, payload):
            # /b reports gone (410), /a delivered.
            return sub["endpoint"].endswith("/a")

        with mock.patch.object(push_mod, "_send_one", fake_send):
            delivered = await push_mod._fan_out({"title": "t", "tag": "tag-x"})
        self.assertEqual(delivered, 1)
        # the dead subscription is pruned from disk; the live one stays
        self.assertEqual(push_mod.subscription_count(), 1)
        subs = push_mod._load_subs()
        self.assertEqual(subs[0]["endpoint"], SUB["endpoint"])

    def test_collab_error_status_mapping(self):
        self.assertEqual(_COLLAB_LINK_STATUS["not_found"], 404)
        self.assertEqual(_COLLAB_LINK_STATUS["stale_generation"], 409)
        self.assertEqual(_COLLAB_LINK_STATUS["access_unavailable"], 403)
        self.assertEqual(_COLLAB_LINK_STATUS["unreachable"], 502)
        self.assertEqual(len(_COLLAB_LINK_STATUS), 4)


class StatusEndpointTests(unittest.IsolatedAsyncioTestCase):
    """GET /api/collab is a plain handler (no request state), so the route is
    exercised by awaiting it directly; httpx is not a dependency here."""

    async def test_collab_status_shape(self):
        from gateway.main import collab_status
        out = await collab_status()
        self.assertIsInstance(out["hosts"], list)
        st = out["stats"]
        for key in ("polls", "pollErrors", "queries", "hostsSeenMax",
                    "asksMinted", "pushesSent", "lastPollMs"):
            self.assertIn(key, st)
        self.assertEqual(set(st["queryFailures"]), {"noReply", "gone", "osError"})
        self.assertIsInstance(st["polls"], int)

    async def test_collab_status_counts_a_real_poll(self):
        """A round that actually queries hosts increments `polls`. Point the
        singleton at a temp directory with one dead entry so the assertion does
        not depend on this machine having a collab registry (CI has none, and
        a round that skips an absent directory intentionally does not count)."""
        import json
        import tempfile
        from gateway.main import collab_status
        from gateway import collab as collab_mod

        d = collab_mod.get_discovery()
        original = d.dir
        with tempfile.TemporaryDirectory() as tmp:
            entry = {"version": 1, "instanceId": "ci-probe", "pid": 1,
                     "endpoint": str(f"{tmp}/gone.sock"), "createdAt": 1,
                     "token": "t" * 64}
            (Path(tmp) / "probe.json").write_text(json.dumps(entry))
            d.dir = Path(tmp)
            try:
                before = (await collab_status())["stats"]["polls"]
                await d.poll_once()
                after = (await collab_status())["stats"]["polls"]
            finally:
                d.dir = original
                d._hosts.clear()
                d._paths.clear()
        self.assertGreaterEqual(after, before + 1)


if __name__ == "__main__":
    unittest.main(verbosity=1)
