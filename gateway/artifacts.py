"""Session artifacts: fetching a file out of a session's working directory and
putting one in.

Both directions resolve against the session's real cwd and refuse anything that
escapes it, with the same rules the @-mention listing already uses: absolute
paths and '..' segments are rejected before any path math, and a symlink whose
target leaves the cwd is refused after resolution. Downloads stream from
the file; uploads are capped and never overwrite unless asked.
"""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path

MAX_UPLOAD_BYTES = int(os.environ.get("OMPGW_MAX_UPLOAD_BYTES", str(32 * 1024 * 1024)))
MAX_NAME = 200

# The gateway's own credentials and the usual local secret files. The listing
# already hides dotfiles, and a dot-directory is never an artifact: closing both
# keeps this route from being a tidy way to pull auth-token or ~/.ssh out of a
# session folder that happens to be a repo or a home directory.
_DENY_NAMES = {
    "auth-token", "gateway.env", "push-vapid.json", "push-subs.json",
    "search-index.db", "id_rsa", "id_ed25519", "id_ecdsa",
    ".env", ".netrc", ".git-credentials", ".pgpass",
}

# Extensions the browser should never render inline: these are downloads, not
# a way to serve active content from the gateway origin.
_HTML_LIKE = {".html", ".htm", ".xhtml", ".svg", ".xml", ".js", ".mjs"}


class ArtifactError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def reject_rel(rel: str) -> str | None:
    """Path problems rejected outright, before any filesystem access."""
    if "\x00" in rel:
        return "path contains a null byte"
    if rel.startswith(("/", "\\")) or (len(rel) >= 2 and rel[1] == ":"):
        return "path must be relative to the session directory"
    if any(part == ".." for part in rel.replace("\\", "/").split("/")):
        return "path must not contain '..'"
    return None


def _parts(rel: str) -> list[str]:
    return [p for p in rel.replace("\\", "/").split("/") if p not in ("", ".")]


def _reject_sensitive(path: Path) -> None:
    """Hidden directories and known secret files are out of scope for artifacts."""
    if any(part.startswith(".") for part in path.parts):
        raise ArtifactError("hidden files and folders are not served here", 403)
    if path.name in _DENY_NAMES:
        raise ArtifactError("that file is not served here", 403)


def _inside(cwd_real: str, target: str) -> bool:
    # is_relative_to also covers cwd == "/" (a startswith(cwd + sep) test
    # builds "//" there and rejects every child).
    return Path(target).is_relative_to(Path(cwd_real))


def resolve_file(cwd: str, rel: str) -> Path:
    """Absolute path of one regular file inside the session cwd."""
    bad = reject_rel(rel or "")
    if bad:
        raise ArtifactError(bad, 422)
    parts = _parts(rel or "")
    if not parts:
        raise ArtifactError("path is required", 422)
    cwd_real = os.path.realpath(cwd)
    try:
        target = os.path.realpath(os.path.join(cwd_real, *parts))
    except OSError:
        raise ArtifactError("path cannot be resolved", 422) from None
    if not _inside(cwd_real, target):
        raise ArtifactError("path escapes the session directory", 403)
    # Refused before any existence check: a hidden folder or a known secret file
    # is out of scope whether or not it happens to be there.
    _reject_sensitive(Path(*parts))
    path = Path(target)
    if not path.exists():
        raise ArtifactError("no such file", 404)
    if path.is_dir():
        raise ArtifactError("path is a directory", 415)
    if not path.is_file():
        raise ArtifactError("path is not a regular file", 415)
    return path


def resolve_dir(cwd: str, rel: str) -> Path:
    """Absolute path of a directory inside the session cwd ('' = the cwd)."""
    bad = reject_rel(rel or "")
    if bad:
        raise ArtifactError(bad, 422)
    cwd_real = os.path.realpath(cwd)
    parts = _parts(rel or "")
    try:
        target = os.path.realpath(os.path.join(cwd_real, *parts)) if parts else cwd_real
    except OSError:
        raise ArtifactError("path cannot be resolved", 422) from None
    if not _inside(cwd_real, target):
        raise ArtifactError("path escapes the session directory", 403)
    # A hidden folder is not an upload target, present or not: .git/hooks and
    # .ssh are the difference between "put a file in my project" and running code.
    if any(part.startswith(".") for part in parts):
        raise ArtifactError("hidden folders are not upload targets", 403)
    if not os.path.isdir(target):
        raise ArtifactError("no such directory", 404)
    return Path(target)


def safe_filename(name: str) -> str:
    """Leaf name only, no separators, no dotfile, bounded length."""
    name = (name or "").strip()
    if not name:
        raise ArtifactError("filename is required", 422)
    if "\x00" in name:
        raise ArtifactError("filename contains a null byte", 422)
    leaf = name.replace("\\", "/").rsplit("/", 1)[-1]
    if leaf in ("", ".", ".."):
        raise ArtifactError("bad filename", 422)
    if leaf.startswith("."):
        raise ArtifactError("filenames may not start with a dot", 422)
    if len(leaf) > MAX_NAME:
        raise ArtifactError("filename is too long", 422)
    return leaf


def save_upload(cwd: str, directory: str, filename: str, data: bytes,
                overwrite: bool = False) -> dict:
    """Write one uploaded file into `directory` (relative to the cwd)."""
    if len(data) > MAX_UPLOAD_BYTES:
        raise ArtifactError(f"file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB", 413)
    target_dir = resolve_dir(cwd, directory or "")
    leaf = safe_filename(filename)
    path = target_dir / leaf
    if leaf in _DENY_NAMES:
        raise ArtifactError("that file is not writable here", 403)
    # One syscall carries the whole policy: O_NOFOLLOW refuses a symlink at the
    # name (dangling or not), O_EXCL refuses an existing file unless the caller
    # asked to overwrite, and O_TRUNC only applies when they did. No check-then-
    # write window.
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | (os.O_TRUNC if overwrite else os.O_EXCL)
    try:
        fd = os.open(path, flags, 0o644)
    except FileExistsError:
        raise ArtifactError("a file with that name already exists", 409) from None
    except OSError as e:
        if e.errno in (getattr(os, "ELOOP", 40), getattr(os, "EMLINK", 31)):
            raise ArtifactError("that name is a symlink", 403) from None
        raise ArtifactError(f"could not write the file: {e.strerror or e}", 500) from None
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
    except OSError as e:
        raise ArtifactError(f"could not write the file: {e.strerror or e}", 500) from None
    rel = path.relative_to(Path(os.path.realpath(cwd))).as_posix() \
        if path.is_relative_to(Path(os.path.realpath(cwd))) else leaf
    return {"name": leaf, "path": rel, "size": len(data)}


def media_type(path: Path) -> str:
    """Always a download, never a page: HTML/SVG/JS get octet-stream so the
    gateway origin cannot be used to serve active content."""
    suffix = path.suffix.lower()
    if suffix in _HTML_LIKE:
        return "application/octet-stream"
    guess, _ = mimetypes.guess_type(path.name)
    if not guess:
        return "application/octet-stream"
    if guess.startswith("text/"):
        return f"{guess}; charset=utf-8"
    return guess
