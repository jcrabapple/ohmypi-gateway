"""Unit tests for cross-session search: incremental indexing (new, changed,
deleted files), query sanitization, role filtering, snippets + session meta,
and the refresh throttle.

Run: .venv/bin/python tests/test_search.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gateway.search as search_mod  # noqa: E402


def session_file(path: Path, sid: str, cwd: str, msgs: list[tuple[str, str]]) -> None:
    lines = [json.dumps({"type": "session", "id": sid, "cwd": cwd})]
    for role, text in msgs:
        lines.append(json.dumps({
            "type": "message",
            "timestamp": "2026-10-01T10:00:00Z",
            "message": {"role": role, "content": [{"type": "text", "text": text}]},
        }))
    path.write_text("\n".join(lines) + "\n")


class SearchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ompgw-search-")
        self.root = Path(self.tmp.name) / "sessions"
        self.root.mkdir()
        self.orig = (search_mod.SESSIONS_DIR, search_mod.SEARCH_DB, search_mod._last_refresh)
        search_mod.SESSIONS_DIR = self.root
        search_mod.SEARCH_DB = Path(self.tmp.name) / "index.db"
        search_mod._last_refresh = 0.0

    def tearDown(self):
        search_mod.SESSIONS_DIR, search_mod.SEARCH_DB, search_mod._last_refresh = self.orig
        self.tmp.cleanup()

    # ------------------------------------------------------------- refresh

    def test_refresh_adds_updates_and_prunes(self):
        f = self.root / "a.jsonl"
        session_file(f, "sid-1", "/w/proj", [("user", "fix the solver loop")])
        out = search_mod.refresh()
        self.assertEqual(out, {"added": 1, "updated": 0, "removed": 0})
        # unchanged file: no-op
        self.assertEqual(search_mod.refresh(), {"added": 0, "updated": 0, "removed": 0})
        # changed content (new mtime): reindexed, not duplicated
        time.sleep(0.01)
        session_file(f, "sid-1", "/w/proj", [("user", "fix the solver loop"), ("assistant", "loop fixed")])
        out = search_mod.refresh()
        self.assertEqual(out["updated"], 1)
        self.assertEqual(search_mod.query("loop")["total"], 2)
        # deleted file: pruned from the index
        f.unlink()
        self.assertEqual(search_mod.refresh()["removed"], 1)
        self.assertEqual(search_mod.query("loop")["total"], 0)

    def test_skips_non_message_and_bad_lines(self):
        (self.root / "b.jsonl").write_text("\n".join([
            "not json at all",
            json.dumps({"type": "session", "id": "sid-2", "cwd": "/w/x"}),
            json.dumps({"type": "message", "message": {"role": "assistant",
                       "content": [{"type": "thinking", "thinking": "scratch pad words"}]}}),
            json.dumps({"type": "message", "message": {"role": "tool",
                       "content": [{"type": "text", "text": "tool output text"}]}}),
            json.dumps({"type": "message", "message": {"role": "assistant",
                       "content": [{"type": "text", "text": "visible answer"}]}}),
        ]) + "\n")
        search_mod.refresh()
        r = search_mod.query("visible answer")
        self.assertEqual(r["total"], 1)
        self.assertEqual(r["results"][0]["sessionId"], "sid-2")
        # thinking and tool content are not indexed
        self.assertEqual(search_mod.query("scratch pad")["total"], 0)
        self.assertEqual(search_mod.query("tool output")["total"], 0)

    def test_title_from_first_user_message(self):
        session_file(self.root / "c.jsonl", "sid-3", "/w/y",
                     [("user", "  probe   the   reactor  "), ("assistant", "ok")])
        search_mod.refresh()
        row = search_mod.query("reactor")["results"][0]
        self.assertEqual(row["title"], "probe the reactor")

    # ------------------------------------------------------------- queries

    def test_fts_query_is_safe_and_prefixed(self):
        self.assertEqual(search_mod.fts_query('solver "loop" (x)!'),
                         '"solver"* "loop"* "x"*')
        self.assertIsNone(search_mod.fts_query("!!! ***"))
        self.assertIsNone(search_mod.fts_query(""))

    def test_query_role_filter_and_rank(self):
        session_file(self.root / "d.jsonl", "sid-4", "/w/z",
                     [("user", "deploy the widget"), ("assistant", "widget deployed")])
        search_mod.refresh()
        self.assertEqual(search_mod.query("widget", role="user")["total"], 1)
        self.assertEqual(search_mod.query("widget", role="assistant")["total"], 1)
        both = search_mod.query("widget")
        self.assertEqual(both["total"], 2)
        # FTS rank decides order (the shorter assistant doc ranks higher);
        # both roles are present and matches carry the sentinel delimiters.
        self.assertEqual({r["role"] for r in both["results"]}, {"user", "assistant"})
        sentinel = f"{search_mod._MARK_OPEN}widget{search_mod._MARK_CLOSE}"
        self.assertTrue(all(sentinel in r["snippet"] for r in both["results"]))

    def test_limit_is_capped(self):
        session_file(self.root / "e.jsonl", "sid-5", "/w", [("user", "needle here")])
        for i in range(5):
            session_file(self.root / f"n{i}.jsonl", f"sid-n{i}", "/w", [("user", "needle here")])
        search_mod.refresh()
        self.assertEqual(search_mod.query("needle", limit=3)["total"], 6)
        self.assertEqual(len(search_mod.query("needle", limit=3)["results"]), 3)
        self.assertEqual(len(search_mod.query("needle", limit=999)["results"]), 6)

    # ------------------------------------------------------------ throttle

    def test_ensure_fresh_throttles_but_force_wins(self):
        session_file(self.root / "f.jsonl", "sid-6", "/w", [("user", "hello world")])
        self.assertTrue(search_mod.ensure_fresh())
        session_file(self.root / "g.jsonl", "sid-7", "/w", [("user", "second file")])
        self.assertFalse(search_mod.ensure_fresh())  # inside the window
        self.assertEqual(search_mod.query("second file")["total"], 0)
        self.assertTrue(search_mod.ensure_fresh(force=True))
        self.assertEqual(search_mod.query("second file")["total"], 1)

    def test_newer_schema_is_rejected(self):
        import sqlite3
        search_mod.refresh()  # create the db at the current version
        con = sqlite3.connect(search_mod.SEARCH_DB)
        con.execute("PRAGMA user_version=99")
        con.commit()
        con.close()
        with self.assertRaisesRegex(RuntimeError, "newer than this gateway"):
            search_mod.refresh()

    # ------------------------------------------------ gate round 1 findings

    def test_unreadable_file_is_skipped_not_fatal(self):
        """An unreadable transcript used to crash refresh() with a SQLite
        binding error and 500 every later search."""
        good = self.root / "ok.jsonl"
        session_file(good, "sid-ok", "/w", [("user", "readable words")])
        bad = self.root / "bad.jsonl"
        bad.write_text("whatever")
        bad.chmod(0o000)
        try:
            out = search_mod.refresh()
        finally:
            bad.chmod(0o644)
        self.assertEqual(out["added"], 1)  # the readable one
        r = search_mod.query("readable")
        self.assertEqual(r["total"], 1)

    def test_null_text_block_does_not_crash(self):
        (self.root / "n.jsonl").write_text("\n".join([
            json.dumps({"type": "session", "id": "sid-n", "cwd": "/w"}),
            json.dumps({"type": "message", "message": {"role": "assistant",
                       "content": [{"type": "text", "text": None}, {"type": "text", "text": "real text"}]}}),
        ]) + "\n")
        search_mod.refresh()
        self.assertEqual(search_mod.query("real text")["total"], 1)

    def test_literal_mark_in_transcript_stays_text(self):
        """The gateway delimits matches with private-use-area sentinels. A
        transcript containing literal <mark> has its 'mark' token matched (it
        IS a match), but the angle brackets travel as plain characters, so the
        client's escape-then-sentinel-map renders them as text, not markup."""
        session_file(self.root / "m.jsonl", "sid-m", "/w",
                     [("assistant", "we wrap hits in <mark> tags")])
        search_mod.refresh()
        r = search_mod.query("mark")
        self.assertEqual(r["total"], 1)
        snippet = r["results"][0]["snippet"]
        # exact shape: literal < and > stay literal; only the token is wrapped
        self.assertEqual(snippet, "we wrap hits in <\ue000mark\ue001> tags")
        self.assertNotIn("<mark>", snippet)
        self.assertNotIn("</mark>", snippet)

    def test_unicode_query_matches(self):
        session_file(self.root / "u.jsonl", "sid-u", "/w", [("user", "café résumé notes")])
        search_mod.refresh()
        self.assertEqual(search_mod.query("café")["total"], 1)



if __name__ == "__main__":
    unittest.main(verbosity=1)
