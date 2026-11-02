"""Session artifacts (gateway/artifacts.py): containment, filenames, upload caps.

Run: .venv/bin/python tests/test_artifacts.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gateway import artifacts  # noqa: E402
from gateway.artifacts import ArtifactError  # noqa: E402


class ResolveFileTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.cwd = Path(os.path.realpath(self._tmp.name))
        (self.cwd / "sub").mkdir()
        (self.cwd / "report.md").write_text("# report\n")
        (self.cwd / "sub" / "deep.txt").write_text("deep\n")
        (self.cwd / ".env").write_text("SECRET=1\n")
        self.outside = Path(tempfile.mkdtemp())
        (self.outside / "secret.txt").write_text("nope\n")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_reads_a_file(self):
        p = artifacts.resolve_file(str(self.cwd), "report.md")
        self.assertEqual(p.name, "report.md")

    def test_nested_file(self):
        p = artifacts.resolve_file(str(self.cwd), "sub/deep.txt")
        self.assertEqual(p.read_text(), "deep\n")

    def test_dotfiles_and_secrets_are_refused(self):
        # Listing hides dotfiles; asking for one by name is 403 as well, so this
        # route cannot pull .env or a dot-directory out of a repo or a home dir.
        for probe in (".env", ".git/config", ".ssh/id_rsa"):
            with self.subTest(probe=probe), self.assertRaises(ArtifactError) as e:
                artifacts.resolve_file(str(self.cwd), probe)
            self.assertEqual(e.exception.status, 403)

    def test_gateway_credentials_are_refused(self):
        (self.cwd / "auth-token").write_text("secret")
        with self.assertRaises(ArtifactError) as e:
            artifacts.resolve_file(str(self.cwd), "auth-token")
        self.assertEqual(e.exception.status, 403)

    def test_rejects_absolute_and_parent(self):
        for bad in ("/etc/passwd", "../secret.txt", "sub/../../secret.txt", "a\x00b"):
            with self.subTest(bad=bad), self.assertRaises(ArtifactError) as e:
                artifacts.resolve_file(str(self.cwd), bad)
            self.assertEqual(e.exception.status, 422)

    def test_rejects_symlink_escape(self):
        (self.cwd / "link.txt").symlink_to(self.outside / "secret.txt")
        with self.assertRaises(ArtifactError) as e:
            artifacts.resolve_file(str(self.cwd), "link.txt")
        self.assertEqual(e.exception.status, 403)

    def test_missing_and_directory(self):
        with self.assertRaises(ArtifactError) as e:
            artifacts.resolve_file(str(self.cwd), "ghost.txt")
        self.assertEqual(e.exception.status, 404)
        with self.assertRaises(ArtifactError) as e:
            artifacts.resolve_file(str(self.cwd), "sub")
        self.assertEqual(e.exception.status, 415)
        with self.assertRaises(ArtifactError) as e:
            artifacts.resolve_file(str(self.cwd), "")
        self.assertEqual(e.exception.status, 422)


class SaveUploadTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.cwd = Path(os.path.realpath(self._tmp.name))
        (self.cwd / "notes").mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_writes_into_cwd(self):
        out = artifacts.save_upload(str(self.cwd), "", "new.txt", b"hello")
        self.assertEqual(out, {"name": "new.txt", "path": "new.txt", "size": 5})
        self.assertEqual((self.cwd / "new.txt").read_bytes(), b"hello")

    def test_writes_into_subdir(self):
        out = artifacts.save_upload(str(self.cwd), "notes", "n.md", b"# n")
        self.assertEqual(out["path"], "notes/n.md")

    def test_existing_needs_overwrite(self):
        (self.cwd / "dup.txt").write_text("old")
        with self.assertRaises(ArtifactError) as e:
            artifacts.save_upload(str(self.cwd), "", "dup.txt", b"new")
        self.assertEqual(e.exception.status, 409)
        artifacts.save_upload(str(self.cwd), "", "dup.txt", b"new", overwrite=True)
        self.assertEqual((self.cwd / "dup.txt").read_bytes(), b"new")

    def test_size_cap(self):
        with patch.object(artifacts, "MAX_UPLOAD_BYTES", 4):
            with self.assertRaises(ArtifactError) as e:
                artifacts.save_upload(str(self.cwd), "", "big.bin", b"12345")
        self.assertEqual(e.exception.status, 413)

    def test_hidden_folders_are_not_upload_targets(self):
        for directory in (".git/hooks", ".ssh", ".config/systemd/user"):
            with self.subTest(directory=directory), self.assertRaises(ArtifactError) as e:
                artifacts.save_upload(str(self.cwd), directory, "x.txt", b"x")
            self.assertIn(e.exception.status, (403, 404))

    def test_dangling_symlink_is_refused_even_with_overwrite(self):
        real = self.cwd.parent / "outside-target.txt"
        (self.cwd / "dangling.txt").symlink_to(real)
        with self.assertRaises(ArtifactError) as e:
            artifacts.save_upload(str(self.cwd), "", "dangling.txt", b"x", overwrite=True)
        self.assertEqual(e.exception.status, 403)
        self.assertFalse(real.exists())

    def test_bad_names_and_dirs(self):
        # Path components in an upload name are stripped, never honored (see below).
        cases = [("", "x"), (".hidden", ""), ("a" * 300, "")]
        for name, directory in cases:
            with self.subTest(name=name, directory=directory), self.assertRaises(ArtifactError):
                artifacts.save_upload(str(self.cwd), directory, name, b"x")
        for directory in ("../", "/etc", "missing-dir"):
            with self.subTest(directory=directory), self.assertRaises(ArtifactError):
                artifacts.save_upload(str(self.cwd), directory, "ok.txt", b"x")

    def test_path_components_in_name_are_stripped(self):
        out = artifacts.save_upload(str(self.cwd), "", "weird/../name.txt", b"x")
        self.assertEqual(out["name"], "name.txt")
        self.assertTrue((self.cwd / "name.txt").exists())

    def test_symlink_escape_refused(self):
        outside = Path(tempfile.mkdtemp())
        (self.cwd / "evil.txt").symlink_to(outside / "target.txt")
        with self.assertRaises(ArtifactError) as e:
            artifacts.save_upload(str(self.cwd), "", "evil.txt", b"x", overwrite=True)
        self.assertEqual(e.exception.status, 403)


class MediaTypeTest(unittest.TestCase):
    def test_active_content_is_opaque(self):
        for name in ("page.html", "icon.svg", "app.js", "doc.xml"):
            with self.subTest(name=name):
                self.assertEqual(artifacts.media_type(Path(name)), "application/octet-stream")

    def test_plain_types(self):
        self.assertEqual(artifacts.media_type(Path("a.md")), "text/markdown; charset=utf-8")
        self.assertEqual(artifacts.media_type(Path("a.zip")), "application/zip")
        self.assertEqual(artifacts.media_type(Path("a.unknownext")), "application/octet-stream")


if __name__ == "__main__":
    unittest.main(verbosity=2)
