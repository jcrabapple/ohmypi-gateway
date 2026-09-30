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
| Web dashboard (same origin) | `POST /auth/login {"token": "..."}` sets an HttpOnly, Secure, SameSite=Strict session cookie (30 days). `POST /auth/logout` clears it. |
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
| GET | `/config` | `{raw, parsed, path}` of `~/.omp/agent/config.yml` |
| PUT | `/config` | body = full YAML (`Content-Type: text/yaml`). Validated by omp; auto-reverted if omp rejects it |
| GET | `/models?q=` | `omp models` catalog as text (`{raw}`) |
| GET | `/catalog/models?refresh=` | `{"models": [...]}`, exactly what `omp models --json` emits (`provider`, `id`, `selector`, `name`, `contextWindow`, `maxTokens`, `reasoning`, `thinking` (`string[]` or `null`), `input`, `cost`). Cached in memory for 10 minutes; `refresh=1` bypasses the cache. First call can take up to about a minute. Use this, not the session's `/models` |
| GET | `/skills` | installed skills with metadata |
| GET | `/plugins` | installed plugins |
| GET | `/agents` | subagent definitions |
| GET | `/usage` | `omp usage` report |
| GET | `/stats` | `omp stats` report |

### Usage ledger

One append-only SQLite row per completed agent turn, written by the bridge at
`prompt_result` (which carries the turn's final status, so an aborted or
failed turn is a row with `ok: false`), summed across the turn's assistant
messages. `agent_end` is the fallback write if `prompt_result` never arrives.
The database lives at `~/.omp/ompgw-ledger.db` (override with
`OMPGW_LEDGER_DB`), WAL mode, schema-migrated stepwise via `PRAGMA
user_version` (currently version 1); a database from a newer gateway disables
the sink and the read routes instead of touching it. Only session name, cwd,
provider and model are stored per turn.

| Method | Path | |
|---|---|---|
| GET | `/ledger?days=&model=&provider=` | aggregates over the last `days` local calendar days (1..365, default 30); `model` accepts the bare model name or `provider/model`, `provider` is exact: `{days, totals: {turns, turnsOk, input, output, cacheRead, cacheWrite, cost}, perDay: [{date, input, output, cost}], perModel: [{provider, model, turns, input, output, cacheRead, cost}]}`. `perDay` is always exactly `days` entries, keyed by ISO date in the gateway's timezone, zero-filled, oldest first, so chart bars sum to the totals. Costs are raw sums of per-turn USD floats; clients round for display |
| GET | `/ledger/sessions?days=` | per-session rollup (grouped by session name + cwd), newest activity first: `{days, sessions: [{sessionName, cwd, turns, input, output, cacheRead, cost, lastTs}]}` |

### Sessions

A *live* session is a running omp child owned by the gateway. A *saved*
session is a transcript on disk that can be resumed.

