#!/usr/bin/env python3
"""Session-storage hygiene for the omp agent dir (~/.omp/agent).

omp v18.4.2 keeps per-cwd bucket directories under `sessions/` (one is created
the moment a session spawns, even if it never persists a message) and pointer
files under `custom-session-files/` (written on custom --session / resume
spawns). Neither is ever cleaned up:

  - `omp gc` only considers *.jsonl files; empty bucket directories survive
    forever and every directory shows up as a project in session pickers.
  - gc uses custom-session-files pointers only to PROTECT referenced sessions;
    dangling pointers are ignored, never pruned.

This tool removes exactly that unambiguous litter: bucket directories with no
files under them, and pointer files whose target no longer exists. Actual
session transcripts (live or archived) are never touched here - archival and
deletion of real sessions is `omp gc`'s job.

Usage:
  python3 scripts/omp-sessions.py report           # sizes and counts only
  python3 scripts/omp-sessions.py vacuum           # dry run: what would go
  python3 scripts/omp-sessions.py vacuum --apply   # actually remove litter

Exit code is 0 unless something failed.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

AGENT_DIR = Path(os.path.expanduser("~/.omp/agent"))
SESSIONS = AGENT_DIR / "sessions"
POINTERS = AGENT_DIR / "custom-session-files"


def bucket_has_files(bucket: Path) -> bool:
    for _root, _dirs, files in os.walk(bucket):
        if files:
            return True
    return False


def iter_buckets() -> list[Path]:
    if not SESSIONS.is_dir():
        return []
    return sorted(p for p in SESSIONS.iterdir() if p.is_dir())


def iter_pointers() -> list[Path]:
    if not POINTERS.is_dir():
        return []
    return sorted(p for p in POINTERS.iterdir() if p.is_file())


def classify_pointers() -> tuple[list[Path], list[Path], list[Path]]:
    """Returns (valid, dangling, unreadable) pointer files."""
    valid: list[Path] = []
    dangling: list[Path] = []
    unreadable: list[Path] = []
    for p in iter_pointers():
        try:
            target = p.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            unreadable.append(p)
            continue
        if target and Path(target).is_file():
            valid.append(p)
        else:
            dangling.append(p)
    return valid, dangling, unreadable


def cmd_report() -> int:
    buckets = iter_buckets()
    empty = [b for b in buckets if not bucket_has_files(b)]
    live = [p for p in SESSIONS.rglob("*.jsonl")] if SESSIONS.is_dir() else []
    valid, dangling, unreadable = classify_pointers()
    archive = AGENT_DIR / "archive" / "sessions"
    archived = len(list(archive.rglob("*.jsonl*"))) if archive.is_dir() else 0

    print(f"sessions dir:      {SESSIONS}")
    print(f"  bucket dirs:     {len(buckets)} ({len(empty)} empty -> vacuum)")
    print(f"  live transcripts: {len(live)}")
    print(f"custom-session-files: {len(valid) + len(dangling) + len(unreadable)}")
    print(f"  valid (protects a live session):   {len(valid)}")
    print(f"  dangling (target gone -> vacuum):  {len(dangling)}")
    for p in dangling[:5]:
        print(f"    e.g. {p.name}")
    if len(dangling) > 5:
        print(f"    ... and {len(dangling) - 5} more")
    if unreadable:
        print(f"  unreadable (left alone):           {len(unreadable)}")
    print(f"archived transcripts: {archived} ({archive})")
    return 0


def cmd_vacuum(apply: bool) -> int:
    empty = [b for b in iter_buckets() if not bucket_has_files(b)]
    valid, dangling, _unreadable = classify_pointers()

    for b in empty:
        print(f"rmdir  {b}")
    for p in dangling:
        print(f"rm     {p}")
    print(f"\n{len(empty)} empty bucket dirs, {len(dangling)} dangling pointers")
    if not apply:
        print("dry run - pass --apply to remove them")
        return 0

    errors = 0
    for b in empty:
        try:
            b.rmdir()  # only succeeds when truly empty; os.walk raced = skip
        except OSError as exc:
            print(f"  failed: {b}: {exc}", file=sys.stderr)
            errors += 1
    for p in dangling:
        try:
            p.unlink()
        except OSError as exc:
            print(f"  failed: {p}: {exc}", file=sys.stderr)
            errors += 1
    print(f"removed {len(empty) - errors} dirs + {len(dangling)} pointers" if not errors
          else f"done with {errors} failures")
    return 1 if errors else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("report", help="print storage counts")
    v = sub.add_parser("vacuum", help="remove empty bucket dirs and dangling pointers")
    v.add_argument("--apply", action="store_true", help="actually remove (default: dry run)")
    args = ap.parse_args()
    if args.cmd == "report":
        return cmd_report()
    return cmd_vacuum(args.apply)


if __name__ == "__main__":
    sys.exit(main())
