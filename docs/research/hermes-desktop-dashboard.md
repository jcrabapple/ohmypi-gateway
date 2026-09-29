# Hermes Agent: Desktop App + Web Dashboard UX Research

Source: local checkout at `~/.hermes/hermes-agent/` (read-only). This report mines the
Electron desktop app (`apps/desktop/`), the web dashboard SPA (`web/` + backend routers in
`hermes_cli/web_routers/`), the shared JSON-RPC client (`apps/shared/`), and the JSON-RPC
gateway backend (`tui_gateway/`) for ideas to apply to the oh-my-pi dashboard redesign and
future native desktop/Android clients.

The single most valuable discovery: Hermes keeps its UX rules in living `AGENTS.md` /
`DESIGN.md` files inside the repo. `apps/desktop/AGENTS.md`, `apps/desktop/src/AGENTS.md`,
`apps/desktop/DESIGN.md`, `web/AGENTS.md`, and `tui_gateway/AGENTS.md` are essentially a
postmortem-driven design system. Much of this report distills those.

## 1. Information architecture

### Desktop app

* Chat is the home surface. Transcript and composer stay primary; tools, previews, files,
  review, and terminal "complement the conversation" (`apps/desktop/DESIGN.md`, section
  "Information architecture").
* Durable pages in shell chrome: Chat, Skills, Messaging, Artifacts. Secondary surfaces
  (Settings, Command Center, Cron, Profiles, Agents, Starmap) render as **route overlays**
  (`OverlayView` cards) that return to the previous route on close, not as navigation
  stacks. Master/detail overlays ride a shared `OverlaySplitLayout` + `OverlaySidebar` /
  `OverlayMain`, and settings subpages use `OverlayNav` (labels navigate, a shared
  disclosure caret opens branches without changing page). Source: `apps/desktop/DESIGN.md`;
  `apps/desktop/src/app/overlays/`.
* Panes are working context: preview, files, review, terminal stay attached to the current
  task and "stay alive when hidden. Visibility is not lifecycle" (`apps/desktop/AGENTS.md`).
* Feature layout under `apps/desktop/src/app/`: `chat`, `command-palette`, `command-center`,
  `cron`, `messaging`, `profiles`, `agents`, `settings`, `right-sidebar`, `webhooks`,
  `starmap`, `hud`, plus plugins under `src/plugins/` (including a full Kanban board in
  `src/plugins/kanban/`).
* Sessions live in a sidebar of "tiles" (`src/app/chat/session-tile.tsx`, `route-tile.tsx`)
  with status dots, unread badges, drag to reorder/split panes (`session-drag.ts`,
  `new-session-drag.ts`), and owner routing per profile. Profile-scoped state migrates on
  profile rename (`store/session-states.ts`, `migrateTilesForProfile`).
* Hard navigation rule: background events may update badges but must never replace the
  foreground transcript, steal focus, or open a pane. "Offer; don't hijack"
  (`apps/desktop/AGENTS.md`).

### Web dashboard

* Single left sidebar (React Router) with flat routes: `/chat`, `/sessions`, `/files`,
  `/analytics`, `/models`, `/logs`, `/cron`, `/skills`, `/plugins`, `/mcp`, `/channels`,
  `/webhooks`, `/pairing`, `/profiles`, `/config`, `/env` (Keys), `/system`, `/docs`
  (`web/src/App.tsx`, `BUILTIN_ROUTES_CORE`).
* All pages are `lazy()`-loaded so the shell does not pay for admin surfaces or xterm up
  front (`web/src/App.tsx:78-98`).
* `/chat` is special: it renders **persistently outside `<Routes>`** so the PTY child,
  WebSocket, and xterm instance survive navigation; a `display:none` toggle hides it without
  unmounting. A `ChatRouteSink` placeholder claims the URL so deep links and back/forward
  keep working (`web/src/App.tsx:146-185`). Steal this pattern for any expensive live view.
* Plugins can register their own routes/nav items (`web/src/plugins`, `PluginPage`,
  `PluginSlot`), and unknown routes redirect to `/sessions` only after plugins finish
  loading to avoid a flash (`web/src/App.tsx:131-137`).
* Backend routers are strictly one file per surface (`hermes_cli/web_routers/*.py` mounted
  by `hermes_cli/web_server.py`), per `web/AGENTS.md`: "a new surface is a new
  `web_routers/<surface>.py`, not a growing `web_server.py`."

## 2. Chat surface

