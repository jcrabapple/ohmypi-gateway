# ohmypi-gateway client API

The contract for anything that talks to the gateway: the bundled web dashboard,
a desktop shell, a mobile app, scripts. Everything the dashboard does goes
through this API, so a client built on it has full parity.

Machine-readable schema: `GET /api/openapi.json` (interactive at `/api/docs`).
The session protocol underneath is omp's RPC mode; its events and commands pass
through untouched, so [omp's docs/rpc.md](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md)
is the reference for event payloads.

## Connecting

Point clients at the gateway's base URL (the HTTPS tunnel hostname, or
`http://127.0.0.1:9315` on the host itself). Bootstrap with the one public
endpoint that describes the server:

```
GET /.well-known/ompgw.json
{"name":"ohmypi-gateway","version":"0.3.0","apiBase":"/api",
 "websocket":"/omp-ws/{sessionId}","auth":{...},"openapi":"/api/openapi.json"}
```

`GET /healthz` is also public and returns `{"ok":true}`; use it for reachability
checks. The web client files (below) are public too. Nothing else is reachable
without credentials.

## Web client files (public)

| Path | Serves |
|---|---|
| `/` | `web/dist/index.html` (`Cache-Control: no-cache`) when that file exists; otherwise the classic dashboard |
| `/classic` | the classic Alpine dashboard (`static/index.html`), always. `/static/*` is its assets |
| `/assets/*` | `web/dist/assets/*`, hashed filenames, `Cache-Control: public, max-age=31536000, immutable` |
| `/<name>` | a file sitting directly in `web/dist` (`sw.js`, `manifest.webmanifest`, `favicon.svg`, `icon-*.png`, ...). `sw.js` is `no-store` (with `CDN-Cache-Control` and `Cloudflare-CDN-Cache-Control: no-store`, since Cloudflare edge-caches `.js` otherwise) and is a single file with its routing inlined; the manifest is `no-cache`; other root files `public, max-age=3600`. `index.html` is not served at `/index.html`. Subdirectories, dotfiles and symlinks that leave `web/dist` are never served |

`/manifest.webmanifest` falls back to a small generated JSON manifest when
`web/dist/manifest.webmanifest` doesn't exist. Point the gateway at a build
elsewhere with `OMPGW_WEB_DIST` (default `<repo>/web/dist`); it is checked per
request, so a fresh build is picked up without a restart. Unknown paths outside
the API get 401 without credentials and 404 with them.

**CSP.** Every response carries `script-src 'self'` (no `unsafe-eval`), plus
`style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:`,
`connect-src 'self'`, `worker-src 'self'`, `manifest-src 'self'`. Only
`/classic` and `/static/*` (Alpine) add `'unsafe-eval'`, and so does `/` while
there is no web build.

## Auth

There is one secret: the gateway token (`auth-token` in the project directory,
256 bits, generated on first start). A token holder can run a coding agent on
the host. Treat it like an SSH key.

| Client | How |
|---|---|
| Native (desktop, mobile, CLI) | `Authorization: Bearer <token>` on every request. Store the token in the OS keychain/keystore. |
| Web dashboard (same origin) | `POST /auth/login {"token": "..."}` sets an HttpOnly, SameSite=Strict session cookie (30 days); `Secure` is added when the request is HTTPS (detected via `X-Forwarded-Proto` from the loopback tunnel or the request scheme). `POST /auth/logout` clears it. |
| Browser app on another origin | Bearer header over CORS (`Access-Control-Allow-Origin: *`, no credentials). WebSocket: first-message auth (below). |

Rules that matter for client authors:

- **Tokens never go in URLs.** `?token=` is rejected: URLs end up in proxy and
  browser logs.
- **Cookie requests need a same-origin `Origin` header on writes**
  (POST/PUT/DELETE). Browsers send it automatically. Bearer requests are
  exempt, since a cross-site page can't attach your bearer header.
- **Lockout:** 10 failed auth attempts from one IP inside 15 minutes locks that
  IP out for 15 minutes (HTTP 429, WebSocket close 4429), even with a valid
  token. Only wrong credentials count; a request that has none does not. Don't
  retry-loop on 401: send the user to re-enter the token.
