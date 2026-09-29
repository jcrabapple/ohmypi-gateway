#!/usr/bin/env python3
"""Derive trimmed test fixtures from the real captures in dev/fixtures (kept out of git).

    python3 web/scripts/derive-fixtures.py

Every string goes through the same deterministic `clean`, so a text that appears in
both the history capture and the event capture stays identical in both outputs.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "dev" / "fixtures"
TRANSCRIPT = ROOT / "web" / "src" / "lib" / "transcript" / "__fixtures__"
API = ROOT / "web" / "src" / "lib" / "api" / "__fixtures__"

MAX_TEXT = 240
DROP_KEYS = {
    "providerPayload", "thinkingSignature", "textSignature", "credentialId", "partial",
    "meta", "displayContent", "responseId", "baseUrl",
}
HOME = re.compile(r"/(?:var/)?home/[^/\s\"']+")


def clean(s: str) -> str:
    s = HOME.sub("/home/user", s)
    s = s.replace("jason", "user")
    if len(s) > MAX_TEXT:
        s = s[: MAX_TEXT - 12].rstrip() + " [trimmed]"
    return s


def walk(o):
    if isinstance(o, str):
        return clean(o)
    if isinstance(o, list):
        return [walk(x) for x in o]
    if isinstance(o, dict):
        return {k: walk(v) for k, v in o.items() if k not in DROP_KEYS}
    return o


def thin_events(events):
    """Keep boundary events and the first two deltas of each streamed block."""
    out, run = [], {}
    for x in events:
        e = x["event"]
        if e.get("type") == "message_update":
            a = e["assistantMessageEvent"]
            t = a["type"]
            if t.endswith("_delta"):
                k = (e.get("messageId"), a.get("contentIndex"), t)
                run[k] = run.get(k, 0) + 1
                if run[k] > 2:
                    continue
        out.append(x)
    return out


def dump(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    print("wrote", path.relative_to(ROOT), path.stat().st_size, "bytes")


def load(name):
    return json.loads((SRC / name).read_text())


def main():
    dump(TRANSCRIPT / "messages.json", walk(load("messages.json")))
    dump(TRANSCRIPT / "turn-tools-markdown.json", walk(thin_events(load("turn-tools-markdown.json"))))
    slash = load("slash.json")
    slash["events"] = thin_events(slash["events"])
    for x in slash["events"]:
        e = x["event"]
        if e.get("type") == "available_commands_update":
            e["commands"] = e["commands"][:3]
    dump(TRANSCRIPT / "slash.json", walk(slash))
    dump(API / "session-info.json", walk(load("session-info.json")))


if __name__ == "__main__":
    main()