Two completely different strategies exist side by side, and the contrast is instructive.

### Dashboard: embed the real TUI over a PTY

`web/src/pages/ChatPage.tsx` mounts xterm.js (WebGL renderer, `@xterm/addon-fit`,
`@xterm/addon-unicode11`) and streams raw PTY bytes over `/api/pty` (WebSocket, auth token
as query param because browsers cannot set `Authorization` on a WS upgrade). The server
spawns the actual `hermes --tui` via `ptyprocess` (`hermes_cli/pty_bridge.py`,
`web/AGENTS.md`). Resize travels as an escape sequence (`\x1b[RESIZE:cols;rows`) applied
server-side with `TIOCSWINSZ`. The rule is explicit: "Do not re-implement the primary chat
experience in React." Structured React around the terminal (sidebar widgets, inspectors,
model picker) is fine as long as its state is independent of the PTY child and its failures
are non-destructive.

### Desktop: a real native chat surface on assistant-ui

The desktop deliberately does NOT embed the TUI (`apps/desktop/src/AGENTS.md`). It has its
own composer, transcript, and slash pipeline built on `@assistant-ui/react`, talking
JSON-RPC to `tui_gateway`. Notable mechanics:

* **Streaming contract**: `prompt.submit` -> `message.delta` / `message.complete`; tool
  activity via `tool.start` / `tool.generating` / `tool.complete` events
  (`tui_gateway/AGENTS.md`, "Key surfaces").
