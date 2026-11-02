"""Memory graph API (gateway/memory.py): note parsing, FTS reads, note writes,
archiving, and the read-only mnemopi scan.

Run: .venv/bin/python tests/test_memory.py
"""

from __future__ import annotations

import os
import sqlite3
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gateway import memory  # noqa: E402
from gateway.memory import MemoryError_  # noqa: E402


def build_store(root: Path) -> None:
    """The shape `oscar-memory index` produces, built by hand so the test does
    not need the CLI (CI runs on a fresh runner without it)."""
    (root / "notes").mkdir(parents=True, exist_ok=True)
    (root / "archive").mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(root / "graph.db")
    conn.execute("CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, "
                 "title TEXT NOT NULL, path TEXT, updated INTEGER)")
    conn.execute("CREATE TABLE edges(src TEXT NOT NULL, dst TEXT NOT NULL, "
                 "kind TEXT NOT NULL, PRIMARY KEY (src, dst, kind))")
    conn.execute("CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, title, body)")
    conn.execute("CREATE TABLE tiers(id TEXT PRIMARY KEY, tier TEXT NOT NULL)")
    conn.execute("CREATE TABLE access(nid TEXT NOT NULL, ts INTEGER NOT NULL)")
    notes = [
        ("note-a", "Backup pipeline restic", "restic s3 offsite nightly", "hot"),
        ("note-b", "Solar inverter polling", "modbus poll every 30s", "warm"),
    ]
    for nid, title, body, tier in notes:
        stem = nid
        path = root / "notes" / f"{stem}.md"
        path.write_text(f"---\nid: {nid}\ntitle: {title}\ntags: infra\nlinks: skill:aurora\n---\n\n{body}\n")
        conn.execute("INSERT INTO nodes VALUES (?,?,?,?,?)", (nid, "note", title, str(path), 1))
        conn.execute("INSERT INTO nodes_fts VALUES (?,?,?)", (nid, title, body))
        conn.execute("INSERT INTO tiers VALUES (?,?)", (nid, tier))
        conn.execute("INSERT INTO edges VALUES (?,?,?)", (nid, "tag:infra", "tagged"))
        conn.execute("INSERT INTO edges VALUES (?,?,?)", (nid, "skill:aurora", "references"))
    conn.execute("INSERT INTO nodes VALUES (?,?,?,?,?)", ("tag:infra", "tag", "infra", None, 1))
    conn.execute("INSERT INTO nodes_fts VALUES (?,?,?)", ("skill:aurora", "aurora", "deploy aurora restic backup"))
    conn.execute("INSERT INTO nodes VALUES (?,?,?,?,?)", ("skill:aurora", "skill", "aurora", None, 1))
    conn.commit()
    conn.close()


class MemoryStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / ".omp" / "agent" / "memory"
        self.root.mkdir(parents=True)
        build_store(self.root)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_stats_counts_and_hot(self):
        s = memory.stats(self.root)
        self.assertEqual(s["counts"]["note"], 2)
        self.assertEqual(s["counts"]["skill"], 1)
        self.assertEqual(s["counts"]["tag"], 1)
        self.assertEqual(s["counts"]["edges"], 4)
        self.assertEqual([h["id"] for h in s["hot"]], ["note-a"])

    def test_stats_without_index_is_zeroed(self):
        empty = Path(self._tmp.name) / "nope"
        empty.mkdir()
        s = memory.stats(empty)
        self.assertEqual(s["counts"]["note"], 0)
        self.assertEqual(s["hot"], [])

    def test_search_ranks_hot_first_and_snippets(self):
        res = memory.search("restic", 10, self.root)
        self.assertEqual([r["id"] for r in res["notes"]], ["note-a"])
        self.assertEqual(res["notes"][0]["tier"], "hot")
        self.assertIn("restic", res["notes"][0]["snippet"])

    def test_search_returns_notes_only(self):
        # "restic" also matches the skill body; a /notes result the client cannot
        # open is a bug, so only note rows come back.
        res = memory.search("restic", 10, self.root)
        self.assertEqual([r["id"] for r in res["notes"]], ["note-a"])
        # "aurora" matches only the skill row, so the list is empty rather than
        # offering a row that would 422 when opened.
        res = memory.search("aurora", 10, self.root)
        self.assertEqual(res["notes"], [])

    def test_search_empty_query_lists_notes(self):
        res = memory.search("", 10, self.root)
        self.assertEqual(sorted(r["id"] for r in res["notes"]), ["note-a", "note-b"])

    def test_search_survives_fts_syntax(self):
        # A bare quote is an FTS5 syntax error; the LIKE fallback must answer.
        res = memory.search('restic"', 10, self.root)
        self.assertIn("notes", res)
        self.assertEqual([r["id"] for r in res["notes"]], ["note-a"])

    def test_get_note_edges_and_frontmatter(self):
        note = memory.get_note("note-a", self.root)
        self.assertEqual(note["title"], "Backup pipeline restic")
        self.assertEqual(note["tags"], ["infra"])
        self.assertEqual(note["links"], ["skill:aurora"])
        self.assertIn("restic", note["body"])
        self.assertEqual(note["tier"], "hot")
        self.assertFalse(note["archived"])
        self.assertIn({"id": "skill:aurora", "kind": "references"}, note["outgoing"])
        self.assertEqual(note["incoming"], [])

    def test_get_note_backlinks(self):
        conn = sqlite3.connect(self.root / "graph.db")
        conn.execute("INSERT INTO edges VALUES (?,?,?)", ("note-b", "note-a", "references"))
        conn.commit()
        conn.close()
        note = memory.get_note("note-a", self.root)
        self.assertIn({"id": "note-b", "kind": "references"}, note["incoming"])

    def test_prefixed_id_is_accepted_and_normalized(self):
        note = memory.get_note("note:note-a", self.root)
        self.assertEqual(note["id"], "note-a")

    def test_get_note_rejects_bad_and_missing(self):
        with self.assertRaises(MemoryError_) as bad:
            memory.get_note("../../etc/passwd", self.root)
        self.assertEqual(bad.exception.status, 422)
        with self.assertRaises(MemoryError_) as missing:
            memory.get_note("note-nope", self.root)
        self.assertEqual(missing.exception.status, 404)

    def test_symbolic_link_note_outside_store_is_not_read(self):
        secret = Path(self._tmp.name) / "secret.md"
        secret.write_text("---\nid: note:evil\ntitle: evil\n---\nbody")
        (self.root / "notes" / "evil.md").symlink_to(secret)
        with self.assertRaises(MemoryError_):
            memory.get_note("evil", self.root)

    def test_save_note_creates_file_with_frontmatter(self):
        with patch.object(memory, "reindex", return_value={"indexed": True}):
            with patch.object(memory, "get_note", return_value={"id": "x"}):
                out = memory.save_note(title="Mead gravity log", tags=["mead"],
                                       links=["skill:home-mead-making"],
                                       body="1.060 to 1.012", root=self.root)
        self.assertTrue(out["created"])
        path = Path(out["path"])
        text = path.read_text()
        self.assertIn("title: Mead gravity log", text)
        self.assertIn("tags: mead", text)
        self.assertIn("links: skill:home-mead-making", text)
        self.assertIn("1.060 to 1.012", text)

    def test_save_note_requires_title_and_updates_existing(self):
        with self.assertRaises(MemoryError_):
            memory.save_note(title="   ", body="x", root=self.root)
        with patch.object(memory, "reindex", return_value={"indexed": False,
                                                          "reason": "no cli"}):
            out = memory.save_note(nid="note-a", title="Backup pipeline restic v2",
                                   tags=["infra", "restic"], links=[], body="updated body",
                                   root=self.root)
        self.assertFalse(out["created"])
        self.assertFalse(out["index"]["indexed"])
        text = (self.root / "notes" / "note-a.md").read_text()
        self.assertIn("updated body", text)
        self.assertNotIn("nightly", text)

    def test_save_note_rejects_frontmatter_injection(self):
        cases = (
            {"title": "ok\nid: spoofed", "body": "x"},
            {"title": "ok", "body": "x", "tags": ["a\ntier: hot"]},
            {"title": "ok", "body": "x", "tags": ["a,b"]},
            {"title": "ok", "body": "x", "links": ["skill:x\n---"]},
        )
        for case in cases:
            with self.subTest(case=case), self.assertRaises(MemoryError_) as e:
                memory.save_note(body="x", root=self.root, **{k: v for k, v in case.items() if k != "body"})
            self.assertEqual(e.exception.status, 422)
        # Nothing was written.
        self.assertFalse((self.root / "notes" / "note-spoofed.md").exists())

    def test_get_note_survives_a_broken_index(self):
        (self.root / "graph.db").write_bytes(b"not a database")
        note = memory.get_note("note-a", self.root)
        self.assertEqual(note["title"], "Backup pipeline restic")
        self.assertEqual(note["outgoing"], [])
        self.assertEqual(note["tier"], "warm")

    def test_save_note_unknown_id_is_404(self):
        with self.assertRaises(MemoryError_) as e:
            memory.save_note(nid="note-ghost", title="t", body="b", root=self.root)
        self.assertEqual(e.exception.status, 404)

    def test_archive_moves_the_file(self):
        with patch.object(memory, "reindex", return_value={"indexed": True}):
            out = memory.archive_note("note-b", self.root)
        self.assertTrue(out["ok"])
        self.assertFalse((self.root / "notes" / "note-b.md").exists())
        self.assertTrue((self.root / "archive" / "note-b.md").exists())
        with patch.object(memory, "reindex", return_value={"indexed": True}):
            again = memory.archive_note("note-b", self.root)
        self.assertTrue(again.get("already"))

    def test_mint_id_is_unique_and_slugged(self):
        first = memory._mint_id(self.root, "Some Long Title: Part 2!")
        self.assertTrue(first.startswith("note-20"))
        self.assertIn("some-long-title-part-2", first)
        (self.root / "notes" / f"{first}.md").write_text("---\ntitle: t\n---\n")
        second = memory._mint_id(self.root, "Some Long Title: Part 2!")
        self.assertNotEqual(first, second)

    def test_title_with_dashes_survives_a_read(self):
        # A plain split("---") ends the block at the title's own dashes.
        path = self.root / "notes" / "note-dashes.md"
        path.write_text("---\nid: note-dashes\ntitle: Phase 1 --- Initial Design\n---\n\nbody here\n")
        meta, body = memory._parse_frontmatter(path.read_text())
        self.assertEqual(meta["title"], "Phase 1 --- Initial Design")
        self.assertEqual(body, "body here")

    def test_frontmatter_round_trip(self):
        text = memory._compose("Title", ["a", "b"], ["skill:x"], "body\n", "note-n1")
        meta, body = memory._parse_frontmatter(text)
        self.assertEqual(meta["title"], "Title")
        self.assertEqual(meta["tags"], "a, b")
        self.assertEqual(meta["links"], "skill:x")
        self.assertEqual(body, "body")


class EpisodicTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name) / "mnemopi"
        (base / "banks" / "proj-abc").mkdir(parents=True)
        for path, rows in ((base / "mnemopi.db", [("e1", "global thing", "global")]),
                           (base / "banks" / "proj-abc" / "mnemopi.db",
                            [("e2", "project fact about mead", "bank"),
                             ("e3", "unrelated", "bank")])):
            conn = sqlite3.connect(path)
            conn.execute("CREATE TABLE working_memory(id TEXT PRIMARY KEY, content TEXT, "
                         "source TEXT, timestamp TEXT, importance REAL, scope TEXT)")
            for rid, content, scope in rows:
                conn.execute("INSERT INTO working_memory VALUES (?,?,?,?,?,?)",
                             (rid, content, "test", f"2026-10-0{len(content) % 9 + 1}", 0.5, scope))
            conn.commit()
            conn.close()
        self.base = base
        os.environ["OMPGW_MNEMOPI_DIR"] = str(base)
        self.addCleanup(os.environ.pop, "OMPGW_MNEMOPI_DIR", None)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_lists_across_banks_with_bank_names(self):
        res = memory.episodic("", 10)
        self.assertEqual(res["banks"], 2)
        self.assertEqual(sorted(r["id"] for r in res["rows"]), ["e1", "e2", "e3"])
        self.assertIn("proj-abc", {r["bank"] for r in res["rows"]})
        self.assertIn("shared", {r["bank"] for r in res["rows"]})

    def test_filters_by_substring(self):
        res = memory.episodic("mead", 10)
        self.assertEqual([r["id"] for r in res["rows"]], ["e2"])

    def test_limit_is_clamped(self):
        res = memory.episodic("", 999)
        self.assertTrue(len(res["rows"]) <= memory.MAX_EPISODIC)

    def test_mixed_timestamp_types_do_not_crash_the_sort(self):
        conn = sqlite3.connect(self.base / "banks" / "proj-abc" / "mnemopi.db")
        conn.execute("INSERT INTO working_memory VALUES (?,?,?,?,?,?)",
                     ("e4", "epoch timestamp row", "test", 1793586000, 0.5, "bank"))
        conn.commit()
        conn.close()
        res = memory.episodic("", 10)
        self.assertIn("e4", [r["id"] for r in res["rows"]])
        # The response is always text: clients format it with string methods.
        for row in res["rows"]:
            self.assertTrue(row["timestamp"] is None or isinstance(row["timestamp"], str), row)

    def test_missing_store_is_empty_not_an_error(self):
        os.environ["OMPGW_MNEMOPI_DIR"] = str(Path(self._tmp.name) / "absent")
        res = memory.episodic("x", 5)
        self.assertEqual(res["rows"], [])
        self.assertEqual(res["banks"], 0)


class ReindexTest(unittest.TestCase):
    def test_missing_cli_degrades(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / ".omp" / "agent" / "memory"
            root.mkdir(parents=True)
            with patch.dict(os.environ, {"OMPGW_OSCAR_MEMORY": str(Path(tmp) / "nope")}):
                with patch.object(memory.shutil, "which", return_value=None):
                    with patch.object(memory.Path, "home", return_value=Path(tmp)):
                        out = memory.reindex(root)
            self.assertFalse(out["indexed"])

    def test_stub_cli_runs_with_derived_home(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            root = home / ".omp" / "agent" / "memory"
            (root / "notes").mkdir(parents=True)
            stub = Path(tmp) / "oscar-memory"
            stub.write_text("#!/bin/sh\necho \"$HOME\" > " + str(Path(tmp) / "seen-home") + "\n"
                            "echo 'indexed: 1 nodes, 0 edges'\n")
            stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
            with patch.dict(os.environ, {"OMPGW_OSCAR_MEMORY": str(stub)}):
                out = memory.reindex(root)
            self.assertTrue(out["indexed"])
            self.assertEqual((Path(tmp) / "seen-home").read_text().strip(), str(home))


if __name__ == "__main__":
    unittest.main(verbosity=2)
