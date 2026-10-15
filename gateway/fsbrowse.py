"""Folder listing for the New session folder picker.

Directories only, dotfolders hidden, sorted by name, capped at MAX_DIRS.
Names and paths only: no file contents, no sizes. The gateway already accepts
any cwd when starting a session, so listing folders adds no new reach.

Paths are returned realpath-resolved (on Aurora /home -> /var/home) so the
folder the client picks is the same string omp will report back.
"""

from __future__ import annotations

import os
from pathlib import Path

MAX_DIRS = 500


class FsBrowseError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def list_subdirs(raw: str = "") -> dict:
    if "\x00" in raw:
        raise FsBrowseError(422, "path contains a NUL byte")
    home = os.path.realpath(os.path.expanduser("~"))
    if raw.strip():
        start = os.path.expanduser(raw.strip())
    else:
        start = os.path.join(home, "projects")
        if not os.path.isdir(start):
            start = home
    try:
        target = os.path.realpath(start)
        dirs: list[dict] = []
        with os.scandir(target) as it:
            for de in it:
                if de.name.startswith("."):
                    continue
                try:
                    if not de.is_dir():
                        continue
                except OSError:
                    continue  # dangling link or vanished mid-scan
                dirs.append({"name": de.name, "path": os.path.join(target, de.name)})
    except FileNotFoundError:
        raise FsBrowseError(404, "no such folder") from None
    except NotADirectoryError:
        raise FsBrowseError(422, "not a folder") from None
    except PermissionError:
        raise FsBrowseError(403, "folder is not readable") from None
    except OSError:
        # ENAMETOOLONG, ELOOP and friends: unresolvable on this filesystem.
        raise FsBrowseError(422, "folder cannot be listed") from None
    dirs.sort(key=lambda d: d["name"].lower())
    parent = str(Path(target).parent) if target != os.path.sep else None
    return {
        "path": target,
        "parent": parent,
        "home": home,
        "dirs": dirs[:MAX_DIRS],
        "truncated": len(dirs) > MAX_DIRS,
    }
