# Collab Discovery Implementation Plan

> **For Hermes:** execute with the `subagent-driven-development` skill. Waves below are
> lane-owned; dispatch Wave 0 alone, then Wave 1 lanes in parallel, then Wave 2.

**Goal:** make `ohmypi-gateway` list interactive `omp` sessions it did not spawn (desk TUI, Tern
panes, the oscar harness) as read-only rows, and push when one of them starts waiting for input.

**Architecture:** stock `omp` (>= 18.1.20) publishes one metadata entry per interactive session with
`collab.autoStart` enabled: `~/.omp/run/collab-hosts/<entryId>.json` (mode 0600) plus a per-host
unix socket. A new `gateway/collab.py` reads that directory and queries each host over its socket
(newline JSON, one request per connection, `op: "snapshot"`). It keeps a metadata-only in-memory
registry with TTL reconciliation and mints an opaque ask identity on the `inputRequired`
false-to-true edge. `main.py` exposes the rows on `/api/sessions` and brokers one-shot capability
URLs; the Svelte client renders them next to gateway sessions.

**Tech Stack:** Python 3.14 / FastAPI / asyncio unix sockets, Svelte 5 + TS (bun, vitest), unittest.

**Baseline (recorded 2026-10-26, before any change):**
- `for f in tests/test_*.py; do .venv/bin/python $f; done` → 7 files OK; `tests/test_delete_saved.py`
  needs `PYTHONPATH=.` (pre-existing: it imports `gateway` without a `sys.path` insert). With that it
  is 2 tests OK.
- `cd web && bun run test` → 66 files / 745 tests passed. `bun run check` → 0 errors, 0 warnings.

**Verified upstream facts this plan relies on (probed 2026-10-26 on omp 18.12.6):**
- Entry JSON: `{version:1, instanceId, pid, endpoint, createdAt, token}`; `endpoint` is an absolute
  socket path (`/tmp/omp-collab-<hash>/<entryId>.sock` when the default path is too long).
- `{"v":1,"token":"<token>","op":"snapshot"}\n` → `{ok:true,v:1,snapshot:{instanceId,generation,pid,
  sessionId,sessionName,cwd,model:{provider,id},startedAt,participants,relayConnected,inputRequired,
  busy,access}}`.
- `{"op":"link","access":"view"|"control","generation":N}` → `{ok:true,url}` where url is
  `https://my.omp.sh/#<key>`. Errors: `stale_generation`, `access_unavailable`,
  `authentication_failed`, `not_found` (CLI only), `snapshot_unavailable`, `malformed_request`,
  `invalid_access`, `unsupported_protocol`.
- Only interactive mode publishes, so gateway `--mode rpc` children never appear here. No duplicate
  rows by construction.

## Decisions (do not re-litigate in lanes)

- **D1 Socket, not CLI.** Query hosts directly. `omp collab list --json` spawns a bun process per
  poll; the socket is one connect per host per poll with no child process.
- **D2 Inert by default.** Nothing appears unless the user enables `collab.autoStart`. We never write
  that setting; the gateway only reads. Production config stays `off` for this release.
- **D3 Read-only.** No transcript, no prompt text, no capability in the list or the registry. The
  gateway never stores a link URL. `access` from the snapshot only decides whether a Control link may
  be requested.
- **D4 Metadata only on `/api/sessions`.** Additive top-level key `external`; `live`/`saved` unchanged
  so every existing client keeps working.
- **D5 Full cwd is exposed.** Gateway rows already carry a full `cwd` (`SessionInfo.cwd`), so this is
  consistent; no basename-only projection.
- **D6 Liveness.** Only `ENOENT`/`ECONNREFUSED` (or an unreadable/malformed entry) retires a row
  immediately. Timeouts, `EACCES`, `EMFILE`, and protocol errors keep the last row with
  `stale: true` until `TTL_S` expires. `TTL_S = max(3 * POLL_S, 35)`.
- **D7 Ask identity.** Mint `requestId` (`secrets.token_urlsafe(8)`) on the false-to-true edge, keep
  it stable across repeated true samples, destroy on false, on removal, and on `generation` change.
  `since` is the mint time in epoch ms. One push per mint.