| Method | Path | |
|---|---|---|
| GET | `/sessions?limit=&include_saved=` | `{live: [...], saved: [...]}` |
| POST | `/sessions` | start: `{cwd?, model?, thinking?, approvalMode?, resumeFrom?, advisor?}`. `approvalMode` is `yolo` (default) \| `write` \| `always-ask`. `resumeFrom` must be a file under `~/.omp/agent/sessions` (see Resuming below). `advisor` (default false) launches the child with `--advisor` (omp's advisor runtime); launch-time only — no mid-session toggle, carried through forks |
| GET | `/sessions/{id}` | session info (below) |
| DELETE | `/sessions/{id}` | stop the child; transcript stays on disk |
| POST | `/sessions/{id}/prompt` | `{message, images?, mode?, wait?, timeout?}`. `images` is up to 4 of `{"type":"image","data":"<base64>","mimeType":"image/png"|"image/jpeg"|"image/webp"|"image/gif"}` (max 5 MB decoded each; raw base64 only, no `data:` prefix) and is forwarded to omp on every mode. Bad type, mime, base64, size, or file signature (magic bytes are checked against the claimed mime type) is 422. `message` may be empty when images are present. `mode`: `prompt` \| `steer` (inject into the running turn) \| `follow_up` (queue for after it). Returns immediately with the ack; follow progress on the WebSocket. `wait:true` blocks until the turn ends and adds `lastAssistantText` (see note) |
| POST | `/sessions/{id}/abort` | stop the current turn |
| POST | `/sessions/{id}/retry` | re-run the last failed turn (omp `abort_retry`). An omp-level error (nothing to retry, unknown command on older omp) is 400 like every command route |
| POST | `/sessions/{id}/compact` | `{instructions?}` |
| GET | `/sessions/{id}/state` | omp state, minus the system prompt and tool dumps |
| GET | `/sessions/{id}/messages` | full transcript (omp message objects) |
| GET | `/sessions/{id}/entries` | session-file message entries via omp `get_entries`: `{entries: [{entryId, role, timestamp}]}`. The `entryId`s are the fork targets; only `role: "user"` rows branch |
| POST | `/sessions/{id}/fork` | branch at a user entry (omp `branch`): `{entryId}`. Unknown session 404; `entryId` missing/not a string, unknown, or not a user message entry 422; a busy session (turn running or compacting) 409; omp command errors 400. Forks are serialized per session: a second concurrent fork waits, then sees the session stopped (404). A fork replaces its own parent (stop + register), so it is net-zero: it is allowed at the session cap, and 429s only when it would push the count past the cap. On success omp rewrites its live process into a new branched session file (the fork carries the history strictly BEFORE the entry; forking at the first user entry produces an empty session linked to the old file), so the gateway registers that branched session under a new gw id exactly like POST /sessions and stops the old child: returns `{gwId, forkedFrom, text}` where `text` is the forked message for a composer prefill. The old transcript stays on disk as a saved session |
| GET | `/sessions/{id}/files?prefix=` | index-only listing of ONE directory of the session cwd, for @-file mentions: `{entries: [{name, path, isDir, size}]}`. Names and sizes only; file contents are never served. Dotfiles excluded, dirs before files, at most 200 entries. `prefix=""` lists the cwd; an absolute prefix or any `..` segment is 422, a path whose real location is outside the session cwd (e.g. an escaping symlink) is 403, an unknown path is 404, unknown session 404 |
| GET | `/sessions/{id}/subagents` | subagent registry snapshot from omp `get_subagents` (`{"subagents": [...]}`; empty until omp spawns one). The gateway subscribes every live session at `progress` level after v2 negotiation, so `subagent_progress` / `subagent_lifecycle` events flow on the WebSocket |
| GET | `/sessions/{id}/subagents/{sid}/messages?from=` | one subagent's transcript via omp `get_subagent_messages` (`subagentId`, `fromByte`): `{messages, nextByte, reset, sessionFile}`. Page forward with `from=<nextByte>` while `nextByte` is present. Unknown `sid` is an omp command error → 400 |
| GET | `/sessions/{id}/stats` | token/cost stats |
| POST | `/sessions/{id}/model` | `{provider, modelId}` (both required; values from `/catalog/models`) |
| POST | `/sessions/{id}/thinking` | `{level}`: off, minimal, low, medium, high, xhigh, max |
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
`cwd` is the working directory recorded in the transcript (`null` when the file
has none); prefer it over the mangled `cwdFolder` for display. `cwdExists` is
whether that directory still exists on the gateway host (`null` when `cwd` is
`null`); clients should not offer a folder with `cwdExists: false` as a
one-tap pick, and should treat a missing key (older gateways) as unknown.
`running` is true when a live session has that file open.

**Resuming.** `POST /sessions {resumeFrom}`:

- With no `cwd`, the session starts in the folder recorded in the transcript. If
  that folder no longer exists (or none is recorded) it starts in the default
  `~/projects` and the response carries `"cwdFallback": true`. An explicit `cwd`
  always wins.
- If a live session already has that file open, no second process is started:
  the response is that session's info with HTTP 200 and `"alreadyLive": true`.

Session info fields: `gwId`, `cwd`, `approvalMode`, `resumedFrom`, `ompSessionId`,
`ompSessionFile`, `ompSessionName`, `model`, `thinkingLevel`, `advisor` (bool), `isStreaming`,
`idleSec`, `exited`, `protocolVersion`, `messageCount`, `contextUsage`,
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
echoing your `id`; `extension_ui_response` to answer a dialog.

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
