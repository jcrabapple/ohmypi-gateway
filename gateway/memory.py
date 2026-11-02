"""Oscar memory graph: the assistant's durable knowledge, exposed to the web client.

The store is `~/.omp/agent/memory`: markdown notes are the source of truth,
`graph.db` is a rebuildable SQLite/FTS5 index of notes, skills, tags and typed
edges, and `oscar-memory index` (an external script) rebuilds that index from
the markdown tree.

This module reads the index read-only and writes notes as markdown. It never
touches mnemopi's working memory beyond SELECTs: those rows carry embeddings
from mnemopi's own pipeline, and rewriting content here would silently degrade
semantic recall. Episodic rows are surfaced as read-only context.

Everything takes an explicit `root` so tests can point at a temp HOME; the
runtime root is OMP_AGENT_DIR/memory (OMP_AGENT_DIR is already configurable and
is what /api/skills reads).
"""

from __future__ import annotations

import contextlib
import os
import re
import shutil
import sqlite3
import subprocess
import time
from datetime import datetime
from pathlib import Path

from .bridge import OMP_AGENT_DIR

# Note ids in graph.db are the frontmatter `id:` value, e.g.
# "note-20260928-oscar-telegram-bridge-architecture" (no namespace prefix;
# skills and tags are namespaced as skill:x / tag:x). A leading "note:" is
# accepted on input for the places that do namespace notes, and normalized away.
NOTE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
NOTE_PREFIX = "note:"
MAX_EPISODIC = 50
MAX_BODY_CHARS = 200_000


class MemoryError_(Exception):
    """Bad input or a store problem; `status` maps to the HTTP code."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status
        self.message = message


def memory_root() -> Path:
    override = os.environ.get("OMPGW_MEMORY_DIR")
    return Path(override).expanduser() if override else OMP_AGENT_DIR / "memory"


def notes_dir(root: Path) -> Path:
    return root / "notes"


def archive_dir(root: Path) -> Path:
    return root / "archive"


def _home_for(root: Path) -> Path:
    """The HOME whose `.omp/agent/memory` is `root`, for the index CLI.

    `root` is <home>/.omp/agent/memory, so the home directory is three levels
    up. Tests build that same shape under a temporary directory.
    """
    try:
        return root.parent.parent.parent
    except IndexError:  # pragma: no cover - Path.parents cannot actually fail here
        return Path.home()


def _cli_path() -> str | None:
    override = os.environ.get("OMPGW_OSCAR_MEMORY")
    if override:
        return override
    found = shutil.which("oscar-memory")
    if found:
        return found
    fallback = Path.home() / ".local" / "bin" / "oscar-memory"
    return str(fallback) if fallback.is_file() else None


def reindex(root: Path | None = None, timeout: float = 60) -> dict:
    """Rebuild graph.db from the markdown tree. Degrades to `indexed: False`
    when the CLI is absent: the note file is still the source of truth."""
    root = root or memory_root()
    cli = _cli_path()
    if not cli:
        return {"indexed": False, "reason": "oscar-memory not found on this host"}
    env = dict(os.environ)
    env["HOME"] = str(_home_for(root))
    try:
        out = subprocess.run([cli, "index"], capture_output=True, text=True,
                             timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return {"indexed": False, "reason": "oscar-memory index timed out"}
    except OSError as e:
        return {"indexed": False, "reason": f"oscar-memory index failed: {e}"}
    if out.returncode != 0:
        detail = (out.stderr or out.stdout).strip().splitlines()
        return {"indexed": False, "reason": detail[-1] if detail else "index failed"}
    return {"indexed": True, "output": out.stdout.strip()[-200:]}


def _connect(root: Path) -> sqlite3.Connection:
    """Read-only connection. graph.db is a cache; a missing file is an empty
    store, not an error path (the UI shows the empty state)."""
    db = root / "graph.db"
    if not db.is_file():
        raise MemoryError_("memory index is not built yet", 404)
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def _clean_query(q: str) -> str:
    # FTS5 treats these as syntax; the index CLI does the same strip.
    return re.sub(r"[\"']", " ", q).strip()


def stats(root: Path | None = None) -> dict:
    root = root or memory_root()
    counts = {"note": 0, "skill": 0, "tag": 0, "edges": 0}
    hot: list[dict] = []
    try:
        with contextlib.closing(_connect(root)) as conn:
            for row in conn.execute("SELECT kind, COUNT(*) AS n FROM nodes GROUP BY kind"):
                if row["kind"] in counts:
                    counts[row["kind"]] = row["n"]
            counts["edges"] = conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
            for row in conn.execute(
                "SELECT n.id, n.title FROM tiers t JOIN nodes n ON n.id = t.id "
                "WHERE t.tier = 'hot' ORDER BY n.updated DESC LIMIT 8"
            ):
                hot.append({"id": row["id"], "title": row["title"]})
    except (MemoryError_, sqlite3.Error):
        counts = {k: 0 for k in counts}
    hot_md = root / "HOT.md"
    return {
        "counts": counts,
        "hot": hot,
        "root": str(root),
        "hasHotFile": hot_md.is_file(),
    }


def _bare(nid: str) -> str:
    """The store's own note id: strip a leading 'note:' if a caller used it."""
    nid = (nid or "").strip()
    return nid[len(NOTE_PREFIX):] if nid.startswith(NOTE_PREFIX) else nid


