"""Unit tests for the model-role config editor (gateway/model_roles.py):
per-role edits of modelRoles and retry.fallbackChains that preserve the
comments and formatting of the rest of the file.

Run: .venv/bin/python tests/test_model_roles.py
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import HTTPException  # noqa: E402

from gateway import main, model_roles  # noqa: E402

# Comments everywhere, an inline comment, a wildcard-ish selector, a chain.
SRC = """# agent config
plugins: [a, b]
modelRoles:
  default: openrouter/z-ai/glm-5.3-flash:max  # main chat model
  # cheap helper
  smol: openrouter/deepseek/deepseek-v4.1-flash
  web: web/exa
retry:
  fallbackChains:
    default:
      - openrouter/deepseek/deepseek-v4.1-flash
    slow:
      - openrouter/moonshotai/kimi-k3:high
      - openrouter/z-ai/glm-5.3-flash
# trailing comment
"""


def edit(role_changes=None, chain_changes=None, text=SRC):
    return model_roles.edit(text, role_changes or {}, chain_changes or {})


class ValidateTest(unittest.TestCase):
    def test_nothing_to_change(self):
        with self.assertRaises(model_roles.ModelRolesError) as cm:
            model_roles.validate_changes({})
        self.assertEqual(cm.exception.status, 422)

    def test_unknown_top_level_key(self):
        with self.assertRaises(model_roles.ModelRolesError) as cm:
            model_roles.validate_changes({"modelRoles": {}})
        self.assertEqual(cm.exception.status, 422)

    def test_role_name_shape(self):
        for bad in ("Default", "a b", "", "x" * 41, "9lead", "-lead"):
            with self.assertRaises(model_roles.ModelRolesError) as cm:
                model_roles.validate_changes({"roles": {bad: "a/b"}})
            self.assertEqual(cm.exception.status, 422, bad)
        ok = model_roles.validate_changes({"roles": {"task-agent_2": None}})
        self.assertEqual(ok, ({"task-agent_2": None}, {}))

    def test_selector_charset(self):
        for bad in ("", "not a selector", "a/b:bad level", ":nope",
                    "a/b, ", "a/b,,c/d", 5):
            with self.assertRaises(model_roles.ModelRolesError) as cm:
                model_roles.validate_changes({"roles": {"default": bad}})
            self.assertEqual(cm.exception.status, 422, repr(bad))
        for good in ("openrouter/z-ai/glm-5.3-flash:max", "*", "provider/*",
                     "@smol", "web/exa", "a/b, c/d:high", "a/b,c/d"):
            model_roles.validate_changes({"roles": {"default": good}})
        # null is the documented unset value, not a bad selector.
        self.assertEqual(model_roles.validate_changes({"roles": {"default": None}}),
                         ({"default": None}, {}))
        self.assertEqual(model_roles.validate_changes({"fallbacks": {"slow": None}}),
                         ({}, {"slow": None}))

    def test_value_too_long(self):
        with self.assertRaises(model_roles.ModelRolesError) as cm:
            model_roles.validate_changes({"roles": {"default": "a/" + "b" * 4096}})
        self.assertEqual(cm.exception.status, 422)

    def test_chain_shape(self):
        for bad in ([], ["a/b"] * 17, ["a b"], "a/b", ["a/b", 3], None if False else 3):
            with self.assertRaises(model_roles.ModelRolesError) as cm:
                model_roles.validate_changes({"fallbacks": {"default": bad}})
            self.assertEqual(cm.exception.status, 422, repr(bad))
        roles, chains = model_roles.validate_changes(
            {"fallbacks": {"default": ["a/b", " c/d "], "slow": None}})
        self.assertEqual(chains["default"], ["a/b", "c/d"])
        self.assertEqual(chains["slow"], None)


class EditTest(unittest.TestCase):
    def test_set_role_keeps_comments(self):
        out = edit({"default": "openrouter/moonshotai/kimi-k3:high"})
        self.assertIn("openrouter/moonshotai/kimi-k3:high", out)
        for needle in ("# agent config", "# main chat model", "# cheap helper",
                       "# trailing comment", "web: web/exa", "plugins: [a, b]"):
            self.assertIn(needle, out)
        state = model_roles.parse_state(out)
        self.assertEqual(state["roles"]["default"], "openrouter/moonshotai/kimi-k3:high")
        self.assertEqual(state["roles"]["web"], "web/exa")
        self.assertEqual(state["fallbacks"]["slow"],
                         ["openrouter/moonshotai/kimi-k3:high", "openrouter/z-ai/glm-5.3-flash"])

    def test_unset_role_deletes_key(self):
        out = edit({"smol": None})
        self.assertNotIn("  smol: openrouter/deepseek/deepseek-v4.1-flash\n", out)
        state = model_roles.parse_state(out)
        self.assertNotIn("smol", state["roles"])
        self.assertIn("default", state["roles"])

    def test_unset_every_role_deletes_block(self):
        out = edit({"default": None, "smol": None, "web": None})
        self.assertNotIn("modelRoles", out)
        self.assertIn("fallbackChains", out)  # untouched block survives
        self.assertIn("# trailing comment", out)

    def test_chain_unset_and_prune(self):
        out = edit({"default": "a/b"}, {"default": None, "slow": None})
        state = model_roles.parse_state(out)
        self.assertEqual(state["fallbacks"], {})
        self.assertNotIn("retry:", out)
        self.assertIn("# agent config", out)  # untouched parts keep their comments
        # Known ruamel edge, verified: a comment that trails a block is stored
        # on the block's last node, so clearing the last chain of a block loses
        # it along with the block. Salvaging it would also resurrect comments
        # that describe entries being deleted, so the loss is documented
        # (docs/API.md) rather than heuristic'd away. Per-key edits never
        # touch comments of surviving roles or chains.
        self.assertNotIn("# trailing comment", out)

    def test_missing_blocks_are_created(self):
        out = edit({"default": "a/b"}, {"slow": ["c/d"]}, text="# only\nother: 1\n")
        self.assertEqual(
            model_roles.parse_state(out),
            {"roles": {"default": "a/b"}, "fallbacks": {"slow": ["c/d"]}},
        )
        self.assertIn("# only", out)

    def test_empty_file_creates_blocks(self):
        out = edit({"default": "a/b"}, text="")
        self.assertEqual(model_roles.parse_state(out),
                         {"roles": {"default": "a/b"}, "fallbacks": {}})

    def test_role_changes_alone_do_not_create_retry(self):
        out = edit({"default": "a/b"}, text="# only\n")
        self.assertEqual(model_roles.parse_state(out),
                         {"roles": {"default": "a/b"}, "fallbacks": {}})
        self.assertNotIn("retry:", out)

    def test_read_roles_missing_file(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(model_roles.ModelRolesError) as cm:
                model_roles.read_roles(Path(d) / "config.yml")
            self.assertEqual(cm.exception.status, 404)

    def test_read_roles_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "config.yml"
            f.write_text(SRC)
            state = model_roles.read_roles(f)
            self.assertEqual(state["roles"]["web"], "web/exa")
            self.assertEqual(len(state["fallbacks"]["slow"]), 2)


class BrokenFileTest(unittest.TestCase):
    def test_unparseable(self):
        for bad in ("- just\n- a list\n", "modelRoles: [a]\n", "modelRoles:\n  default: [x]\n"):
            with self.assertRaises(model_roles.ModelRolesError) as cm:
                model_roles.parse_state(bad)
            self.assertEqual(cm.exception.status, 409, bad)

    def test_non_string_role_value(self):
        with self.assertRaises(model_roles.ModelRolesError) as cm:
            model_roles.parse_state("modelRoles:\n  default: 5\n")
        self.assertEqual(cm.exception.status, 409)

    def test_retry_not_mapping(self):
        with self.assertRaises(model_roles.ModelRolesError) as cm:
            model_roles.parse_state("retry: just a string\n")
        self.assertEqual(cm.exception.status, 409)

    def test_edit_refuses_broken_file(self):
        with self.assertRaises(model_roles.ModelRolesError) as cm:
            edit({"default": "a/b"}, text="modelRoles: [a]\n")
        self.assertEqual(cm.exception.status, 409)


class _FakeRequest:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


class RouteTest(unittest.IsolatedAsyncioTestCase):
    """The PUT route's validate -> write -> omp-check -> revert-on-rejection
    flow, with acli stubbed so no omp subprocess runs. IsolatedAsyncioTestCase
    on purpose: async tests on plain TestCase never run their assertions."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ompgw-roles-")
        self.config = Path(self.tmp.name) / "config.yml"
        self.acli = mock.patch.object(main, "acli", mock.AsyncMock(return_value=""))

    def tearDown(self):
        self.tmp.cleanup()

    async def test_put_success(self):
        self.config.write_text(SRC)
        with mock.patch.object(main, "CONFIG_FILE", self.config), self.acli:
            out = await main.put_model_roles(_FakeRequest({"roles": {"default": "a/b"}, "fallbacks": {"slow": None}}))
        self.assertTrue(out["ok"])
        self.assertEqual(out["roles"]["default"], "a/b")
        self.assertNotIn("slow", out["fallbacks"])
        self.assertIn("web", out["roles"])  # roles left out keep their value

    async def test_put_reverts_rejected_write(self):
        self.config.write_text(SRC)
        self.acli = mock.patch.object(
            main, "acli", mock.AsyncMock(side_effect=HTTPException(502, "omp failed")))
        with mock.patch.object(main, "CONFIG_FILE", self.config), self.acli:
            with self.assertRaises(HTTPException) as cm:
                await main.put_model_roles(_FakeRequest({"roles": {"default": "a/b"}}))
        self.assertEqual(cm.exception.status_code, 400)
        self.assertIn("reverted", cm.exception.detail)
        self.assertEqual(self.config.read_text(), SRC)  # byte-identical revert

    async def test_put_reverts_by_removing_a_fresh_file(self):
        # The config did not exist before this write: the revert must remove it
        # instead of reading a backup that is not there (FileNotFoundError).
        self.acli = mock.patch.object(
            main, "acli", mock.AsyncMock(side_effect=HTTPException(502, "omp failed")))
        with mock.patch.object(main, "CONFIG_FILE", self.config), self.acli:
            with self.assertRaises(HTTPException) as cm:
                await main.put_model_roles(_FakeRequest({"roles": {"default": "a/b"}}))
        self.assertEqual(cm.exception.status_code, 400)
        self.assertFalse(self.config.exists())

    async def test_put_revert_ignores_a_stale_backup(self):
        # The branch is on pre-write existence, not backup presence: a backup
        # left over from an earlier write must not be restored over a file omp
        # just rejected.
        self.acli = mock.patch.object(
            main, "acli", mock.AsyncMock(side_effect=HTTPException(502, "omp failed")))
        Path(self.tmp.name, main.model_roles.BACKUP_NAME).write_text("stale: true\n")
        with mock.patch.object(main, "CONFIG_FILE", self.config), self.acli:
            with self.assertRaises(HTTPException) as cm:
                await main.put_model_roles(_FakeRequest({"roles": {"default": "a/b"}}))
        self.assertEqual(cm.exception.status_code, 400)
        self.assertFalse(self.config.exists())
        self.assertEqual(Path(self.tmp.name, main.model_roles.BACKUP_NAME).read_text(), "stale: true\n")

    async def test_get_missing_file_is_404(self):
        with mock.patch.object(main, "CONFIG_FILE", self.config):
            with self.assertRaises(main.model_roles.ModelRolesError) as cm:
                await main.get_model_roles()
        self.assertEqual(cm.exception.status, 404)


if __name__ == "__main__":
    unittest.main()