- **D8 Ordering.** `needsYou` renders gateway dialogs first, then external asks sorted oldest-first.
  Gateway `pendingUi` frames carry no timestamp, so no cross-source sort is attempted.
- **D9 No capability in the poller.** `link` is fetched only inside the `POST /api/collab/{id}/link`
  handler, per tap, never cached.

## Non-goals

Embedding OMP's `collab-web` client, Control/typing through the relay, Tailscale identity, multi-host
fleet polling, per-device notification detail levels, hold/hide triage. None of these ship here.

---

## Wave 0 — discovery module (runs ALONE)

**Owned files:**
- Create: `gateway/collab.py`
- Create: `tests/test_collab.py`

No other file may change in this wave. `main.py`, `push.py`, and everything under `web/` are off
limits until Wave 1.

### Task 0.1: module skeleton and entry parsing

**Objective:** `gateway/collab.py` imports cleanly and rejects every malformed discovery entry.

**Step 1: write the failing test** (`tests/test_collab.py`, header style copied from
`tests/test_fs_dirs.py`: docstring with the run line, `sys.path.insert` for the repo root,
`unittest`).

```python
class EntryTests(unittest.TestCase):
    def test_valid_entry(self):
        e = collab._read_entry(self.write_entry({"version": 1, "instanceId": "i" * 8, "pid": 42,
                                                 "endpoint": "/tmp/x.sock", "createdAt": 1,
                                                 "token": "t" * 64}))
        self.assertEqual((e["instanceId"], e["pid"], e["token"]), ("i" * 8, 42, "t" * 64))

    def test_rejects_bad_shapes(self):
        for bad in (
            {"version": 2, "instanceId": "i", "pid": 1, "endpoint": "/tmp/x.sock", "token": "t"},
            {"version": 1, "instanceId": "i", "pid": "1", "endpoint": "/tmp/x.sock", "token": "t"},
            {"version": 1, "instanceId": "i", "pid": 1, "endpoint": "x.sock", "token": "t"},
            {"version": 1, "instanceId": "i", "pid": 1, "endpoint": "/tmp/x.sock", "token": ""},
            {"version": 1, "instanceId": "i", "pid": 1, "endpoint": "/tmp/x.sock"},
            {},
        ):
            self.assertIsNone(collab._read_entry(self.write_entry(bad)))
        self.assertIsNone(collab._read_entry(self.dir / "missing.json"))
```

**Step 2:** `.venv/bin/python tests/test_collab.py` → FAIL (`ModuleNotFoundError: gateway.collab`).

**Step 3: minimal implementation.** Module docstring must state that the directory is read-only for
this process (never write, rename, unlink) and that no capability is ever requested here.

```python
COLLAB_DIR = Path(os.environ.get("OMPGW_COLLAB_DIR")
                  or (OMP_AGENT_DIR.parent / "run" / "collab-hosts")).expanduser()
POLL_S = float(os.environ.get("OMPGW_COLLAB_POLL_S", "10"))
TTL_S = max(3 * POLL_S, 35.0)
QUERY_TIMEOUT_S = 1.5
MAX_ENTRIES = 32
MAX_TITLE = 120
MAX_RESPONSE_BYTES = 64 * 1024

def _read_entry(path: Path) -> dict | None:
    """Parse one discovery file. Returns None for anything that is not a
    version-1 publication with an absolute socket path."""
```

Rules: `version == 1` (int), `instanceId` non-empty str, `pid` int > 0, `endpoint` str starting with
`/`, `token` non-empty str. Unknown extra fields are ignored. Any OSError/ValueError → `None`.

### Task 0.2: socket query

**Objective:** one bounded request/reply against a unix socket, no reader-loop deadlock.

**Test:** a real `asyncio.start_unix_server` in the temp dir that asserts one line arrived, replies
`{"ok":true,"v":1,"snapshot":{...}}\n`, and closes. Assert `_query` returns the parsed dict. Add a
case where the server sends no newline before closing (reply still parsed), a case where the reply
exceeds `MAX_RESPONSE_BYTES` (`None`), and a case where the socket does not exist (`OSError`).

