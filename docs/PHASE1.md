# Phase 1 build spec: Svelte 5 + TypeScript dashboard

Orchestrator: Opus 5.5 (plans, reviews, commits). Coder: Sonnet 5.5 via Claude
Code. Design intent is `docs/DESIGN.md`; this file is the concrete contract.
Where they disagree, this file wins for phase 1.

The current Alpine dashboard (`static/index.html` + `static/app.js`) works and
is the **reference implementation** for event handling edge cases (echo
dedupe of the user's own prompt, pending-UI handling, reconnect). Read
`static/app.js` before writing the reducer or the stream transport.

Real payloads captured from the live gateway are in `dev/fixtures/` (not in
git): `session-info.json`, `sessions-list.json`, `messages.json`,
`state.json`, `stats.json`, `commands.json`, `models-cli.json`,
`turn-tools-markdown.json` (a full turn: thinking, 2 tool calls, markdown
answer), `slash.json` (slash commands `/context`, `/usage`, `/skill:humanizer`),
`config.json`, `skills.json`, `system.json`. Treat these shapes as truth.

---

## Task A: gateway changes (Python, `gateway/`, `tests/e2e.py`)

1. **Serve the new web build.** If `web/dist/index.html` exists:
   - `GET /` serves `web/dist/index.html` (Cache-Control: no-cache).
   - `/assets/*` serves `web/dist/assets` (Cache-Control:
     `public, max-age=31536000, immutable`; filenames are hashed).
   - Root-level files from `web/dist` that are not `index.html` (e.g.
     `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png`,
     `icon-maskable-512.png`, `favicon.svg`) are served at `/<name>`; `sw.js`
     and the manifest with no-cache. Don't serve arbitrary paths: only files
     that exist directly in `web/dist` (no traversal).
   - These are all public (no auth), like `/` today.
   - The old dashboard moves to `GET /classic` (serves `static/index.html`;
     `/static/*` stays as is).
   - If `web/dist` is missing, `/` keeps serving the old dashboard.
   - The existing JSON `/manifest.webmanifest` route is used only when
     `web/dist/manifest.webmanifest` doesn't exist.
2. **CSP.** The new app needs no `unsafe-eval`. Use
   `script-src 'self'` for everything except `/classic` and `/static/*`,
   which keep `'unsafe-eval'` (Alpine). Keep `style-src 'self' 'unsafe-inline'`,
   `img-src 'self' data: blob:`, `connect-src 'self'`, `worker-src 'self'`,
   `manifest-src 'self'`.
3. **Images on prompts.** `POST /api/sessions/{id}/prompt` accepts optional
   `images: [{type:"image", data:<base64>, mimeType:"image/png"|"image/jpeg"|"image/webp"|"image/gif"}]`
   (max 4 images, max 5 MB decoded each, validate base64 and mime) and
   forwards them to omp's `prompt` / `steer` / `follow_up` as `images`. Update
   `bridge.py` `prompt()` accordingly.
4. **Model catalog.** `GET /api/catalog/models` runs `omp models --json` (via
   the existing `acli`), returns `{"models": [...]}` exactly as omp emits it,
   cached in memory for 10 minutes; `?refresh=1` bypasses the cache. (The RPC
   `get_available_models` takes >200 s and must not be used by the UI.)
5. **Replay gap flag.** `GET /api/sessions/{id}/events?after=n` adds
   `"gap": true|false`: true when `n > 0` and the oldest seq still in the
   backlog is greater than `n + 1` (events were dropped). The WS `auth_ok`
   control frame gets the same `gap` field computed from its `after`.
6. **Tests.** Extend `tests/e2e.py`: `/` serves HTML with the new CSP when
   dist exists (build a throwaway `web/dist` in a temp copy is NOT needed:
   just assert whichever branch is active), `/classic` serves the old app,
   `/assets/../auth-token` style traversal returns 404, `/api/catalog/models`
   returns a non-empty list (allow ~60 s), `images` validation (bad mime ->
   422, bad base64 -> 422), `/events` returns `gap: false` for `after=0`.
   Run it against your own instance on port 9325.
7. Update `docs/API.md` for every change above (it is the client contract).
   Bump `VERSION` in `gateway/main.py` to `0.3.0`.

## Task B: web foundation (`web/`)

### Stack

Vite + Svelte 5 (runes) + TypeScript strict, built with bun. Vitest (+ jsdom)
for unit tests, `svelte-check` for types. Runtime dependencies, and only
these unless you justify another in `web/README.md`:
`marked`, `dompurify`, `highlight.js` (import `highlight.js/lib/core` and
register only: typescript, javascript, python, bash, shell, json, yaml, diff,
css, xml, go, rust, sql, markdown, ini, dockerfile). No UI kit, no CSS
framework, no router library (hash routing by hand is enough).

Scripts in `web/package.json`: `dev` (vite, port 5173, host 0.0.0.0),
`build` (vite build to `web/dist`), `check` (svelte-check), `test` (vitest run).
Vite dev server proxies `/api`, `/auth`, `/healthz`, `/.well-known` and
`/omp-ws` (ws: true) to `http://127.0.0.1:9315`.

### Layout

```
web/
  index.html            viewport meta incl. interactive-widget=resizes-content, viewport-fit=cover
  public/               manifest.webmanifest, sw.js, icons (Task D fills these)
  src/
    main.ts  App.svelte
    styles/   tokens.css themes.css base.css
    lib/api/        client.ts (fetch wrapper), types.ts (wire types), stream.ts (WS transport)
    lib/transcript/ types.ts reducer.ts (pure) + __tests__
    lib/render/     markdown.ts ansi.ts highlight.ts + __tests__
    lib/platform/   storage.ts (scoped keys) idb.ts keyboard.ts haptics.ts notify.ts
    lib/state/      *.svelte.ts rune-based stores
    lib/ui/         primitives (Task C/D)
    components/     feature components (Task C/D)
```

### `lib/api`

- `client.ts`: `api<T>(path, {method, body, headers, signal})` with
  `credentials: 'same-origin'`, JSON by default, raw text bodies allowed
  (config PUT is `text/yaml`). Throws `ApiError {status, message, code?}`
  using the gateway's `{"error": ...}` body. A 401 on anything but
  `/auth/login` emits a single app-level `signed-out` event. All gateway
  access in the app goes through this module and `stream.ts`; components
  never call `fetch`/`WebSocket` directly. Base URL defaults to same origin
  but is configurable (future desktop/Android shells).
- `types.ts`: hand-written wire types matching the fixtures: `SessionInfo`,
  `SavedSession`, `SessionsList`, `ModelRef` (from session info, has
  `thinking?: {efforts: string[]}`), `CatalogModel` (from `omp models --json`,
  `thinking: string[] | null`), `SlashCommand` (`name`, `description`,
  `source: 'builtin'|'skill'|'extension'|'custom'|'file'`, `input?.hint`,
  `subcommands?`), `SessionState`, `SessionStats`, `UiRequest`
  (`extension_ui_request`), omp message types (`user`, `assistant` with
  content blocks `text|thinking|toolCall`, `toolResult`, `custom`), and a
  discriminated union of the stream events listed below.
- `stream.ts`: `SessionStream` class, one per open session.
  - URL `/omp-ws/{gwId}?after={lastSeq}`; cookie auth (same origin).
  - Frames are `{seq, event}`. `seq > 0`: drop if `seq <= lastSeq`, else
    advance and emit. `seq == 0`: control (`auth_ok {session, gap}`,
    `heartbeat`, `pong`, `ws_error`, `rpc_response`).
  - Close codes: 4401 -> signed-out; 4404 -> session gone (emit, no retry);
    4408 -> slow consumer, reconnect immediately with the cursor; 4429 ->
    locked out, surface message, retry after 60 s; anything else -> retry.
  - Reconnect: full-jitter exponential backoff, base 1 s, cap 30 s. Stable
    open rule: a socket that closes within 5 s of `auth_ok` counts as a
    failure (doesn't reset the attempt counter). Expose
    `state: 'connecting'|'live'|'retrying'|'offline'|'gone'` and
    `retryAt: number|null` so the UI can render "Reconnecting in 4 s".
  - On `document.visibilitychange` to visible or `online`: reconnect now.
    If the tab was hidden > 5 minutes, emit `resync` (caller refetches
    state + messages) instead of trusting the delta. `auth_ok.gap === true`
    also emits `resync`.
  - Client heartbeat watchdog: if no frame for 60 s while "live", close and
    reconnect.
  - Fully unit-tested with a fake WebSocket and fake timers.

### Events to handle (see fixtures)

`agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`,
`message_update` (`assistantMessageEvent.type`: `text_start|text_delta|text_end|thinking_start|thinking_delta|thinking_end|toolcall_start|toolcall_delta|toolcall_end`,
with `partial` = the full partial message), `message_end`,
`tool_execution_start {toolCallId, toolName, args, intent}`,
`tool_execution_update {partialResult}`, `tool_execution_end {result, isError}`,
`extension_ui_request` (blocking methods `select|confirm|input|editor`;
fire-and-forget `notify|setStatus|setWidget|setTitle|set_editor_text|open_url`,
never answered), `ui_resolved {id}` (gateway event), `command_output {text}`
(slash command output, contains ANSI SGR codes), `available_commands_update`,
`prompt_result {agentInvoked, status}`, `session_settled`,
`auto_compaction_start|end`, `auto_retry_start|end`, `model_changed`,
`thinking_level_changed`, `notice`, `extension_error`. Unknown types are
ignored, never thrown on.

### `lib/transcript`

A pure reducer: `(TranscriptState, Input) -> TranscriptState` where Input is
`{kind:'history', messages}` | `{kind:'event', event}` |
`{kind:'local-send', text, mode, images?}` | `{kind:'local-send-failed', ...}`.
Items:

- `user` (text, images count, `pending` until echoed, `note`: steer/queued/other client)
- `assistant` (markdown text, `streaming` flag, messageId, model, usage)
- `thinking` (text, `startedAt`, `endedAt` from thinking_start/end or
  timestamps; one per assistant message, rendered before its text)
- `tool` (toolCallId, toolName, args, `summary` = intent || command || path
  || file_path || pattern || query || url || compact JSON, output text,
  `status: running|done|error`, startedAt/endedAt)
- `skill` (from `custom` messages with `customType: "skill-prompt"`: skill
  name parsed from the content's first line, full content kept for expand)
- `command` (command_output text, raw ANSI kept; rendered in Task C)
- `notice` (compaction, retry, model/thinking changed, extension_error,
  send failed)

Rules: history and live events must produce the same items for the same
turn (test this by reducing `messages.json` vs the events in
`turn-tools-markdown.json`). Echo dedupe as in `static/app.js`. Message
update is keyed by `messageId`. Tool rows keyed by `toolCallId`. Keep raw
source objects on items (`raw`) for the inspector.

### `lib/render`

- `markdown.ts`: `marked` (GFM) -> DOMPurify (no `style`, no event handlers,
  links get `rel="noopener noreferrer" target="_blank"`) -> code blocks
  highlighted with highlight.js core, wrapped with a header (language + copy
  button placeholder element the component wires up). Must be safe to call
  on partial streaming markdown. Tests include XSS payloads
  (`<img onerror>`, `javascript:` links, `<script>`).
- `ansi.ts`: SGR subset (reset, bold, dim, italic, underline, 30-37, 90-97,
  39, 38;5;n, 38;2;r;g;b) -> escaped HTML spans with classes or inline color
  (colors via CSS vars for the 16 basic ones). Everything else stripped.
  Tested.

### `lib/platform`

- `storage.ts`: key scoping per CLIENTS.md:
  `ompgw:v1:<origin>:<scope>:<key>` with scopes `device` and `session:<id>`.
- `idb.ts`: tiny promise wrapper (no dependency) for a keyval store; used to
  cache the sessions list and per-session transcript messages so opening a
  session paints instantly and then reconciles.
- `keyboard.ts`: publish `--kb` (px) on `:root` from `visualViewport`
  (`innerHeight - vv.height - vv.offsetTop`, rAF-coalesced, ignore < 120 px
  and `vv.scale > 1`). Tested with a fake visualViewport.
- `haptics.ts`: `tap()` -> `navigator.vibrate?.(10)` on coarse pointers.
- `notify.ts`: desktop Notification when the tab is hidden (permission asked
  only from a user gesture).

### `lib/state`

Rune-based (`.svelte.ts`) stores: `auth` (signed-in/out), `sessions`
(live + saved, polled every 5 s while visible; grouped into needsYou /
running / idle / history-by-date), `active` (open session: info, transcript
state, stream, pendingUi, stats, commands), `settings` (theme, accent,
density, width, prose font, follow-system; persisted per device), `ui`
(overlays, toasts, confirm).

### Styles

`tokens.css`: CSS custom properties only, per DESIGN.md "Visual language":
surfaces (`--bg`, `--canvas`, `--surface`, `--inset`, `--field`), inks
(`--ink`, `--ink-2`, `--ink-3`), lines (`--line`, `--line-strong`),
`--accent`, `--accent-ink`, status (`--ok`, `--warn`, `--err`), radii
(10/8/6), spacing scale, type scale (14 px desktop base, 15 px on coarse
pointers), `--mono` and `--sans` stacks (system fonts, no web fonts),
motion durations with a `prefers-reduced-motion` override.
`themes.css`: presets `terminal` (dark, green accent, close to the current
look), `graphite` (neutral dark, blue accent), `paper` (light), `contrast`
(high contrast dark), selected via `data-theme` on `<html>`; accent override
via `--accent` set from settings; `data-density="compact"`.

### Acceptance for Task B

`bun run check`, `bun run test`, `bun run build` pass. A minimal `App.svelte`
exists that shows a login form and, once signed in, a plain list of live
sessions (Task C replaces it). Reducer, stream, markdown, ansi, keyboard
and storage have tests.

## Task C: the app (components)

Build the real UI on Task B's foundation. Desktop layout: rail (280 px,
collapsible) | session column (transcript max-width 820 px "reading" or
1100 px "wide", centered in its column). Below 900 px: rail becomes an
off-canvas drawer.

1. **Login**: centered card, token field (password type, autocomplete off),
   error text from the gateway (including 429 lockout with minutes).
2. **Rail**: header (omp mark, New session button, search button that opens
   the palette). Groups: *Needs you* (live sessions with `pendingUi.length`),
   *Running* (`isStreaming`), *Idle* (other live), *History* (saved, not
   running; Today / Yesterday / This week / Earlier by `mtime`). Empty groups
   hidden. Row: title (`ompSessionName` or saved `title` or cwd basename),
   secondary line (cwd basename + relative time), status glyph (amber dot
   outranks running spinner). Counts on group headers. Active row
   highlighted. Clicking a live row opens it; a history row resumes it
   (`POST /api/sessions {resumeFrom}`; if `running`, open the live one).
   Footer: settings button, connection dot.
3. **Session header**: title (click to rename inline), cwd basename,
   model chip, context meter (thin bar + percent, amber >= 70 %, red >= 85 %),
   cost (from `/stats`, refreshed on `agent_end`), connection state text
   only when not live ("Reconnecting in 4 s"), overflow menu (Session info,
   Compact, Stop session). On mobile: drawer button on the left.
4. **Transcript**: renders reducer items.
   - user: right-aligned bubble; pending state subtle; note label.
   - assistant: full-width markdown document; streaming caret while
     streaming; code blocks with copy button.
   - thinking: collapsed row "Thought for 12 s" / "Thinking" with pulse while
     active; expands to muted text. Never expanded by default.
   - tool: consecutive tools grouped in one bordered block; each row is one
     line: status glyph, tool name (mono), summary (truncated), duration;
     click/Enter expands output (`<pre>`, first 200 lines, "Show all").
     Red only for `isError`. Output that looks like a unified diff gets
     +/- line colouring.
   - skill: small chip "Skill: humanizer", expandable.
   - command: ANSI-rendered `<pre>` card titled with the command.
   - notice: centered small muted line.
   - Message actions (copy, inspect raw JSON) on hover/focus; on touch via
     long-press (500 ms) opening an action sheet. Hidden while streaming.
   - Auto-follow while the user is within 120 px of the bottom; otherwise a
     "Jump to latest" pill. `overscroll-behavior: contain`.
     `content-visibility: auto` on finished items.
   - Empty session: quiet prompt suggestions (3 short starters) + hint
     "Type / for commands".
5. **Composer** (bottom of the session column, above the keyboard:
   `padding-bottom: calc(var(--kb, 0px) + env(safe-area-inset-bottom))`):
   - Auto-growing textarea (max ~40 % viewport). Enter sends / Shift+Enter
     newline on fine pointers; on coarse pointers Enter is newline and the
     send button sends. Blur after send on coarse pointers.
   - `/` at the start opens the slash menu: fuzzy match over `/commands`
     (fetched per session, refreshed on `available_commands_update`),
     grouped by source (Commands, Skills, Extensions, Custom), shows
     description and `input.hint`; arrow keys + Enter/Tab insert
     `/<name> `; Escape closes. Selecting a command without an input hint
     and without subcommands sends immediately.
   - Chips row: model (opens model picker: searchable list from
     `/api/catalog/models`, grouped by provider, shows context window and
     cost; selecting calls `POST /model {provider, modelId}`), thinking level
     (only the levels the model supports, from `model.thinking.efforts`,
     plus `off`; `POST /thinking`), approval mode (read-only for a live
     session; tooltip/sheet explains it's fixed at session start).
     Pickers: popover on desktop, bottom sheet on mobile.
   - While `isStreaming`: primary button = Steer (sends with mode `steer`),
     secondary = Queue (mode `follow_up`), plus Stop (`/abort`). Show
     `queuedMessageCount` from state when > 0.
   - Paste or attach images (png/jpeg/webp/gif, max 4, 5 MB each): thumbnail
     tray with remove buttons; sent as `images`.
   - Drafts persisted per session (scoped storage), restored on open, cleared
     on successful send. If the session dies, the draft survives and is
     offered in the new-session sheet.
6. **Approval takeover**: when `pendingUi` is non-empty the composer is
   replaced by the approval panel for `pendingUi[0]`, with "1 of N".
   - Title: first line as the headline ("Allow tool: bash"), remaining lines
     in a mono block (the command/path). `message` shown if present.
   - `select`: one full-width button per option (48 px tall), with
     `optionDetails[i].description` as secondary text; keys 1..9 pick.
     Approve-like options use accent, Deny-like options neutral.
   - `confirm`: Yes / No -> `{confirmed}`. `input`: text field -> `{value}`.
     `editor`: textarea prefilled with `prefill`/`text` if present -> `{value}`.
   - A small "Dismiss" link sends `{cancelled: true}`.
   - Answer via `POST /api/sessions/{id}/ui/{requestId}`; 409 means someone
     else answered: drop it quietly. Haptic tap on answer. A desktop
     notification fires if the tab is hidden when a request arrives.
7. **New session sheet**: cwd (text input with suggestions from live/saved
   cwds; default `~/projects`), model (same picker, optional), thinking,
   approval mode (radio: Yolo "runs tools without asking", Write "asks
   before edits and commands", Always ask "asks before every tool"), Start.
   `Ctrl/Cmd+Shift+O` opens it.
8. **Primitives** (`lib/ui`): `Sheet` (native `<dialog>`: centered on
   desktop, bottom sheet on < 900 px with drag handle and swipe-down to
   close), `Popover`, `Menu`, `ConfirmDialog` + imperative `confirm()`,
   `Toast` + imperative `toast()`, `Icon` (inline SVG set, no icon font),
   `Spinner`, `Kbd`. One way to ask, one way to tell.
9. **Mobile**: swipe right from the left 24 px edge opens the drawer, swipe
   left closes; drawer button in the header; 44 px min targets on coarse
   pointers; composer stays above the keyboard (`--kb`); safe-area insets
   on header and composer.

## Task D: power layer and PWA

1. **Command palette** (`Ctrl/Cmd+K`, and the rail search button): fuzzy
   search over live sessions, history sessions, actions (New session, Next
   needing attention (`g n` too), Settings pages, Theme toggle, Compact,
   Stop, Rename, Session info), and the open session's slash commands.
   Keyboard-first; on mobile it's a full-height sheet.
2. **Settings overlay** (`Ctrl/Cmd+,`): opens over the session, Escape or
   close returns focus. Left nav on desktop, stacked list on mobile. A
   search box filters settings across pages and jumps to the match.
   Pages: *Appearance* (theme preset cards with live preview, accent color
   swatches + custom, density, transcript width, prose font sans/mono,
   follow system light/dark), *Agent config* (raw YAML editor for
   `/api/config`, monospace, save -> PUT with the gateway's validation
   message shown; unsaved-changes guard), *Models* (searchable catalog with
   "Use in this session"), *Skills* (`/api/skills` list with descriptions),
   *Usage* (`/api/usage` raw text, ANSI rendered), *Connection* (gateway +
   omp versions from `/api/system`, uptime, live sessions, sign out),
   *Shortcuts* (read-only list).
3. **Session info sheet**: cwd, session file, model, thinking, approval
   mode, context usage, tokens + cost breakdown from `/stats`, message
   count, queue modes, protocol version.
4. **Inspector**: "Inspect" message action opens a sheet with the item's raw
   JSON (pretty, copyable).
5. **PWA**: `public/manifest.webmanifest` (name "omp", short_name "omp",
   `display: standalone`, theme/background from the terminal theme,
   `start_url: "/"`, icons 192/512 PNG + a 512 maskable, generated once
   from `static/icon.svg` with ImageMagick `magick` and committed).
   `public/sw.js`: navigation requests network-first falling back to the
   cached `/`; `/assets/*` cache-first; never touch `/api`, `/auth`,
   `/omp-ws`, `/healthz`. Versioned cache name, old caches deleted on
   activate. Registered only in production builds. iOS: apple-touch-icon
   and `apple-mobile-web-app-capable` meta.
6. **Stale not loading**: sessions list and each session's last messages
   cached in IndexedDB; on open, paint cached items immediately, then
   replace with the fresh history. Skeleton rows only when there's no cache.
7. **Keyboard map**: `Ctrl/Cmd+K` palette, `Ctrl/Cmd+,` settings,
   `Ctrl/Cmd+Shift+O` new session, `g n` next needing attention, `[` toggle
   rail, `Esc` closes the top overlay, `/` focuses the composer when not
   typing, `Alt+Up/Down` previous/next session.

## Out of scope for phase 1

Web Push, Plan/Subagents panels, fork/branch, retry, cross-session search,
structured config forms, `@` file mentions, `!` shell, git changes panel,
provider login, multi-profile. Don't build stubs or placeholders for them.
