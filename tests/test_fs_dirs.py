"""Folder picker listing (gateway/fsbrowse.py): dirs only, dotfolders hidden,
realpath-resolved output, error statuses, cap.

Run: .venv/bin/python tests/test_fs_dirs.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gateway import fsbrowse  # noqa: E402
from gateway.fsbrowse import FsBrowseError, list_subdirs  # noqa: E402


class ListSubdirsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(os.path.realpath(self._tmp.name))
        (self.root / "Beta").mkdir()
        (self.root / "alpha").mkdir()
        (self.root / ".hidden").mkdir()
        (self.root / "file.txt").write_text("x")
        (self.root / "link-to-beta").symlink_to(self.root / "Beta")
        (self.root / "dangling").symlink_to(self.root / "nowhere")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_lists_dirs_only_sorted_case_insensitive(self) -> None:
        res = list_subdirs(str(self.root))
        self.assertEqual([d["name"] for d in res["dirs"]], ["alpha", "Beta", "link-to-beta"])

    def test_hides_dotfolders_files_and_dangling_links(self) -> None:
        names = [d["name"] for d in list_subdirs(str(self.root))["dirs"]]
        self.assertNotIn(".hidden", names)
        self.assertNotIn("file.txt", names)
        self.assertNotIn("dangling", names)

    def test_returns_resolved_path_parent_and_home(self) -> None:
        res = list_subdirs(str(self.root))
        self.assertEqual(res["path"], str(self.root))
        self.assertEqual(res["parent"], str(self.root.parent))
        self.assertEqual(res["home"], os.path.realpath(os.path.expanduser("~")))
        child = next(d for d in res["dirs"] if d["name"] == "alpha")
        self.assertEqual(child["path"], str(self.root / "alpha"))

    def test_tilde_expands(self) -> None:
        (self.root / "sub").mkdir()
        with patch.dict(os.environ, {"HOME": str(self.root)}):
            res = list_subdirs("~/sub")
            self.assertEqual(res["path"], str(self.root / "sub"))
            self.assertEqual(res["home"], str(self.root))

    def test_symlink_dir_resolves_to_target(self) -> None:
        res = list_subdirs(str(self.root / "link-to-beta"))
        self.assertEqual(res["path"], str(self.root / "Beta"))

    def test_empty_path_defaults_to_projects_or_home(self) -> None:
        home = os.path.realpath(os.path.expanduser("~"))
        res = list_subdirs("")
        expected = os.path.join(home, "projects")
        if not os.path.isdir(expected):
            expected = home
        self.assertEqual(res["path"], os.path.realpath(expected))

    def test_missing_folder_is_404(self) -> None:
        with self.assertRaises(FsBrowseError) as cm:
            list_subdirs(str(self.root / "nope"))
        self.assertEqual(cm.exception.status, 404)

    def test_file_is_422(self) -> None:
        with self.assertRaises(FsBrowseError) as cm:
            list_subdirs(str(self.root / "file.txt"))
        self.assertEqual(cm.exception.status, 422)

    def test_nul_byte_is_422(self) -> None:
        with self.assertRaises(FsBrowseError) as cm:
            list_subdirs("/tmp/a\x00b")
        self.assertEqual(cm.exception.status, 422)

    def test_unreadable_folder_is_403(self) -> None:
        with patch.object(fsbrowse.os, "scandir", side_effect=PermissionError):
            with self.assertRaises(FsBrowseError) as cm:
                list_subdirs(str(self.root))
        self.assertEqual(cm.exception.status, 403)

    def test_root_has_no_parent(self) -> None:
        self.assertIsNone(list_subdirs("/")["parent"])

    def test_cap_marks_truncated(self) -> None:
        with patch.object(fsbrowse, "MAX_DIRS", 2):
            res = list_subdirs(str(self.root))
        self.assertEqual(len(res["dirs"]), 2)
        self.assertTrue(res["truncated"])


if __name__ == "__main__":
    unittest.main()