**Implementation:**

```python
async def _query(endpoint: str, payload: dict) -> dict | None:
    async with asyncio.timeout(QUERY_TIMEOUT_S):
        reader, writer = await asyncio.open_unix_connection(endpoint)
    try:
        writer.write((json.dumps(payload) + "\n").encode())
        await writer.drain()
        buf = b""
        while len(buf) <= MAX_RESPONSE_BYTES:
            chunk = await reader.read(65536)
            if not chunk:
                break
            buf += chunk
            if buf.endswith(b"\n"):
                break
        if len(buf) > MAX_RESPONSE_BYTES:
            return None
        obj = json.loads(buf.decode() or "null")
    except (OSError, ValueError, asyncio.IncompleteReadError):
        return None
    finally:
        writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()
    return obj if isinstance(obj, dict) else None
```

### Task 0.3: registry, ask identity, TTL reconciliation

**Objective:** `Discovery.poll_once()` reconciles rows; `Discovery.snapshot()` returns public rows.

**Tests (each its own method):**
1. Two live hosts → two rows, sorted asks-first then `startedAt` descending.
2. `inputRequired` false→true mints `ask` with a fresh `requestId` and calls `on_ask` once with
   `(row, ask)`; a second true poll keeps the same `requestId` and does not call `on_ask` again.
3. true→false drops `ask`; a changed `generation` drops `ask` even while true.
4. Socket removed between polls → row gone immediately (ENOENT).
5. Server that accepts and never replies → row retained with `stale: True`; after `TTL_S` it is gone
   (inject a clock, do not sleep).
6. `ok:false`, non-JSON, and a snapshot containing `prompt`/`answer`/`options` keys → row not
   updated (retained stale), no exception escapes `poll_once`.
7. Directory with > `MAX_ENTRIES` files only reads the newest 32 by mtime; dotfiles are ignored.
8. A snapshot whose `title`/`sessionName` is 5000 chars is bounded to `MAX_TITLE`.

