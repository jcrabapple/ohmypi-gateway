"""Unit tests for DELETE /api/sessions/saved ordering: the running-session
guard must fire (409) before the on-disk existence requirement, because omp
reports the session file path before creating the file.

Run: .venv/bin/python tests/test_delete_saved.py
"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gateway import main  # noqa: E402


class FakeManager:
    def __init__(self, live_file: str | None):
        self.live_file = live_file

    async def reap_dead(self) -> None:
        pass

    def find_by_file(self, session_file: str):
        return object() if self.live_file and session_file == self.live_file else None


class TestDeleteSavedOrdering(unittest.IsolatedAsyncioTestCase):
    async def test_live_session_without_file_on_disk_is_409_not_422(self):
        from gateway.bridge import canonical_path
        from gateway.search import SESSIONS_DIR

        live = canonical_path(SESSIONS_DIR / "test-live-pinned.jsonl") or ""  # need not exist on disk
        assert live
        with patch.object(main, "get_manager", return_value=FakeManager(live)):
            with self.assertRaises(HTTPException) as ctx:
                await main.delete_saved_session(file=live)
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_missing_file_outside_roots_is_422(self):
        with patch.object(main, "get_manager", return_value=FakeManager(None)):
            with self.assertRaises(HTTPException) as ctx:
                await main.delete_saved_session(file="/etc/passwd")
        self.assertEqual(ctx.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
