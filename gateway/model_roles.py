"""Model-role settings: the `modelRoles` and `retry.fallbackChains` blocks of
the omp config file, edited per role instead of by hand.

The edit is a round-trip rewrite (ruamel.yaml), so comments and formatting
everywhere else in config.yml survive; only the touched blocks change. One
known edge: a comment that visually trails a block is stored by ruamel on the
block's last node, so removing the last entry of a block (unsetting the last
role or chain) loses that trailing comment with the block. Salvaging it is not
possible without also resurrecting comments that describe deleted entries, so
it is documented in docs/API.md instead.

Why not `omp config set`: it rewrites the whole file and drops every comment,
so saving one role from the GUI would wipe the user's annotations elsewhere.

Role taxonomy (omp docs/models.md): chat roles default, smol, slow, vision,
plan, commit, tiny, memory, task, advisor; model-kind roles image, web,
speech, dictation, judge; custom names allowed. This module validates shape
and charset only - omp validates resolution at runtime, and the taxonomy can
grow with omp versions, so it is not hard-coded here.
"""

from __future__ import annotations

import re
from io import StringIO
from pathlib import Path

from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError

CONFIG_NAME = "config.yml"
BACKUP_NAME = "config.yml.bak-gateway"

# A role name: omp's own roles and examples are lowercase; keep custom names
# to the same shape (lowercase start, then lowercase letters, digits, - and _).
ROLE_RE = re.compile(r"^[a-z][a-z0-9_-]{0,39}$")

# One selector: provider/model-id, a wildcard (provider/* or *), a role alias
# (@smol), optionally with a trailing :thinking-level suffix. Comma-separated
# lists are allowed as a role value; the first available one wins.
SELECTOR_RE = re.compile(r"^[A-Za-z0-9_*@][A-Za-z0-9_*/.+-]*(?::[A-Za-z0-9_.-]{1,31})?$")

MAX_VALUE_LEN = 2048
MAX_SEGMENTS = 16
MAX_CHAIN = 16
MAX_ROLE_NAME = 40