def _tier(conn: sqlite3.Connection, nid: str) -> str:
    row = conn.execute("SELECT tier FROM tiers WHERE id = ?", (nid,)).fetchone()
    return row["tier"] if row else "warm"


def search(q: str = "", limit: int = 20, root: Path | None = None) -> dict:
    """FTS5 ranked search over notes and skills. An empty query lists the most
    recently indexed notes instead."""
    root = root or memory_root()
    limit = max(1, min(int(limit or 20), 100))
    rows: list[dict] = []
    try:
        with contextlib.closing(_connect(root)) as conn:
            if not _clean_query(q):
                for row in conn.execute(
                    "SELECT n.id, n.title, n.kind FROM nodes n "
                    "LEFT JOIN tiers t ON t.id = n.id WHERE n.kind = 'note' "
                    "ORDER BY COALESCE(n.updated, 0) DESC, n.title LIMIT ?", (limit,)
                ):
                    rows.append({"id": row["id"], "title": row["title"], "kind": row["kind"],
                                 "tier": _tier(conn, row["id"]), "snippet": ""})
                return {"query": "", "notes": rows}
            safe = _clean_query(q)
            try:
                cur = conn.execute(
                    "SELECT f.id, f.title, bm25(nodes_fts) AS rank, "
                    "snippet(nodes_fts, 2, '', '', '…', 14) AS snip, n.kind "
                    "FROM nodes_fts f JOIN nodes n ON n.id = f.id "
                    "LEFT JOIN tiers t ON t.id = f.id "
                    "WHERE nodes_fts MATCH ? AND n.kind = 'note' "
                    "ORDER BY CASE t.tier WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 "
                    "WHEN 'archived' THEN 2 ELSE 1 END, rank LIMIT ?",
                    (safe, limit))
            except sqlite3.OperationalError:
                # Bare punctuation, operators and other FTS syntax: fall back to
                # a plain title/body scan rather than erroring at the user.
                cur = conn.execute(
                    "SELECT f.id, f.title, 0 AS rank, '' AS snip, n.kind "
                    "FROM nodes_fts f JOIN nodes n ON n.id = f.id "
                    "WHERE n.kind = 'note' AND (f.title LIKE ? OR f.body LIKE ?) LIMIT ?",
                    (f"%{q}%", f"%{q}%", limit))
            for row in cur:
                rows.append({"id": row["id"], "title": row["title"], "kind": row["kind"],
                             "tier": _tier(conn, row["id"]), "snippet": row["snip"] or ""})
    except MemoryError_ as e:
        return {"query": q, "notes": [], "error": e.message}
    except sqlite3.Error:
        return {"query": q, "notes": [], "error": "the memory index could not be read"}
    return {"query": q, "notes": rows}