**Implementation shape** (names are the contract; bodies are the coder's job):

```python
@dataclass
class Host:
    entry: dict
    snapshot: dict
    last_ok: float | None      # monotonic; None until first success
    stale: bool

class Discovery:
    def __init__(self, directory: Path = COLLAB_DIR, *, clock=time.monotonic,
                 on_ask: Callable[[dict, dict], Awaitable[None]] | None = None) -> None
    async def poll_once(self) -> None
    def snapshot(self) -> list[dict]          # public rows, D6/D7/D8 applied
    async def start(self) -> None              # idempotent; loops poll_once every POLL_S
    async def stop(self) -> None
    async def link(self, instance_id: str, generation: int, access: str) -> dict
        # -> {"url": ...} or raises CollabError(code) with code in
        #    {"not_found","stale_generation","access_unavailable","unreachable"}

def get_discovery() -> Discovery
```

Public row shape (freeze this; both Wave 1 lanes code against it):

```json
{"kind": "external", "instanceId": "73aed45bd8edc973", "generation": 1, "pid": 704319,
 "sessionId": "01a1...", "title": null, "cwd": "/var/home/jason/projects/x",
 "model": {"provider": "openrouter", "id": "z-ai/glm-5.3-flash"}, "startedAt": 1793016309423,
 "participants": 1, "access": "view", "busy": false, "inputRequired": true,
 "ask": {"requestId": "ab12cd34ef56", "since": 1793016400000},
 "lastSeenAt": 1793016412000, "stale": false}
```

`link()` uses `D9`: connect, send, parse, never store. Map missing entry to `not_found`, a wire
error to `unreachable` unless the error is `stale_generation` / `access_unavailable`.

### Wave 0 gate

```
.venv/bin/python tests/test_collab.py          # all OK
for f in tests/test_*.py; do .venv/bin/python "$f"; done          # no regressions
PYTHONPATH=. .venv/bin/python tests/test_delete_saved.py          # still OK
```

---

### Wave 0 as landed (2026-10-26, verified by orchestrator)

`gateway/collab.py` + `tests/test_collab.py`, 20 tests, whole suite unchanged. Three corrections to
the pseudocode above, all now pinned by tests:

- **D6 needs `_query` to distinguish hard failures.** The task 0.2 sketch collapsed every `OSError`
  to `None`, which makes ENOENT indistinguishable from a timeout. `_query` re-raises
  `FileNotFoundError`/`ConnectionRefusedError`; the poller retires on those errno values and marks
  `stale=True` for everything else. `Discovery.link()` catches them and raises
  `CollabError("unreachable")`, so a dead endpoint is a 502 and never a 500.
- **Snapshot validation is type-strict, not presence-only.** `_public_row` casts `generation`, `pid`,
  `startedAt` and `participants`, so a host reporting `generation: "two"` would have raised out of
  `snapshot()` and 500'd `/api/sessions`. `_validate_snapshot` now rejects wrong types and the row
  stays stale.
- **A failed directory listing must not retire rows.** `iterdir`/`stat` failing is not evidence a
  host exited; `poll_once` returns without reconciling when listing fails (it used to treat that as
  "no hosts" and blank the registry), and warns once per distinct failure instead of every poll.

## Wave 1 — lanes in parallel

### Lane A: backend wiring

**Owned files:**
- Modify: `gateway/main.py`, `gateway/push.py`
- Create: `tests/test_collab_api.py`
- Modify: `docs/API.md`

Touching `gateway/bridge.py` is not allowed in this wave.

**A1. Startup/shutdown.** `main.py` has no lifespan. Add:

```python
@app.on_event("startup")
async def _start_collab() -> None:
    from . import push as push_mod
    d = collab.get_discovery()
    if push_mod.available():
        d.on_ask = push_mod.push_attention
    await d.start()

@app.on_event("shutdown")
async def _stop_collab() -> None:
    await collab.get_discovery().stop()
```

`start()` must swallow every exception per poll (log once per distinct failure class at WARNING, no
per-poll spam) so a broken discovery directory can never take the gateway down.

**A2. `/api/sessions`.** Keep the existing body and add one key:

```python
return {"live": live, "saved": saved, "external": collab.get_discovery().snapshot()}
```

**A3. Link endpoint.**

```python
@app.post("/api/collab/{instance_id}/link")
async def collab_link(instance_id: str, request: Request):
    body = await _json_body(request)          # reuse the existing helper style
    gen = body.get("generation"); access = body.get("access") or "view"
    # 422 on non-int gen or access not in {"view","control"}
    # CollabError -> 404 not_found / 409 stale_generation / 403 access_unavailable / 502 unreachable
    return JSONResponse({"url": url}, headers={"Cache-Control": "no-store"})
```

Validation lives in the handler, not a decorator (repo rule). The URL is never logged: log only
`instanceId`, `generation`, `access`, and the outcome code.

**A4. `push.py`.** Factor the subscription fan-out out of `push_dialog` into
`async def _fan_out(payload: dict) -> int` (identical pruning/logging behaviour, tests in
`tests/test_push.py` must stay green), then:

```python
async def push_attention(instance_id: str, label: str, request_id: str) -> int:
    payload = json.dumps({
        "title": "omp needs you",
        "body": f"{label} is waiting for input"[:280],
        "tag": f"omp-attention-{instance_id}-{request_id}",
        "url": "/",
    })
    return await _fan_out(payload)
```

The signature must accept `(row: dict, ask: dict)` when bound as `on_ask`; write a thin adapter in
`collab.py`'s contract-compatible call (`await self.on_ask(row, ask)`) and make `push_attention`
accept `(instance_id, label, request_id)` — bind it in main.py with `functools.partial` or a small
closure that pulls `title or basename(cwd)` from the row.

**A5. Tests** (`tests/test_collab_api.py`, unittest, no network): `push_attention` payload shape with
`_send_one` mocked, dead-subscription pruning via `_fan_out`, and a pure mapping test for the
CollabError → HTTP status table.

**A6. Docs.** `docs/API.md`: document the `external` array field-by-field, the link endpoint with its
status codes and `Cache-Control: no-store`, and a one-line note that rows appear only when the host
runs with `collab.autoStart` set.

### Lane B: web client

**Owned files:**
- Modify: `web/src/lib/api/types.ts`, `web/src/lib/api/endpoints.ts`,
  `web/src/lib/state/grouping.ts`, `web/src/lib/state/sessions.svelte.ts`,
  `web/src/components/Rail.svelte`
- Create: `web/src/components/ExternalRow.svelte`
- Create: `web/src/lib/state/__tests__/grouping-external.test.ts`
- Create: `web/src/components/__tests__/ExternalRow.test.ts`

No other file may change. Do not add dependencies.

**B1. Types.** `export interface ExternalSession { ... }` exactly as the frozen row shape above
(`kind: 'external'`), plus `external: ExternalSession[]` on `SessionsList` (optional in the type so an
older gateway still type-checks; the store defaults it to `[]`).

**B2. Endpoint.** `sessions.collabLink = (instanceId: string, generation: number, access: 'view' | 'control') =>
api<{ url: string }>(`/api/collab/${encodeURIComponent(instanceId)}/link`, { method: 'POST', body: { generation, access } })`.

**B3. Store.** `sessionsStore.external = $state<ExternalSession[]>([])`, set in `refresh()` from
`list.external ?? []`, cleared to `[]` on error like the other lists, and included in the idb cache
round-trip (guard the cached value with `Array.isArray`).

**B4. Grouping.** `groupSessions` gains a final parameter `external: readonly ExternalSession[] = []`
and returns `externalNeedsYou` (inputRequired, sorted by `ask.since` ascending, then `instanceId`) and
`externalRest` (not waiting, sorted `stale` last, then `startedAt` descending). `needsYou` itself is
untouched (D8).

**B5. Rail.** In the `needsYou` group, render `groups.needsYou` rows as today, then
`groups.externalNeedsYou` as `<ExternalRow>`. Add a group `{ key: 'elsewhere', label: 'Other
terminals' }` after `idle` rendering `groups.externalRest`. The empty-state condition includes the
two external arrays. `ExternalRow.svelte` props: `{ row: ExternalSession }`. It shows the `desk`
badge, `row.title ?? basename(row.cwd)`, model id, `pid`, relative start, a `needs input` chip when
waiting, and a dimmed `stale` marker. Menu actions: **Open in omp.sh** (calls `collabLink(id,
generation, 'view')` then `window.open(url, '_blank', 'noopener')`, and never renders the URL) and
**Copy path** (clipboard, with the existing toast/announcer path used elsewhere in the rail). Touch
targets >= 44px, real `<button>`s, accessible label including pid.

**B6. Tests.** `grouping-external.test.ts`: external asks sort oldest-first, non-asking rows sort
newest-first with stale last, empty input keeps the current groups byte-identical. `ExternalRow.test.ts`
via the existing mount helper: renders title fallback from cwd basename, shows the `needs input` chip,
and the link action calls `sessions.collabLink` exactly once with `access: 'view'` (mock the endpoint
module; no fetch).

### Wave 1 gate

```
.venv/bin/python tests/test_collab_api.py && .venv/bin/python tests/test_push.py
cd web && bun run check && bun run test && bun run build
```

---

## Wave 2 — integration (orchestrator)

- Extend `tests/e2e.py`: `/api/sessions` body includes an `external` array (may be empty);
  `POST /api/collab/nonexistent/link` → 404; response carries `Cache-Control: no-store` on a
  successful broker call when a fake host is present.
- Scratch instance on port 9327 (never 9315), `.venv/bin/python tests/e2e.py http://127.0.0.1:9327`.
- Blind review gate per repo convention, fixes, then commit. Production (`ohmpi-gateway.service`,
  `cloudflared-ohmypi.service`) is untouched; `collab.autoStart` stays `off` so the feature ships
  inert.

## Hard rules for every lane

- Read `CLAUDE.md` first. Do not commit, push, or change branches; do not restart or edit any systemd
  unit; do not touch a live session you did not create; test on your own port.
- Runtime code may read `~/.omp/run/collab-hosts` (that is the feature). Agents must not cat
  `auth-token`, `gateway.env`, or anything else under `~/.omp/`; tests use temp directories only.
- Do not weaken, skip, or delete a test to make a gate pass.
