"""Unit tests: sessions in throwaway dirs get the no-memory overlay.

Run: .venv/bin/python tests/test_test_memory_overlay.py
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from gateway import bridge


class IsTestCwdTests(unittest.TestCase):
    def test_throwaway_dirs_match(self):
        self.assertTrue(bridge.is_test_cwd("/tmp/ompgw-e2e-abc123"))
        self.assertTrue(bridge.is_test_cwd("/tmp"))
        self.assertTrue(bridge.is_test_cwd(
            os.path.expanduser("~/.hermes/cache/scratch/omai-test")))

    def test_real_project_dirs_do_not_match(self):
        self.assertFalse(bridge.is_test_cwd(os.path.expanduser("~/projects/ohmypi-gateway")))
        self.assertFalse(bridge.is_test_cwd(os.path.expanduser("~")))
        self.assertFalse(bridge.is_test_cwd(os.path.expanduser("~/.omp/agent")))

    def test_prefix_boundary_is_respected(self):
        # "/tmpfoo" must not match the "/tmp" prefix.
        self.assertFalse(bridge.is_test_cwd("/tmpfoo/project"))

    def test_symlinked_home_resolves(self):
        # Aurora: /home -> /var/home. The check must hold either way.
        self.assertEqual(
            bridge.is_test_cwd(os.path.expanduser("~/.hermes/cache/scratch/x")),
            bridge.is_test_cwd(os.path.realpath(os.path.expanduser("~/.hermes/cache/scratch/x"))),
        )


class BuildArgsTests(unittest.TestCase):
    def _session(self, cwd: str):
        s = bridge.OmpSession.__new__(bridge.OmpSession)  # skip __init__: no process
        s.cwd = cwd
        s.approval_mode = "write"
        s.resume_session_file = None
        s.requested_model = None
        s.requested_thinking = None
        s.advisor = False
        return s

    def test_test_cwd_gets_overlay_when_file_exists(self):
        with tempfile.TemporaryDirectory() as d:
            overlay = Path(d) / "test-overlay.yml"
            overlay.write_text("memory:\n  backend: off\n")
            old = bridge.TEST_OVERLAY
            bridge.TEST_OVERLAY = str(overlay)
            try:
                args = self._session("/tmp/ompgw-e2e-xyz")._build_args()
            finally:
                bridge.TEST_OVERLAY = old
            self.assertIn("--config", args)
            self.assertEqual(args[args.index("--config") + 1], str(overlay))

    def test_real_cwd_gets_no_overlay(self):
        with tempfile.TemporaryDirectory() as d:
            overlay = Path(d) / "test-overlay.yml"
            overlay.write_text("memory:\n  backend: off\n")
            old = bridge.TEST_OVERLAY
            bridge.TEST_OVERLAY = str(overlay)
            try:
                args = self._session(os.path.expanduser("~/projects/ohmypi-gateway"))._build_args()
            finally:
                bridge.TEST_OVERLAY = old
            self.assertNotIn("--config", args)

    def test_missing_overlay_file_is_not_passed(self):
        old = bridge.TEST_OVERLAY
        bridge.TEST_OVERLAY = "/nonexistent/test-overlay.yml"
        try:
            args = self._session("/tmp/ompgw-e2e-xyz")._build_args()
        finally:
            bridge.TEST_OVERLAY = old
        self.assertNotIn("--config", args)


if __name__ == "__main__":
    unittest.main()
