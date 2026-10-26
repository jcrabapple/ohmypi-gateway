"""Unit tests: sessions in throwaway dirs get the no-memory overlay.

Run: .venv/bin/python tests/test_test_memory_overlay.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gateway import bridge  # noqa: E402


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
        # Aurora: /home -> /var/home. Both spellings must match, and the test
        # must assert the expected truth value, not just equality.
        raw = os.path.expanduser("~/.hermes/cache/scratch/x")
        self.assertTrue(bridge.is_test_cwd(raw))
        self.assertTrue(bridge.is_test_cwd(os.path.realpath(raw)))



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

    def test_missing_overlay_file_still_passed_so_omp_fails_closed(self):
        # omp refuses to start on a missing --config ("Config overlay not
        # found"), so a test cwd must always carry the flag.
        old = bridge.TEST_OVERLAY
        bridge.TEST_OVERLAY = "/nonexistent/test-overlay.yml"
        try:
            args = self._session("/tmp/ompgw-e2e-xyz")._build_args()
        finally:
            bridge.TEST_OVERLAY = old
        self.assertIn("--config", args)
        self.assertEqual(args[args.index("--config") + 1], "/nonexistent/test-overlay.yml")

    def test_resume_keeps_overlay_and_resume_flag(self):
        s = self._session("/tmp/ompgw-e2e-xyz")
        s.resume_session_file = "/home/user/.omp/agent/sessions/x/y.jsonl"
        s.requested_model = "openrouter/z-ai/glm-5.3-flashx"
        args = s._build_args()
        self.assertIn("--config", args)
        self.assertIn("-r", args)
        self.assertEqual(args[args.index("-r") + 1], s.resume_session_file)
        self.assertEqual(args[args.index("--model") + 1], s.requested_model)



if __name__ == "__main__":
    unittest.main()