* **Durable send**: `prompt.submit` writes the session row AND the user message row before
  the agent build starts, and the turn adopts that row, so a crash mid-build leaves a
  resumable transcript (`apps/desktop/AGENTS.md`, #111868).
* **Server-to-client requests** are first-class in the protocol: the agent can ask the user
  `approval`, `clarify`, `sudo`, `secret`, `vault.*` questions mid-turn and block on the
  answer; reconnecting clients replay still-open questions via `session.events.since`
  (`tui_gateway/AGENTS.md`, `server_requests.py`). This is the cleanest design in the whole
  system for a coding-agent UI.
* **Approvals UX**: one persistent transcript-level host owns approval cards, independent of
  tool rows; cards queue (`CardStack`), gestures never grant approval, and prepared
  approvals may precede `tool.start` (`apps/desktop/DESIGN.md`, "Queued cards").
* **Composer** (`apps/desktop/src/app/chat/composer/`): rich editor with slash completion
  drawer, file/path refs, URL refs, inline references, attachments, large-paste handling,
  queued prompts (`queue-panel.tsx`), model pill, reasoning-effort pill, voice input, input
  history, per-session drafts (including restoring an unsent draft when a session dies:
  `store/composer.ts` `adoptGoneSessionDraft`), and a collapsible status stack showing
  todos, goals, and background tasks.
* **Slash commands** are curated client-side but discovered from the backend:
  `commands.catalog` and `complete.slash` include built-ins, user `quick_commands`, and
  skill-derived commands; `apps/desktop/src/lib/desktop-slash-commands.ts` only hides
  terminal-only/messaging-only built-ins and never hides user extensions. A command's
  per-surface disposition is authored once on its `CommandDef` in `hermes_cli/commands.py`.
  Lesson: one catalog, per-surface filtering, never fork the command list.
* **Thinking display**: thinking previews follow new tokens only while the user is near the
  bottom of the scroll, preserving reading position (`apps/desktop/DESIGN.md`).
* Sticky user messages clip covered scrolling content; nested transcript scrollers hand
  scrolling back at the edges. Tool rows reserve red for genuine failures, not ambiguous
  exit codes (`apps/desktop/DESIGN.md`).

## 3. Settings / config UX

* Dashboard config is **schema-driven auto-forms**: `web/src/components/AutoField.tsx`
  renders boolean -> Switch, select -> Select, number/text -> inputs, nested objects ->
  recursive boxed editors, from a JSON schema served by the backend
  (`hermes_cli/web_routers/config_env.py`, `web/src/pages/ConfigPage.tsx`). Keys are exposed
  separately in `EnvPage`. This gets deep config coverage for free but is a known
  weak point visually (flat generated form, nested editors get boxy).
* Desktop settings are hand-crafted, progressive disclosure: `OverlayNav` subpages
  (`apps/desktop/src/app/settings/subpages.ts`), `ListRow` primitives for
  label/description/action rows, `SegmentedControl` for small exclusive choices, a global
  **settings search** (`settings-search.ts`, `use-settings-search.ts`) with deep-link
  highlight (`use-deep-link-highlight.ts`), and per-profile scoping (`profile-scope.tsx`).
* Persisted state must declare its scope in its key: global vs connection vs profile vs
  session vs window (`apps/desktop/AGENTS.md`, "Decide state by authority"). Getting scope
  wrong is "how one profile's setting bleeds into another."

## 4. Customization: themes / skins

* One canonical **skin contract** shared by every surface: `apps/shared/src/skin.ts`. Skins
  are authored as YAML in `$HERMES_HOME/skins/<name>.yaml`, resolved server-side by
  `hermes_cli/skin_engine.py`, and pushed to clients over JSON-RPC (`gateway.ready`,
  `skin.changed`). Tokens are terminal-first (about 45 color tokens plus branding strings),
  and each surface owns a resolver: TUI -> ANSI-safe theme, desktop -> CSS custom properties
  (`apps/desktop/src/themes/skin.ts`), CLI -> Rich styles. Every token is optional;
  resolvers fall back. Skins can ship `dark_colors` / `light_colors` polarity overlays.
* Shared preset palettes live in `apps/shared/src/theme-presets.ts` so desktop and dashboard
  render the same palette; the dashboard projects them onto its own 3-slot palette model and
  adds typography (font stacks, base size, line height) and layout (radius, density) per
  theme, so switching themes changes more than color (`web/src/themes/presets.ts`,
  `web/src/themes/types.ts`).
* Desktop design tokens are CSS vars (`--ui-stroke-*`, `--ui-text-*`, `--theme-primary`,
  `--stroke-nous`, `--shadow-nous`); the rule "tokens, not literals" is enforced socially
  via `apps/desktop/DESIGN.md` and its checklist.
* Layout customization: flippable sidebars, layout presets, per-window glass/translucency
  with a shared resolver in `apps/shared/src/translucency.ts` (so Electron's first paint
  matches the renderer), chat/terminal font settings, session list density
  (`store/session-list-density.ts`).

## 5. Connectivity model

* One shared client library, `@hermes/shared` (`apps/shared/src/`), consumed by BOTH the
  desktop renderer and the web dashboard: `JsonRpcGatewayClient` over WebSocket
  (`json-rpc-gateway.ts`), a request channel with heartbeats and server-request routing
  (`json-rpc-channel.ts`), URL helpers (`websocket-url.ts`), and a generated typed contract
  (`gateway-contract.generated.ts` + `gateway-contract.openrpc.json`, generated from Python
  Pydantic models by `scripts/gen_gateway_contracts.py`; a test fails when stale). The wire
  is declared once in Python and type-checked in TypeScript. This is the architecture
  lesson most worth copying for oh-my-pi.
* Reconnect: shared exponential backoff with full jitter (`apps/shared/src/reconnect-backoff.ts`),
  including the "stable open" rule: a socket that dies within 5 s of opening counts as a
  failed attempt, so a flapping gateway does not reset the ladder (fixes a reconnect-storm
  bug, #83134). After reconnect the client replays `session.events.since` (bounded, 10 s
  timeout) to re-render still-open questions.
* Desktop connection modes: local pooled backend (`hermes serve --port 0` per
  connection+profile, spawned by Electron with a backward-compat fallback to `dashboard
  --no-open` for older runtimes, `electron/backend-command.ts` +
  `electron/backend-serve-support.ts`), remote URL+token, SSH, and cloud/OAuth. OAuth
  connections mint a fresh WS ticket per dial and only a confirmed 401/403 triggers
  reauth; transient failures stay connectivity errors (`apps/desktop/AGENTS.md`, auth
  corollaries). A connection test must exercise the actual WebSocket/auth leg, not just an
  HTTP probe.
* Context switching is a "re-home, not a reboot": soft re-home (shell stays mounted,
  gateway-bound stores explicitly wiped), hard re-home (window reload), and live profile
  swap (background profiles keep streaming, lists merge) are three distinct shapes
  (`apps/desktop/AGENTS.md`).
* Dashboard auth: one ephemeral session token for REST and WS alike (`web/AGENTS.md`).

## 6. Mobile / responsive handling in the dashboard

* Sidebar collapses below the 1024 px breakpoint into a fixed top bar + slide-over drawer
  (`useBelowBreakpoint(1024)` in `web/src/App.tsx`); desktop sidebar can also collapse to an
  icon rail. Safe-area padding for iOS (`env(safe-area-inset-bottom)`).
* The terminal does real work for mobile: `web/src/lib/keyboard-inset.ts` computes the
  soft-keyboard inset from `window.visualViewport` (iOS Safari does not shrink the layout
  viewport), applies it as bottom padding so xterm refits and the PTY gets a resize; it
  also sets `interactive-widget=resizes-content` for Android Chrome 108+. There is a
  dedicated `pty-mobile-input.ts` and terminal font size / line height adapt to container
  width tiers (`ChatPage.tsx`, `terminalFontSizeForWidth`).
* Everything else is secondary: the dashboard is usable on a phone mostly because the chat
  is a terminal. For oh-my-pi, treat this as evidence of both the strength (one
  implementation, works everywhere) and the cost (terminal UX on a phone) of the PTY
  approach.

## 7. Delightful ideas, and things to avoid

Delightful / worth stealing:

* `DESIGN.md` as a "named contract": every primitive, token, and variant has an entry that
  must be updated in the same commit; a stale name is "a bug, exactly like a stale type."
* `ConfirmDialog` as the only confirmation path, also callable imperatively
  (`confirm()` in `src/store/confirm.ts`), same for `notify()`. One way to ask, one way to
  tell.
* Tooltip discipline: tips only when hover teaches something new; 200 ms first-open delay,
  warm-page instant reopen; a test bans native `title=` on buttons
  (`src/components/ui/__tests__/no-native-title.test.ts`).
* Loader is an animated ASCII/math curve; "never ship the literal text 'Loading...'".
* Gone-session handling: a verifiably dead session drops to a fresh draft and carries the
  user's unsent text along with an undoable notice; no toast, no focus steal
  (`apps/desktop/AGENTS.md`).
* Bot Mode identity lesson: a canonical chat is identified by NAME via an indexed lookup,
  never by a stored session-id pointer, because pointers dangle
  (`apps/desktop/src/AGENTS.md`). Generalizes to: identify durable resources by stable
  natural keys resolved at click time.
* Per-session composer pop-out, composer status drawer with per-conversation persisted
  disclosure, and "visibility is not lifecycle" for expensive panes.
* Guided onboarding is rehearseable from a fresh temp home via env vars
  (`apps/desktop/AGENTS.md`, "Rehearsing the guided onboarding").

Heavy / avoid:

* The dashboard is a flat 19-item sidebar; several admin surfaces (`/config`, `/env`,
  `/system`, `/pairing`) feel like internal tools exposed raw. The auto-generated config
  form (`AutoField.tsx`) recurses into nested objects with boxed editors that get cluttered
  fast. Prefer curated settings + search + progressive disclosure (the desktop model).
* Two chat surfaces (embedded TUI vs native desktop) means UX improvements must be made
  twice or diverge; only acceptable because Ink is the shared origin.
* The desktop store directory (`src/store/`) has 300+ files; nanostores scale, but the
  granularity signals how much incidental complexity a mature agent UI accrues. Keep the
  state-authority discipline from day one.

## 8. Architecture lessons for desktop + Android on a gateway API

1. **Declare the wire once, generate both sides.** Pydantic models per method/event in
   `tui_gateway/contracts/`, generated TS types + OpenRPC doc, drift caught by a test
   (`tui_gateway/AGENTS.md`, "The wire is declared in Python and generated for TypeScript").
   For oh-my-pi: generate OpenAPI/JSON-schema types for TS and Kotlin/Swift from one source.
2. **Bidirectional protocol.** Client->server RPC, server->client *requests* (approval,
   clarify, secret) with blocking semantics and replay-on-reconnect, plus event
   notifications. Plan for the agent asking the human questions from the start; it is
   painful to retrofit.
3. **Shared transport package.** One framework-agnostic client (`@hermes/shared`) with
   heartbeat, request timeouts, jittered reconnect with a stable-open rule, and event
   replay (`apps/shared/src/json-rpc-gateway.ts`, `reconnect-backoff.ts`). Android should
   get the equivalent Kotlin module.
4. **State by authority.** Backend owns anything another surface can change; the client
   treats its copy as a cache: merge don't clobber, optimistic paint with visible rollback,
   generation counters against stale async, only the foreground surface publishes into the
   shared view (`apps/desktop/AGENTS.md`).
5. **Durable send.** Write the user's message before starting agent work so crashes leave a
   resumable transcript.
6. **Session identity tiers.** Durable id for navigation/persistence, runtime id for live
   streaming, lineage root across compression; translate at the boundary
   (`apps/desktop/AGENTS.md`, "Identity is not incidental").
7. **Capability by session, not host.** A client tells the backend what it can do
   (`client.capabilities`, `source: 'desktop'`) because the backend may be remote
   (`apps/desktop/AGENTS.md`, "Surface capability is a property of the SESSION").
8. **One backend, many surfaces.** `hermes serve` (headless) vs `hermes dashboard` (SPA) vs
   `--tui` all share `tui_gateway`; the desktop has zero dependency on the web frontend.
9. **Guest-content sandboxing.** Preview webviews deny `window.open`, forward only trusted
   user clicks through a narrow IPC bridge, and allowlist `http(s)` only
   (`apps/desktop/AGENTS.md`, GHSA-9f4c-93c8-jc8g).

## Top 15 ideas to steal, ranked

1. **Bidirectional RPC with server->client requests and replay** - approvals/clarify that survive reconnect are the core of a coding-agent UI.
2. **Schema-generated wire contract with drift tests** - one source of truth kills an entire bug class across web/desktop/Android.
3. **Persistent-mounted live view** - keep the expensive session view mounted across navigation (`display:none` toggle) so streams and scroll survive.
4. **Shared jittered reconnect with stable-open rule + event replay** - reconnect storms and wedged-handshake hangs are both pre-solved in `apps/shared/src/reconnect-backoff.ts` and `json-rpc-gateway.ts`.
5. **Route overlays for short tasks** - settings/cron/profiles as overlays that return to the previous route keeps chat home and navigation shallow.
6. **Route overlays with shared master/detail chrome** - one `OverlaySplitLayout` + `OverlayNav` prevents every settings page reinventing its shell.
7. **One catalog, per-surface slash command curation** - backend lists all commands; each client filters for its surface; user extensions always flow through.
8. **Durable send (write user message before agent work)** - crashes leave resumable transcripts instead of lost prompts.
9. **Settings search + deep-link highlight + progressive disclosure** - the scalable answer to deep config that auto-forms (`AutoField`) do not give you.
10. **State-by-authority rules** (merge don't clobber, optimistic rollback, stale-response guards, foreground-only publishing) - copy the rules, not the 300 stores.
11. **One ConfirmDialog / one notify(), callable imperatively** - consistent asks and toasts with zero per-feature dialogs.
12. **Theme contract in a shared package** - server-resolved skins pushed over the wire plus CSS-var tokens give every surface one theming story.
13. **"Offer, don't hijack" background-event rule** - badges and cached data update; focus and foreground never move without the user.
14. **Gone-session draft rescue** - dead session drops to a fresh draft with the user's unsent text restored, inline and undoable.
15. **Tooltip discipline with a test ban on native `title=`** - cheap, enforceable polish that keeps chrome quiet.

## Lessons for native desktop/Android clients

* **Do not embed a terminal on native.** Hermes embeds the TUI only in the web dashboard;
  the desktop builds a real composer/transcript. On Android, a PTY terminal is a dead end
  (their own `pty-mobile-input.ts` and `keyboard-inset.ts` show the cost); build a native
  message list + composer on the same JSON-RPC contract instead.
* **Port the transport, not the UI.** Kotlin equivalent of `JsonRpcGatewayClient`:
  heartbeat, request timeouts, jittered reconnect with the stable-open rule, replay after
  reconnect, and a handler registry for server->client requests (approval/sudo sheets).
* **Scope every persisted key** (global / connection / profile / session) from day one; the
  profile-rename migration bug family (`migrateTilesForProfile`) shows what happens when you
  do not.
* **Design the offline/reconnect story as states, not spinners**: empty, loading,
  reconnecting (with the deterministic "reconnecting in Ns" ladder the dashboard renders
  from `reconnectBackoffDelayMs(jitter:false)`), degraded/stale, and exhausted-recovery each
  get their own copy and way out (`apps/desktop/AGENTS.md`).
* **Keep agent behavior server-side.** Desktop "never reimplements agent behavior in React";
  the Android app should be a pure client of the gateway so TUI, web, desktop, and mobile
  stay behaviorally identical.
* **Capability negotiation on connect.** The client announces what it answers (approvals,
  file preview, notifications); older clients get a fail-fast instead of a stalled agent.
* **Notifications belong to session events**, not polling: the gateway's event stream plus
  server->client requests maps directly onto Android push/notification channels.