FRONTMATTER_FENCE = re.compile(r"^---[ \t]*$", re.MULTILINE)


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split the fence on lines that are exactly '---'. A title containing dashes
    (e.g. "Phase 1 --- Initial Design") must not end the block early, which a
    plain split("---") would do."""
    meta: dict[str, str] = {}
    body = text
    fences = list(FRONTMATTER_FENCE.finditer(text))
    if text.startswith("---") and len(fences) >= 2:
        head_start = fences[0].end()
        head_end = fences[1].start()
        for line in text[head_start:head_end].splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip()
        body = text[fences[1].end():].strip()
    return meta, body


def _split(value: str | None) -> list[str]:
    return [p.strip() for p in (value or "").split(",") if p.strip()]


def _note_file(root: Path, nid: str) -> Path | None:
    """Resolve a note id to its markdown file, notes/ first then archive/.
    Only files that resolve inside those two directories are eligible."""
    stem = _bare(nid)
    if not NOTE_ID.match(stem):
        return None
    for base in (notes_dir(root), archive_dir(root)):
        candidate = base / f"{stem}.md"
        try:
            real_base = base.resolve()
            real = candidate.resolve()
        except OSError:
            continue
        if real.is_file() and real.is_relative_to(real_base):
            return real
    return None


def get_note(nid: str, root: Path | None = None) -> dict:
    root = root or memory_root()
    nid = _bare(nid)
    if not NOTE_ID.match(nid):
        raise MemoryError_("bad note id", 422)
    path = _note_file(root, nid)
    if path is None:
        raise MemoryError_("no such note", 404)
    meta, body = _parse_frontmatter(path.read_text(errors="replace"))
    out: list[dict] = []
    inc: list[dict] = []
    tier = "warm"
    try:
        with contextlib.closing(_connect(root)) as conn:
            tier = _tier(conn, nid)
            for row in conn.execute("SELECT dst, kind FROM edges WHERE src = ? ORDER BY kind, dst", (nid,)):
                out.append({"id": row["dst"], "kind": row["kind"]})
            for row in conn.execute("SELECT src, kind FROM edges WHERE dst = ? ORDER BY kind, src", (nid,)):
                inc.append({"id": row["src"], "kind": row["kind"]})
    except (MemoryError_, sqlite3.Error):
        pass
    return {
        "id": nid,
        "title": meta.get("title") or path.stem,
        "tags": _split(meta.get("tags")),
        "links": _split(meta.get("links")),
        "body": body,
        "path": str(path),
        "tier": tier,
        "archived": path.parent.name == "archive",
        "outgoing": out,
        "incoming": inc,
    }


def _slug(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return (slug[:40].rstrip("-") or "note")


def _mint_id(root: Path, title: str) -> str:
    day = datetime.now().strftime("%Y%m%d")
    base = f"note-{day}-{_slug(title)}"
    candidate, n = base, 1
    while (notes_dir(root) / f"{candidate}.md").exists() or (archive_dir(root) / f"{candidate}.md").exists():
        n += 1
        candidate = f"{base}-{n}"
    return candidate


def _compose(title: str, tags: list[str], links: list[str], body: str, nid: str) -> str:
    lines = ["---", f"id: {nid}", f"title: {title}"]
    if tags:
        lines.append(f"tags: {', '.join(tags)}")
    if links:
        lines.append(f"links: {', '.join(links)}")
    lines += ["---", "", body.strip(), ""]
    return "\n".join(lines)


def save_note(*, nid: str | None = None, title: str, tags: list[str] | None = None,
              links: list[str] | None = None, body: str,
              root: Path | None = None) -> dict:
    """Create or update a note, then rebuild the index. The markdown write and
    the index rebuild are separate steps on purpose: a rebuild failure still
    leaves the note saved, and the response says so."""
    root = root or memory_root()
    title = (title or "").strip()
    if not title:
        raise MemoryError_("a note needs a title", 422)
    if len(title) > 200:
        raise MemoryError_("title is too long", 422)
    if len(body or "") > MAX_BODY_CHARS:
        raise MemoryError_("note body is too long", 413)
    # The store is line-based frontmatter: a newline in any field would forge
    # keys or close the block early, and a comma would split one tag into two.
    if "\n" in title or "\r" in title:
        raise MemoryError_("a title cannot contain line breaks", 422)
    # The indexer parses this file with split("---", 2), so a fence inside a
    # field desyncs the note from graph.db. The reader below is deliberately more
    # tolerant (line-anchored) so legacy notes still open; writers stay strict.
    if "---" in title:
        raise MemoryError_("a title cannot contain '---' (the store's fence)", 422)
    tags = [t.strip() for t in (tags or []) if isinstance(t, str) and t.strip()][:20]
    links = [l.strip() for l in (links or []) if isinstance(l, str) and l.strip()][:40]
    for field_name, values in (("tag", tags), ("link", links)):
        for value in values:
            if "\n" in value or "\r" in value or "," in value or "---" in value:
                raise MemoryError_(
                    f"a {field_name} cannot contain line breaks, commas or '---'", 422)

    created = False
    if nid:
        nid = _bare(nid)
        if not NOTE_ID.match(nid):
            raise MemoryError_("bad note id", 422)
        path = _note_file(root, nid)
        if path is None:
            raise MemoryError_("no such note", 404)
    else:
        created = True
        nid = _mint_id(root, title)
        path = notes_dir(root) / f"{nid}.md"
    notes_dir(root).mkdir(parents=True, exist_ok=True)
    path.write_text(_compose(title, tags, links, body or "", nid))
    index = reindex(root)
    return {"id": nid, "created": created, "path": str(path), "index": index,
            "note": get_note(nid, root) if index.get("indexed") else None}


def archive_note(nid: str, root: Path | None = None) -> dict:
    """Demote a note to archive/ (the store's own tiering move, reversible by
    editing the file back or promoting it again)."""
    root = root or memory_root()
    path = _note_file(root, nid)
    if path is None:
        raise MemoryError_("no such note", 404)
    if path.parent.name == "archive":
        return {"ok": True, "already": True}
    archive_dir(root).mkdir(parents=True, exist_ok=True)
    target = archive_dir(root) / path.name
    if target.exists():
        raise MemoryError_("a note with that name is already archived", 409)
    path.rename(target)
    return {"ok": True, "path": str(target), "index": reindex(root)}


def mnemopi_banks(root: Path | None = None) -> list[Path]:
    """Every mnemopi store on this host: the shared store plus one bank per
    project. Read-only use only."""
    base = Path(os.environ.get("OMPGW_MNEMOPI_DIR") or
                (Path(os.environ.get("OMP_AGENT_DIR") or OMP_AGENT_DIR) / "memories" / "mnemopi"))
    dbs: list[Path] = []
    shared = base / "mnemopi.db"
    if shared.is_file():
        dbs.append(shared)
    banks = base / "banks"
    if banks.is_dir():
        dbs.extend(sorted(p for p in banks.glob("*/mnemopi.db") if p.is_file()))
    return dbs


def episodic(q: str = "", limit: int = 20) -> dict:
    """Read-only scan of mnemopi working memory (the fuzzy episodic layer).

    There is no embedding model in the gateway, so this is a substring scan
    ordered newest-first: honest recent/browse, not semantic recall. Editing is
    deliberately absent; mnemopi owns its embeddings."""
    limit = max(1, min(int(limit or 20), MAX_EPISODIC))
    term = (q or "").strip()
    rows: list[dict] = []
    scanned = 0
    banks = mnemopi_banks()
    for db in banks:
        bank = db.parent.name if db.parent.name != "mnemopi" else "shared"
        try:
            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=3)
            conn.row_factory = sqlite3.Row
        except sqlite3.Error:
            continue
        try:
            if term:
                cur = conn.execute(
                    "SELECT id, content, source, importance, scope, timestamp FROM working_memory "
                    "WHERE content LIKE ? ORDER BY timestamp DESC LIMIT ?",
                    (f"%{term}%", limit))
            else:
                cur = conn.execute(
                    "SELECT id, content, source, importance, scope, timestamp FROM working_memory "
                    "ORDER BY timestamp DESC LIMIT ?", (limit,))
            for row in cur:
                scanned += 1
                rows.append({
                    "id": row["id"], "bank": bank,
                    "content": (row["content"] or "")[:2000],
                    "source": row["source"], "importance": row["importance"],
                    "scope": row["scope"],
                    # Column type is not enforced across old banks: epoch ints
                    # exist. Clients format this as text, so always send text.
                    "timestamp": None if row["timestamp"] is None else str(row["timestamp"]),
                })
        except sqlite3.Error:
            continue
        finally:
            conn.close()
    rows.sort(key=lambda r: str(r["timestamp"] or ""), reverse=True)
    return {"query": term, "rows": rows[:limit], "scanned": scanned,
            "banks": len(banks)}