class ModelRolesError(Exception):
    """Carries an HTTP status: 422 for a bad request, 409 for a config file
    that is too broken to edit safely."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.message = message
        self.status = status


def _selector_ok(value: str) -> bool:
    segments = [s.strip() for s in value.split(",")]
    if len(segments) > MAX_SEGMENTS or any(not s for s in segments):
        return False
    return all(SELECTOR_RE.match(s) for s in segments)


def validate_changes(body: dict) -> tuple[dict[str, str | None], dict[str, list[str] | None]]:
    """Shape-check a PUT body into per-role change maps. `None` unsets a role
    (or its fallback chain); keys absent from the body keep their value."""
    if not isinstance(body, dict):
        raise ModelRolesError("body must be an object")
    unknown = set(body) - {"roles", "fallbacks"}
    if unknown:
        raise ModelRolesError(f"unknown key(s): {', '.join(sorted(unknown))}")

    roles_in = body.get("roles")
    chains_in = body.get("fallbacks")
    if roles_in is None and chains_in is None:
        raise ModelRolesError("nothing to change: pass roles or fallbacks")

    def check_role(role: str) -> str:
        if not isinstance(role, str) or not ROLE_RE.match(role):
            raise ModelRolesError(f"bad role name {role!r}: use lowercase letters, digits, - or _")
        return role

    roles: dict[str, str | None] = {}
    if roles_in is not None:
        if not isinstance(roles_in, dict):
            raise ModelRolesError("roles must be an object")
        for role, value in roles_in.items():
            check_role(role)
            if value is None:
                roles[role] = None
            elif isinstance(value, str) and value.strip() and len(value) <= MAX_VALUE_LEN and _selector_ok(value.strip()):
                roles[role] = value.strip()
            else:
                raise ModelRolesError(
                    f"bad selector for {role!r}: expected provider/model[:level]"
                    f" (comma-separated, at most {MAX_SEGMENTS})"
                )

    fallbacks: dict[str, list[str] | None] = {}
    if chains_in is not None:
        if not isinstance(chains_in, dict):
            raise ModelRolesError("fallbacks must be an object")
        for role, chain in chains_in.items():
            check_role(role)
            if chain is None:
                fallbacks[role] = None
            elif (
                isinstance(chain, list)
                and 1 <= len(chain) <= MAX_CHAIN
                and all(isinstance(s, str) and s.strip() and len(s) <= 256 and SELECTOR_RE.match(s.strip()) for s in chain)
            ):
                fallbacks[role] = [s.strip() for s in chain]
            else:
                raise ModelRolesError(
                    f"bad fallback chain for {role!r}: expected a list of 1-{MAX_CHAIN} provider/model selectors"
                )
    return roles, fallbacks


def _mapping(value: object, what: str) -> dict:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    raise ModelRolesError(f"{what} must be a mapping", 409)


def parse_state(text: str) -> dict:
    """The two blocks as plain JSON-able state: {roles, fallbacks}."""
    try:
        root = YAML(typ="rt").load(text)
    except YAMLError as e:
        raise ModelRolesError(f"config.yml does not parse: {e}", 409) from e
    if root is None:
        root = {}
    if not isinstance(root, dict):
        raise ModelRolesError("config.yml must be a mapping", 409)

    roles_block = _mapping(root.get("modelRoles"), "modelRoles")
    roles: dict[str, str] = {}
    for role, value in roles_block.items():
        if not isinstance(role, str) or not isinstance(value, str):
            raise ModelRolesError("modelRoles must map role names to selector strings", 409)
        roles[role] = value

    retry = root.get("retry")
    chains_block: dict = {}
    if retry is not None:
        retry = _mapping(retry, "retry")
        chains_block = _mapping(retry.get("fallbackChains"), "retry.fallbackChains")
    fallbacks: dict[str, list[str]] = {}
    for role, chain in chains_block.items():
        if not isinstance(role, str) or not isinstance(chain, list) or not all(isinstance(s, str) for s in chain):
            raise ModelRolesError("retry.fallbackChains must map role names to lists of selectors", 409)
        fallbacks[role] = list(chain)

    return {"roles": roles, "fallbacks": fallbacks}


def read_roles(config_file: Path) -> dict:
    if not config_file.exists():
        raise ModelRolesError(f"{config_file.name} not found", 404)
    return parse_state(config_file.read_text())


def edit(text: str, role_changes: dict[str, str | None], chain_changes: dict[str, list[str] | None]) -> str:
    """Apply per-role changes to the config text and return the new text.
    Input was validated by validate_changes; only the file's own shape can
    fail here (409)."""
    yaml = YAML(typ="rt")
    # omp config files (and this repo's own fixture) indent block-sequence
    # dashes two columns past their parent key. Matching that keeps untouched
    # blocks byte-identical on every write; ruamel's default (offset 0) would
    # silently reindent every deep sequence in the file.
    yaml.indent(sequence=2, offset=2)
    try:
        root = yaml.load(text)
    except YAMLError as e:
        raise ModelRolesError(f"config.yml does not parse: {e}", 409) from e
    if root is None:
        root = {}
    if not isinstance(root, dict):
        raise ModelRolesError("config.yml must be a mapping", 409)

    if role_changes:
        roles = root.get("modelRoles")
        if roles is None:
            roles = {}
            root["modelRoles"] = roles
        if not isinstance(roles, dict):
            raise ModelRolesError("modelRoles must be a mapping", 409)
        for role, value in role_changes.items():
            if value is None:
                roles.pop(role, None)
            else:
                roles[role] = value
        if not roles:
            del root["modelRoles"]

    if chain_changes:
        retry = root.get("retry")
        if retry is None:
            retry = {}
            root["retry"] = retry
        if not isinstance(retry, dict):
            raise ModelRolesError("retry must be a mapping", 409)
        chains = retry.get("fallbackChains")
        if chains is None:
            chains = {}
            retry["fallbackChains"] = chains
        if not isinstance(chains, dict):
            raise ModelRolesError("retry.fallbackChains must be a mapping", 409)
        for role, chain in chain_changes.items():
            if chain is None:
                chains.pop(role, None)
            else:
                chains[role] = chain
        if not chains:
            del retry["fallbackChains"]
        if not retry:
            del root["retry"]

    out = StringIO()
    yaml.dump(root, out)
    return out.getvalue()