- `GET /api/me` → `{"method":"bearer"|"cookie"}`; cheap "am I signed in" check.

## REST surface

All under `/api`, JSON in/out, errors as `{"error": "..."}` (query and body
validation failures included, HTTP 422).

### Host and configuration

| Method | Path | |
|---|---|---|
| GET | `/health` | gateway + omp liveness, live session count |
| GET | `/system` | omp version/path, host, gateway limits |
| GET | `/config` | `{raw, parsed, file}` of `~/.omp/agent/config.yml` (`file` is the config path; `parsed` is `null` with a `parseError` string when the YAML does not parse) |
| PUT | `/config` | body = full YAML (`Content-Type: text/yaml`). Validated by omp; auto-reverted if omp rejects it |
| GET | `/config/model-roles` | `{roles, fallbacks}`: the `modelRoles` and `retry.fallbackChains` blocks of config.yml as plain objects. `roles[role]` is a selector string like `openrouter/z-ai/glm-5.3-flash:max` (comma-separated when a role lists several candidates); `fallbacks[role]` is the ordered list of fallback selectors. Custom roles appear next to omp's built-ins; a file that does not parse is 409 here |
| PUT | `/config/model-roles` | partial per-role update: `{roles: {role: selector\|null}, fallbacks: {role: [selector]\|null}}`. Each key present replaces that role's value (or its fallback chain); `null` unsets it; keys left out keep their value. The edit is a ruamel round-trip, so comments and formatting elsewhere in config.yml survive; one documented edge: a comment that trails a block is stored on the block's last node, so removing the last entry of a block loses that trailing comment. Selector charset is validated here (422), model resolution is omp's at runtime; the write is re-validated with `omp config get` and reverted on rejection (400). Role names are lowercase letters, digits, `-`, `_`. Running sessions keep their old settings until restarted |
| GET | `/models?q=` | `omp models` catalog as text (`{raw}`) |
| GET | `/catalog/models?refresh=` | `{"models": [...]}`, exactly what `omp models --json` emits (`provider`, `id`, `selector`, `name`, `contextWindow`, `maxTokens`, `reasoning`, `thinking` (`string[]` or `null`), `input`, `cost`). Cached in memory for 10 minutes; `refresh=1` bypasses the cache. First call can take up to about a minute. Use this, not the session's `/models` |
| GET | `/skills` | installed skills with metadata |
| GET | `/plugins` | installed plugins as JSON: `{installed, npm, marketplace, raw}` from `omp plugin list --json` (`raw` is the CLI text; an omp build without `--json` returns `installed: []` plus an `error` string) |
| POST | `/plugins/action` | `{action, target}`: `action` is `install` \| `uninstall` \| `enable` \| `disable` \| `doctor` (anything else 422). `target` is required for every action except `doctor`, and whenever it is present it must match `^[A-Za-z0-9@][A-Za-z0-9@._/+-]{0,159}$` (422 otherwise, so a leading dash can never become a flag and never reaches a shell; `doctor` with a flag-shaped target is 422 too). Runs `omp plugin <action> <target>` with a 600 s budget and returns `{ok, action, target, output}`; a CLI failure is `ok: false` with the CLI's message in `output` and `error`, still HTTP 200 |
| GET | `/agents` | subagent definitions |
| GET | `/usage` | `omp usage` report |
| GET | `/stats` | `omp stats` report |

### Memory

The assistant's knowledge store on the gateway host. Notes are markdown files
under `~/.omp/agent/memory/notes` (archived ones under `archive/`); `graph.db`
is a rebuildable SQLite/FTS5 index of notes, skills and tags, and
`oscar-memory index` rebuilds it from the markdown tree. Note ids are the
frontmatter `id:` value (for example
`note-20260928-oscar-telegram-bridge-architecture`); a leading `note:` is
accepted on input and stripped. Skills and tags appear in edges as
`skill:<name>` / `tag:<name>`.

Writes touch the markdown file and then re-run the index. If the index CLI is
not on the host (`OMPGW_OSCAR_MEMORY`, `PATH`, else `~/.local/bin/oscar-memory`)
the note is still saved and the response says the index was skipped. Override
the store root with `OMPGW_MEMORY_DIR`.

