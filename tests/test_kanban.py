"""Per-project kanban boards (gateway/kanban.py): CRUD, claim TTL, archive,
discovery, confinement, and HTTP error mapping.

Run: .venv/bin/python tests/test_kanban.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gateway import kanban  # noqa: E402
from gateway.kanban import KanbanError  # noqa: E402


class KanbanStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(os.path.realpath(self._tmp.name))
        self.proj = self.root / "proj"
        self.proj.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_get_missing_board_returns_empty_not_created(self) -> None:
        res = kanban.get_board(str(self.proj))
        self.assertFalse(res["exists"])
        self.assertEqual(res["cwd"], str(self.proj))
        self.assertEqual(res["tickets"], [])
        self.assertEqual([c["id"] for c in res["columns"]], ["todo", "doing", "review", "done"])
        self.assertFalse((self.proj / ".omp" / "kanban" / "board.json").exists())

    def test_init_creates_board_and_is_idempotent(self) -> None:
        first = kanban.init_board(str(self.proj))
        self.assertTrue(first["exists"])
        self.assertTrue((self.proj / ".omp" / "kanban" / "board.json").is_file())
        added = kanban.add_ticket(str(self.proj), {"title": "Keep me"})
        self.assertEqual(added["ticket"]["id"], "K-1")
        second = kanban.init_board(str(self.proj))
        self.assertEqual(len(second["tickets"]), 1)

    def test_add_update_note_move_and_delete(self) -> None:
        r1 = kanban.add_ticket(
            str(self.proj),
            {
                "title": "First task",
                "body": "Details",
                "priority": 10,
                "tags": ["#ui", "core", "ui"],
                "blocked_by": ["k-99"],
            },
        )
        t1 = r1["ticket"]
        self.assertEqual(t1["id"], "K-1")
        self.assertEqual(t1["column"], "todo")
        self.assertEqual(t1["priority"], 10)
        self.assertEqual(t1["tags"], ["ui", "core"])
        self.assertEqual(t1["blocked_by"], ["K-99"])

        r2 = kanban.add_ticket(str(self.proj), {"title": "Second task"})
        self.assertEqual(r2["ticket"]["id"], "K-2")
        self.assertEqual(r2["ticket"]["priority"], 100)

        # Position 0 in todo places K-2 before K-1 (priority < 10)
        moved = kanban.move_ticket(str(self.proj), {"id": "k-2", "column": "todo", "position": 0})
        self.assertEqual(moved["ticket"]["priority"], 9)

        noted = kanban.add_note(str(self.proj), {"id": "K-2", "text": "  started investigating  "})
        self.assertEqual(len(noted["ticket"]["notes"]), 1)
        self.assertEqual(noted["ticket"]["notes"][0]["text"], "started investigating")

        updated = kanban.update_ticket(
            str(self.proj),
            {
                "id": "K-2",
                "title": "Renamed second",
                "priority": 5,
                "tags": ["bug"],
                "blocked_by": ["K-1"],
                "column": "doing",
            },
        )
        self.assertEqual(updated["ticket"]["title"], "Renamed second")
        self.assertEqual(updated["ticket"]["priority"], 5)
        self.assertEqual(updated["ticket"]["tags"], ["bug"])
        self.assertEqual(updated["ticket"]["blocked_by"], ["K-1"])
        self.assertEqual(updated["ticket"]["column"], "doing")

        deleted = kanban.delete_ticket(str(self.proj), {"id": "K-1"})
        self.assertEqual(deleted["deleted"]["id"], "K-1")
        self.assertEqual([t["id"] for t in deleted["board"]["tickets"]], ["K-2"])

    def test_claim_conflict_expiry_release_and_move_clears_claim(self) -> None:
        kanban.add_ticket(str(self.proj), {"title": "Claimable"})
        t0 = 1_700_000_000.0
        claimed = kanban.claim_ticket(str(self.proj), {"id": "K-1", "by": "alice"}, now_sec=t0)
        self.assertEqual(claimed["ticket"]["column"], "doing")
        self.assertEqual(claimed["ticket"]["claimed_by"], "alice")

        with self.assertRaises(KanbanError) as cm:
            kanban.claim_ticket(str(self.proj), {"id": "K-1", "by": "bob"}, now_sec=t0 + 60)
        self.assertEqual(cm.exception.status, 409)

        # Same claimer can refresh, and after 45 min TTL another claimer can take it.
        reclaimed = kanban.claim_ticket(
            str(self.proj), {"id": "K-1", "by": "bob"}, now_sec=t0 + kanban.CLAIM_TTL_SEC + 1
        )
        self.assertEqual(reclaimed["ticket"]["claimed_by"], "bob")

        released = kanban.release_ticket(str(self.proj), {"id": "K-1", "note": "handing off"})
        self.assertNotIn("claimed_by", released["ticket"])
        self.assertNotIn("claimed_at", released["ticket"])
        self.assertEqual(released["ticket"]["notes"][-1]["text"], "handing off")

        # Moving to review clears active claim automatically.
        kanban.claim_ticket(str(self.proj), {"id": "K-1", "by": "carol"}, now_sec=t0)
        reviewed = kanban.move_ticket(str(self.proj), {"id": "K-1", "column": "review"})
        self.assertNotIn("claimed_by", reviewed["ticket"])
        self.assertNotIn("claimed_at", reviewed["ticket"])

    def test_archive_moves_only_old_done_tickets(self) -> None:
        kanban.add_ticket(str(self.proj), {"title": "Old done", "column": "done"})
        kanban.add_ticket(str(self.proj), {"title": "Recent done", "column": "done"})
        kanban.add_ticket(str(self.proj), {"title": "Old todo", "column": "todo"})

        bpath = kanban.board_path(self.proj)
        raw = json.loads(bpath.read_text(encoding="utf-8"))
        raw["tickets"][0]["updated"] = "2020-01-01T00:00:00.000Z"
        raw["tickets"][1]["updated"] = "2026-11-16T00:00:00.000Z"
        raw["tickets"][2]["updated"] = "2020-01-01T00:00:00.000Z"
        bpath.write_text(json.dumps(raw), encoding="utf-8")

        now_sec = kanban._parse_iso("2026-11-16T12:00:00.000Z")
        assert now_sec is not None
        res = kanban.archive_tickets(str(self.proj), {"older_than_days": 7}, now_sec=now_sec)
        self.assertEqual(res["moved"], 1)
        self.assertEqual(res["archivedIds"], ["K-1"])
        self.assertEqual([t["id"] for t in res["board"]["tickets"]], ["K-2", "K-3"])

        arch = kanban.get_archive(str(self.proj))
        self.assertEqual([t["id"] for t in arch["tickets"]], ["K-1"])

        # Second pass with nothing eligible is a no-op.
        noop = kanban.archive_tickets(str(self.proj), {"older_than_days": 7}, now_sec=now_sec)
        self.assertEqual(noop["moved"], 0)

    def test_validation_and_error_statuses(self) -> None:
        with self.assertRaises(KanbanError) as cm:
            kanban.get_board(str(self.root / "missing"))
        self.assertEqual(cm.exception.status, 404)

        with self.assertRaises(KanbanError) as cm:
            kanban.add_ticket(str(self.proj), {"title": "   "})
        self.assertEqual(cm.exception.status, 422)

        with self.assertRaises(KanbanError) as cm:
            kanban.add_ticket(str(self.proj), {"title": "x", "column": "bogus"})
        self.assertEqual(cm.exception.status, 422)

        with self.assertRaises(KanbanError) as cm:
            kanban.add_ticket(str(self.proj), {"title": "x", "priority": True})
        self.assertEqual(cm.exception.status, 422)

        kanban.add_ticket(str(self.proj), {"title": "One"})
        with self.assertRaises(KanbanError) as cm:
            kanban.update_ticket(str(self.proj), {"id": "K-1", "blocked_by": ["k-1"]})
        self.assertEqual(cm.exception.status, 422)

        with self.assertRaises(KanbanError) as cm:
            kanban.move_ticket(str(self.proj), {"id": "K-99", "column": "done"})
        self.assertEqual(cm.exception.status, 404)

    def test_symlink_escape_refused(self) -> None:
        outside = self.root / "outside"
        outside.mkdir()
        (self.proj / ".omp").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(KanbanError) as cm:
            kanban.get_board(str(self.proj))
        self.assertEqual(cm.exception.status, 403)

    def test_discover_boards_finds_projects_and_extra_cwds(self) -> None:
        projects = self.root / "projects"
        projects.mkdir()
        p1 = projects / "alpha"
        p2 = projects / "beta"
        other = self.root / "elsewhere"
        for p in (p1, p2, other):
            p.mkdir()
        kanban.add_ticket(str(p1), {"title": "Alpha todo"})
        kanban.add_ticket(str(other), {"title": "Other doing", "column": "doing"})
        # p2 has no board.json and must not appear.
        found = kanban.discover_boards(projects_root=projects, extra_cwds=[str(other)])
        cwds = {b["cwd"]: b for b in found["boards"]}
        self.assertEqual(set(cwds), {str(p1), str(other)})
        self.assertEqual(cwds[str(p1)]["counts"], {"todo": 1, "doing": 0, "review": 0, "done": 0})
        self.assertEqual(cwds[str(other)]["counts"]["doing"], 1)


if __name__ == "__main__":
    unittest.main()
