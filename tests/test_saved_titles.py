"""Saved-session titles: omp's stored title (line-1 header record, rewritten
in place on rename) wins over the first-prompt snippet; an empty header means
"never named" and falls back to the prompt; transcripts without a header use
the last title_change.

Run: .venv/bin/python tests/test_saved_titles.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gateway import bridge  # noqa: E402


def write_session(path: Path, prompt: str, head: tuple[dict, ...] | list[dict] = (), tail: tuple[dict, ...] | list[dict] = ()) -> None:
    lines = [json.dumps(r, separators=(",", ":")) for r in head]
    lines.append(json.dumps({"type": "session", "id": path.stem, "cwd": "/w/p"}, separators=(",", ":")))
    lines.append(json.dumps({"type": "message", "message": {
        "role": "user", "content": [{"type": "text", "text": prompt}]}}, separators=(",", ":")))
    lines += [json.dumps(r, separators=(",", ":")) for r in tail]
    path.write_text("\n".join(lines) + "\n")


class SavedTitleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ompgw-titles-")
        self.agent = Path(self.tmp.name).resolve()
        (self.agent / "sessions" / "-w-p").mkdir(parents=True)
        self.dir = self.agent / "sessions" / "-w-p"
        self.patch = patch.object(bridge, "OMP_AGENT_DIR", self.agent)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def titles(self) -> dict[str, str]:
        return {Path(e["file"]).stem: e["title"] for e in bridge.scan_saved_sessions()}

    def test_header_title_wins(self):
        write_session(self.dir / "a.jsonl", "first prompt",
                      head=[{"type": "title", "v": 1, "title": "Named  by\nomp", "pad": "   "}],
                      tail=[{"type": "title_change", "title": "Older"}])
        self.assertEqual(self.titles()["a"], "Named by omp")

    def test_empty_header_falls_back_to_prompt(self):
        write_session(self.dir / "b.jsonl", "first prompt here",
                      head=[{"type": "title", "v": 1, "title": ""}],
                      tail=[{"type": "title_change", "title": "Stale"}])
        self.assertEqual(self.titles()["b"], "first prompt here")

    def test_title_change_without_header(self):
        write_session(self.dir / "c.jsonl", "first prompt",
                      tail=[{"type": "title_change", "title": "One"},
                            {"type": "title_change", "title": "Two"}])
        self.assertEqual(self.titles()["c"], "Two")

    def test_untitled_uses_prompt(self):
        write_session(self.dir / "d.jsonl", "just the prompt")
        self.assertEqual(self.titles()["d"], "just the prompt")

    def test_subagent_transcripts_are_not_listed(self):
        write_session(self.dir / "parent.jsonl", "parent prompt")
        (self.dir / "parent").mkdir()
        write_session(self.dir / "parent" / "FairFlea.jsonl", "Complete assignment thoroughly: x")
        self.assertEqual(sorted(self.titles()), ["parent"])


if __name__ == "__main__":
    unittest.main()