Reads are read-only SQLite: this API never writes `graph.db` and never writes
mnemopi. `GET /memory/recall` is a substring scan over mnemopi working memory
across the shared store and every project bank (`OMPGW_MNEMOPI_DIR`), newest
first; it is browsing, not semantic recall, because the gateway has no
embedding model.

| Method | Path | |
|---|---|---|
| GET | `/memory` | `{counts: {note, skill, tag, edges}, hot: [{id, title}], root, hasHotFile}`. A missing index reports zero counts instead of failing |
| GET | `/memory/notes?q=&limit=` | FTS5 ranked search over NOTES only (skills and tags are indexed too but are not openable notes) (`limit` 1..100, default 20), hot tier first: `{query, notes: [{id, title, kind, tier, snippet}]}`. An empty `q` lists the most recently indexed notes. Raw FTS syntax is stripped; a query it cannot parse falls back to a title/body scan instead of erroring |
| GET | `/memory/notes/{id}` | the note: `{id, title, tags, links, body, path, tier, archived, outgoing: [{id, kind}], incoming: [{id, kind}]}`. Unknown 404, a malformed id 422 |
| POST | `/memory/notes` | `{id?, title, tags?, links?, body}` creates (no `id`) or updates. Title required (422); line breaks are 422, and so are commas or `---` in tags and links (the store's frontmatter is line-based and `oscar-memory` splits it on `---`, so a fence inside a field would desync the note from the index); body over 200 kB 413; unknown `id` 404. `-> {id, created, path, index: {indexed, reason?, output?}, note}` where `note` is the re-read note when the index rebuilt |
| POST | `/memory/notes/{id}/archive` | move the note to `archive/` and reindex: `{ok, path?, index, already?}` |
| GET | `/memory/recall?q=&limit=` | `{query, rows: [{id, bank, content, source, importance, scope, timestamp}], scanned, banks}`. `bank` is the project bank name, or `shared` for the cross-project store. `limit` 1..50 |

### Usage ledger

One append-only SQLite row per completed agent turn, written by the bridge at
`prompt_result` (which carries the turn's final status, so an aborted or
failed turn is a row with `ok: false`), summed across the turn's assistant
messages. If `prompt_result` never arrives, `agent_end` arms a 30-second grace
timer that writes the row as a fallback; a child that exits inside that window
flushes the pending row at exit (a turn where no assistant message ever arrived
writes nothing).
The database lives at `~/.omp/ompgw-ledger.db` (override with
`OMPGW_LEDGER_DB`), WAL mode, schema-migrated stepwise via `PRAGMA
user_version` (currently version 1); a database from a newer gateway disables
the sink and the read routes instead of touching it. Only session name, cwd,
provider and model are stored per turn.

| Method | Path | |
|---|---|---|
| GET | `/ledger?days=&model=&provider=` | aggregates over the last `days` local calendar days (1..365, default 30); `model` accepts the bare model name or `provider/model`, `provider` is exact: `{days, totals: {turns, turnsOk, input, output, cacheRead, cacheWrite, cost}, perDay: [{date, input, output, cost}], perModel: [{provider, model, turns, input, output, cacheRead, cost}]}`. `perDay` is always exactly `days` entries, keyed by ISO date in the gateway's timezone, zero-filled, oldest first, so chart bars sum to the totals. Costs are raw sums of per-turn USD floats; clients round for display |
| GET | `/ledger/sessions?days=` | per-session rollup (grouped by session name + cwd), newest activity first: `{days, sessions: [{sessionName, cwd, turns, input, output, cacheRead, cost, lastTs}]}` |

### Web push ("needs you", and turns that end)

When a blocking dialog (tool approval, question) becomes pending, or a turn
ends, on a session that NO WebSocket client is watching, the gateway pushes
every registered device. One push per dialog; one per session for a turn end
(a later turn replaces the earlier notification instead of stacking). A
deliberate abort never pushes, and a queued follow-up defers the push until
the last turn in the queue ends.

Which kinds push is a per-gateway policy stored at `push-prefs.json` (created
0600, atomically; read-only to the browser through the API): `completion` (a
turn that ended on its own, on by default), `error` (a turn whose status was a
failure, off by default; the body carries omp's `errorMessage`), and `ask`
(dialogs and external sessions waiting for input, on by default).

Pushes require the `pywebpush` package in the venv: without it `GET
/push/vapid` and `POST /push/subscribe` answer 503 (`POST /push/unsubscribe`
still works - it only edits the local store) and the rest of the gateway is
unaffected. VAPID keys are generated on first use and stored at
`push-vapid.json` (created 0600, atomically) next to `auth-token`; device
subscriptions at `push-subs.json` (also 0600). `keys.p256dh` must be a 65-byte
uncompressed P-256 point and `keys.auth` a 16-32 byte secret, both base64url -
malformed keys are 422, never stored. Endpoints that answer 404/410 are pruned
on the next send. The notification payload carries `kind` (`ask`,
`completion` or `error`) so the service worker keeps a dialog pinned on screen
while letting a turn-end notification go, plus `gwId`, `title`, `body`, `tag`
and a `url` that deep-links to `/#/s/{gwId}`. iOS only delivers web push to
the installed PWA.

| Method | Path | |
|---|---|---|
| GET | `/push/vapid` | `{publicKey}`: base64url uncompressed P-256 point, passed as `applicationServerKey` to `pushManager.subscribe({userVisibleOnly: true})` |
| POST | `/push/subscribe` | register a device: `{endpoint, keys: {p256dh, auth}}` (the browser PushSubscription, as JSON). Idempotent per endpoint; `-> {ok, subscriptions}`. Non-https endpoint or missing keys 422 |
| POST | `/push/unsubscribe` | remove a device: `{endpoint}`; `-> {ok, subscriptions}` |
| GET | `/push/prefs` | `{prefs: {completion, error, ask}}`, each a boolean |
| PUT | `/push/prefs` | partial update: any of `completion`, `error`, `ask` as booleans; omitted kinds keep their value; `-> {prefs}`. Unknown kind or non-boolean 422 |

### Cross-session search

`GET /api/search?q=&limit=&role=&refresh=` — full-text search over saved AND
archived session transcripts (live dir plus omp's gc archive, including
gzipped `.jsonl.gz` files; user/assistant text blocks only, thinking and tool
output are not indexed). The FTS5 index lives at `search-index.db` next to
`auth-token` (override: `OMPGW_SEARCH_DB`; roots: `OMPGW_SESSIONS_DIR` and
`OMPGW_ARCHIVE_DIR`). It refreshes incrementally on request, at most once per
30 seconds (`refresh=1` forces), and prunes deleted transcripts automatically.

Archived hits carry `"archived": true` and are resumable: resuming one restores
a decompressed copy into the live sessions dir (`restored/`) and opens that.

Every query word is a prefix match; raw FTS5 syntax from the client is
stripped, so it can neither error the query nor widen it. Results are ranked
by relevance. Snippet matches are wrapped in private-use-area delimiters
(U+E000 / U+E001) that cannot collide with transcript content: escape the
snippet as plain text, then map the sentinels to `<mark>` elements.

| Method | Path | |
|---|---|---|
| GET | `/search` | `{q}` (required): `{total, results: [{path, line, role, ts, snippet, sessionId, cwd, title, gwId?}], indexed: {files, messages}}`. `gwId` is present when that transcript is currently live. `limit` 1..200 (default 40); `role` `user\|assistant`. `q` missing 422, bad `role` 422, an unsearchable `q` (no word characters) is 200 with 0 results |

### Sessions

A *live* session is a running omp child owned by the gateway. A *saved*
session is a transcript on disk that can be resumed.

| Method | Path | |
|---|---|---|
| GET | `/sessions?limit=&include_saved=` | `{live: [...], saved: [...], external: [...]}` (`external` below) |
| POST | `/sessions` | start: `{cwd?, model?, thinking?, approvalMode?, resumeFrom?, advisor?}`. `approvalMode` is `yolo` (default) \| `write` \| `always-ask`. `resumeFrom` must be a file under `~/.omp/agent/sessions` (see Resuming below). `advisor` (default false) launches the child with `--advisor` (omp's advisor runtime); launch-time only — no mid-session toggle, carried through forks |
| GET | `/sessions/{id}` | session info (below) |
| DELETE | `/sessions/{id}` | stop the child; transcript stays on disk |
| POST | `/sessions/{id}/prompt` | `{message, images?, mode?, wait?, timeout?}`. `images` is up to 4 of `{"type":"image","data":"<base64>","mimeType":"image/png"|"image/jpeg"|"image/webp"|"image/gif"}` (max 5 MB decoded each; raw base64 only, no `data:` prefix) and is forwarded to omp on every mode. Bad type, mime, base64, size, or file signature (magic bytes are checked against the claimed mime type) is 422. `message` is required and must be a string even when images carry the whole content (send `""`). `mode`: `prompt` \| `steer` (inject into the running turn) \| `follow_up` (queue for after it). Returns immediately with the ack; follow progress on the WebSocket. `wait:true` blocks until the turn ends and adds `lastAssistantText` (see note) |
| GET | `/sessions/{id}/queue` | the gateway-held follow-up queue: `{queue: [{id, message, ts, images}]}` (images is a count) |
| PATCH | `/sessions/{id}/queue/{qid}` | edit a queued follow-up before it fires: `{message?, images?}`; 404 when it already fired or was cancelled, 422 on a blank message |
| DELETE | `/sessions/{id}/queue/{qid}` | cancel a queued follow-up; 404 when it already fired or was cancelled |
| DELETE | `/sessions/saved?file=` | delete a saved transcript file. `file` must resolve under the live sessions dir or the gc archive; a transcript a live session is writing is 409. Search prunes it on the next refresh |
| POST | `/sessions/vacuum` | sweep storage litter: bucket dirs with no transcripts under them, and custom-session-files pointers whose target is gone. `-> {removedDirs, removedPointers}`. Never touches transcripts |
| POST | `/sessions/{id}/abort` | stop the current turn |
| POST | `/sessions/{id}/retry` | re-run the last failed turn (omp `abort_retry`). An omp-level error (nothing to retry, unknown command on older omp) is 400 like every command route |
| POST | `/sessions/{id}/compact` | `{instructions?}` |
| GET | `/sessions/{id}/state` | omp state, minus the system prompt and tool dumps |
| GET | `/sessions/{id}/messages` | full transcript (omp message objects) |
| GET | `/sessions/{id}/entries` | session-file message entries via omp `get_entries`: `{entries: [{entryId, role, timestamp}]}`. The `entryId`s are the fork targets; only `role: "user"` rows branch |
| POST | `/sessions/{id}/fork` | branch at a user entry (omp `branch`): `{entryId}`. Unknown session 404; `entryId` missing/not a string, unknown, or not a user message entry 422; a busy session (turn running or compacting) 409; omp command errors 400. Forks are serialized per session: a second concurrent fork waits, then sees the session stopped (404). A fork replaces its own parent (stop + register), so it is net-zero: it is allowed at the session cap, and 429s only when it would push the count past the cap. On success omp rewrites its live process into a new branched session file (the fork carries the history strictly BEFORE the entry; forking at the first user entry produces an empty session linked to the old file), so the gateway registers that branched session under a new gw id exactly like POST /sessions and stops the old child: returns `{gwId, forkedFrom, text}` where `text` is the forked message for a composer prefill. The old transcript stays on disk as a saved session. If registering the branched child fails after the parent was stopped, the parent is restored from disk as a new session and the route answers 500 naming the restored `gwId` in the detail |
| GET | `/sessions/{id}/files?prefix=` | index-only listing of ONE directory of the session cwd, for @-file mentions: `{entries: [{name, path, isDir, size}]}`. Names and sizes only; file contents are never served. Dotfiles excluded, dirs before files, at most 200 entries. `prefix=""` lists the cwd; an absolute prefix or any `..` segment is 422, a path whose real location is outside the session cwd (e.g. an escaping symlink) is 403, an unknown path is 404, unknown session 404 |
| GET | `/sessions/{id}/file?path=` | download ONE file from the session cwd. `path` is relative; an absolute path or any `..` segment is 422, a real location outside the cwd (including an escaping symlink) is 403, and a directory is 415. Hidden files and hidden folders are refused (403) after the containment check and BEFORE the existence check, so `.git/...`, `.ssh/...`, `.env` and the gateway's own `auth-token` / `gateway.env` / `push-*.json` / `search-index.db` are never served and their existence is not revealed; a missing file is 404; secret names match case-insensitively. Served as an attachment with `Cache-Control: private, no-store`; HTML/SVG/JS and other active types are sent as `application/octet-stream` so the gateway origin can never serve a page. Ranges and ETags come from the framework |
| POST | `/sessions/{id}/upload?name=&dir=&overwrite=` | put ONE file into the session cwd (`dir` selects a subfolder; default the cwd). The body is the raw bytes, not multipart; `name` is the leaf filename (a leading dot is 422, path components are stripped). At most 32 MiB (`OMPGW_MAX_UPLOAD_BYTES`), enforced while streaming so a chunked body without `Content-Length` cannot buffer past the cap, 413 above it; an existing file is 409 unless `overwrite=true`; a `dir` that escapes the cwd is 422, a hidden `dir` (`.git`, `.ssh`) is 403, a missing one 404; an existing file at the name without `overwrite=true` is 409, and an existing symlink at the name is 403 (the write uses O_NOFOLLOW, so a name cannot be redirected). `-> {name, path, size}` |
| GET | `/sessions/{id}/subagents` | subagent registry snapshot from omp `get_subagents` (`{"subagents": [...]}`; empty until omp spawns one). The gateway subscribes every live session at `progress` level after v2 negotiation, so `subagent_progress` / `subagent_lifecycle` events flow on the WebSocket |
| GET | `/sessions/{id}/subagents/{sid}/messages?from=` | one subagent's transcript via omp `get_subagent_messages` (`subagentId`, `fromByte`): `{messages, nextByte, reset, sessionFile}`. Page forward with `from=<nextByte>` while `nextByte` is present. Unknown `sid` is an omp command error → 400 |
| GET | `/sessions/{id}/stats` | token/cost stats |
| POST | `/sessions/{id}/model` | `{provider, modelId}` (both required; values from `/catalog/models`) |
| POST | `/sessions/{id}/thinking` | `{level}`: off, minimal, low, medium, high, xhigh, max, auto |
| POST | `/sessions/{id}/name` | `{name}` |
| GET | `/sessions/{id}/models` | models available to this session (RPC `get_available_models`; takes minutes, prefer `/catalog/models`) |
| GET | `/sessions/{id}/commands` | slash commands available |
| GET | `/sessions/{id}/events?after=` | `{events, lastSeq, gap}`: event backlog since a cursor (polling fallback). `gap` is true when `after > 0` and events after it were dropped from the backlog; refetch state and messages instead of trusting the delta |
| GET | `/sessions/{id}/ui` | dialogs omp is blocked on (see Approvals) |
| POST | `/sessions/{id}/ui/{requestId}` | answer one |
| POST | `/sessions/{id}/rpc` | escape hatch: `{type, ...}` = any omp RpcCommand, returned as `{data}` |

**`wait:true` through the tunnel:** Cloudflare aborts any response that hasn't
started within 100 seconds, so remote clients must use the default
(`wait:false`) plus the WebSocket for anything but short turns. `wait` is for
scripts on the host and quick one-liners.
The `rpc` passthrough means a client never waits on a gateway release to use a
new omp command.

**Paths are canonical.** Every session file path the gateway emits (`file` in
saved entries, `ompSessionFile`, `resumedFrom`) is fully resolved (symlinks
followed, e.g. `/var/home/...` where `/home` is a symlink), the same form omp
reports. Compare them as given; no client-side munging. `resumeFrom` accepts
either form.

**Saved entries** are `{file, mtime, sizeBytes, cwdFolder, cwd, cwdExists, title, running}`.
`title` is omp's stored session title when the session was named (the line-1
`{"type":"title"}` record, or the last `title_change` in older transcripts),
otherwise the first user prompt, otherwise `""` (120 chars max here, 90 in
search results). Search uses the same title rule. Only top-level transcripts
are listed or searched (`sessions/<folder>/<file>.jsonl`, same depth under the
archive root); subagent transcripts omp nests under a folder named after their
parent are not sessions and are skipped.
`cwd` is the working directory recorded in the transcript (`null` when the file
has none); prefer it over the mangled `cwdFolder` for display. `cwdExists` is
whether that directory still exists on the gateway host (`null` when `cwd` is
`null`); clients should not offer a folder with `cwdExists: false` as a
one-tap pick, and should treat a missing key (older gateways) as unknown.
`running` is true when a live session has that file open.

### External collab sessions

`GET /sessions` also returns `external`: a read-only snapshot of interactive
omp sessions on this host that publish themselves for collab (a host appears
only when omp runs with `collab.autoStart` set to `view` or `control`). Rows
with an open input request come first (oldest request first), then the
remaining rows newest `startedAt` first.

| Field | |
|---|---|
| `kind` | always `"external"` |
| `instanceId` | the host's instance id; the path key for the link endpoint |
| `generation` | the host's current collab generation (>= 1); send it back on link, and re-read it after any restart of the host |
| `pid` | host process id on the gateway machine |
| `sessionId` | omp session id, or `null` |
| `title` | session name, trimmed to 120 chars, or `null` |
| `cwd` | host working directory |
| `model` | `{provider, id}` or `null` |
| `startedAt` | epoch milliseconds, host-reported |
| `participants` | participant count |
| `access` | the highest access the host currently offers: `view` or `control` |
| `busy` | host-reported, or `null` when unknown |
| `inputRequired` | true when the host is blocked waiting for input |
| `ask` | `{requestId, since}` when `inputRequired` just turned true (`since` is epoch ms); `null` otherwise. One mint per false->true edge |
| `lastSeenAt` | epoch ms of the gateway's last successful poll of this host |
| `stale` | true when the last poll failed; the row keeps its last known values until it expires |

| Method | Path | |
|---|---|---|
| GET | `/collab` | `{hosts: [...], stats: {...}}`: the same rows as `external`, plus process-lifetime discovery counters for judging a rollout: `polls`, `pollErrors`, `queries`, `queryFailures {noReply, gone, osError}`, `hostsSeenMax`, `asksMinted`, `pushesSent` (devices reached), `lastPollMs`. In memory only, reset by a gateway restart, never persisted |
| POST | `/collab/{instanceId}/link` | body `{generation, access?}` (`access` defaults to `view`, must be `view` or `control`; `generation` must be the integer the row shows, `>= 1`). Returns a one-shot capability URL for the host: `{url}` with `Cache-Control: no-store`. Open it, don't store it: the capability is minted per tap, never persisted or cached by the gateway. Errors: unknown instance 404, host moved to a newer generation 409, that access is not offered 403, host unreachable 502; bad body 422 |

**Resuming.** `POST /sessions {resumeFrom}`:

- With no `cwd`, the session starts in the folder recorded in the transcript. If
  that folder no longer exists (or none is recorded) it starts in the default
  `~/projects` and the response carries `"cwdFallback": true`. An explicit `cwd`
  always wins.
- If a live session already has that file open, no second process is started:
  the response is that session's info with HTTP 200 and `"alreadyLive": true`.

Session info fields: `gwId`, `cwd`, `approvalMode`, `resumedFrom`, `ompSessionId`,
`ompSessionFile`, `ompSessionName`, `model`, `thinkingLevel`, `advisor` (bool), `isStreaming`,
`idleSec`, `exited`, `exitCode` (null until exit), `protocolVersion`, `uptimeSec`,
`subscribers` (live WS count), `messageCount`, `contextUsage`,
`lastEventSeq`, `pendingUi`.

## WebSocket: `/omp-ws/{id}?after=<seq>`

One socket per open session. Every server frame is:

```json
{"seq": 42, "event": {"type": "message_update", ...}}
```

- `seq > 0`: an omp event, numbered per session, strictly increasing. Persist
  the highest one you have processed.
- `seq == 0`: a gateway control frame: `auth_ok` (carries session info and
  `gap`, see below),
  `heartbeat` (every 25s idle), `pong`, `rpc_response`, `ws_error`.

**Auth**, first match wins: bearer header on the upgrade (native clients); the
session cookie with a same-origin `Origin` (dashboard); otherwise send
`{"type":"auth","token":"..."}` as the first message within 10s (browser apps
on other origins, since browsers can't set headers on WebSocket upgrades).

**Resuming without gaps or duplicates.** Connect with `?after=<last seq you
processed>`. The gateway replays the backlog after that cursor, then streams
live, and never sends the same seq twice on one socket. The intended open
sequence for a transcript view:

1. `GET /sessions/{id}` → note `lastEventSeq`
2. `GET /sessions/{id}/messages` → render history
3. open the socket with `?after=<lastEventSeq>`

`auth_ok.gap` is `true` when `after > 0` and the backlog no longer reaches back
to `after + 1`: events were dropped, so the replay has a hole. Refetch state and
messages instead of trusting the delta. It is `false` for `after=0`, since a
fresh client loads history over REST anyway.

On reconnect, reuse your latest cursor. Mobile clients should close the socket
when backgrounded and reconnect with the cursor on resume; nothing is lost
while the session's backlog holds (the last 3000 events).

**Close codes:** `4401` bad/missing auth (re-prompt, don't retry), `4404`
session not running, `4408` dropped as a slow consumer (reconnect with your
cursor), `4429` IP locked out.

**Client → server frames:** `"ping"`; any omp RpcCommand as JSON, e.g.
`{"id":"c1","type":"get_state"}`, answered with an `rpc_response` control frame
echoing your `id`; `extension_ui_response` to answer a dialog. Parameter keys
must be identifiers and must not be `timeout` or `late_errors` (those are
gateway call semantics): a bad key is answered with a failing `rpc_response`,
not a dropped socket. `host_tool_result` / `host_tool_update` / `host_uri_result`
frames are passed through to omp untouched (host tool bridges).

Events worth handling for a chat view: `agent_start`/`agent_end` (busy state),
`message_start`/`message_update`/`message_end` (streaming text; `message.content`
blocks of `text`, `thinking`, `toolCall`), `tool_execution_start`/`_update`/`_end`,
`auto_compaction_start`/`_end`, `extension_ui_request`, `ui_resolved`. Ignore
types you don't know; omp adds them.

## Approvals and questions

In `write` and `always-ask` sessions omp stops before gated tool calls and
waits for a human. Those waits (plus ask-tool questions and extension prompts)
arrive as `extension_ui_request` events with a dialog method:

```json
{"type":"extension_ui_request","id":"1592623d6aadd677","method":"select",
 "title":"Allow tool: bash\nCommand: echo hi","options":["Approve","Deny"]}
```

| method | answer with |
|---|---|
| `select` | `{"value": "<one of options>"}` (tool approvals: `Approve` / `Deny`) |
| `confirm` | `{"confirmed": true\|false}` |
| `input`, `editor` | `{"value": "<text>"}` |
| any | `{"cancelled": true}` |

Answer over REST (`POST /sessions/{id}/ui/{requestId}`) or on the socket
(`{"type":"extension_ui_response","id":"...","value":"Approve"}`).

Every connected client sees the request. **First answer wins**; later answers
get 409 (REST) or a `ws_error` frame. Everyone then receives
`{"type":"ui_resolved","id":"..."}`: drop the prompt when it arrives. Open
dialogs are also listed in session info as `pendingUi`, so a client that
connects mid-wait (say, a phone opened from a notification) can render them
immediately. A turn that ends while a dialog is open resolves it with
`reason: "turn ended"`.

Other `extension_ui_request` methods (`notify`, `setStatus`, `setWidget`,
`setTitle`) are fire-and-forget: display them or ignore them.

## Limits

- `OMPGW_MAX_SESSIONS` live sessions (default 8); `POST /sessions` returns 429
  beyond that.
- Sessions idle longer than `OMPGW_IDLE_REAP_SEC` (default 6h) are stopped.
  Their transcripts stay resumable.
- Set these in `gateway.env` next to the service (gitignored).
- `OMPGW_WEB_DIST`: directory of the built web client (default `web/dist` in the
  repo).
- Prompt images: 4 per prompt, 5 MB decoded each.
