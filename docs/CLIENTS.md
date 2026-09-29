# Native clients: what the research says for desktop and Android

Companion to [DESIGN.md](DESIGN.md) and [API.md](API.md). This is the file to
read before starting the desktop app or the Android app. Sources are the four
reports in `docs/research/`; the Hermes lessons come from its own source and
`AGENTS.md` postmortems, which are the most battle-tested material we have.

## Recommended path

1. **Build the web dashboard as the real product first**, installable as a PWA
   with Web Push. On Android that already covers most of what a native app
   would: home-screen icon, full screen, approval notifications.
2. **Android: Capacitor, not a TWA, not Kotlin (yet).** A TWA (Bubblewrap) is
   locked to a single origin verified by Digital Asset Links; a self-hosted
   gateway reached at a user-chosen URL breaks that the moment you point it at
   a different server. Capacitor wraps the same web build with no origin lock
   and gives the native bridge we need: FCM push with notification action
   buttons, Keystore credential storage, share intents, a foreground service.
   Rewrite in Kotlin/Compose only if streaming performance or background
   limits ever demand it; a dashboard of lists, text and forms won't.
   (Decision precedent: pi-agent-dashboard's Bubblewrap-vs-Capacitor record.)
3. **Desktop: Tauri or Electron wrapping the same web build.** Tauri is far
   lighter; Electron is what Hermes uses and has the deeper ecosystem. Either
   way, one UI codebase. The shell adds: tray icon with a needs-you count,
   native notifications, a global shortcut to open the palette, optionally
   spawning a local gateway.

This works only if the web app is built for it now: a real component
framework with a build step, all gateway access behind one client module, no
assumption that the page and the gateway share an origin.

## Architecture rules (from Hermes's postmortems)

1. **Declare the wire once, generate every client.** Pydantic models on every
   gateway endpoint and event, OpenAPI generated from them, TypeScript and
   Kotlin types generated from that, and a test that fails when the committed
   generated files drift. This kills a whole bug class across three clients.
2. **One transport module per platform.** TypeScript first, Kotlin later if
   needed. It owns: auth, request timeouts, WebSocket heartbeat, reconnect with
   jittered exponential backoff, the resume cursor, and a registry of handlers
   for server-to-client requests (approvals). No UI code talks to `fetch` or
   `WebSocket` directly.
3. **Stable-open rule for reconnects.** A socket that dies within 5 seconds of
   opening counts as a failed attempt, so a flapping gateway doesn't reset the
   backoff ladder and cause a reconnect storm (Hermes bug #83134).
4. **Replay, don't trust.** After any reconnect, resume from the last seen
   event `seq` (`GET .../events?after=n`, or the WS resume cursor). The backlog
   holds the last 3000 events; if the first returned `seq` is greater than
   `after + 1`, events were dropped, so refetch full state
   (`/state` + `/messages`) instead of applying the delta. Pending approvals are re-delivered by the gateway (`pendingUi`).
   After a long background (minutes), do a full refresh instead of a delta.
5. **The gateway owns truth; the client is a cache.** Merge, don't clobber.
   Optimistic updates show a visible rollback on failure. Guard every async
   response with a generation counter so a slow stale reply can't overwrite a
   newer one.
6. **Scope every persisted key** by authority: global, per connection
   (gateway URL), per profile, per session. Hermes has a whole bug family
   (`migrateTilesForProfile`) from getting this wrong. A client that supports
   several gateways must namespace everything by connection from day one.
7. **Session identity tiers.** omp has a durable id (the session file / `sessionId`)
   and the gateway has a runtime id (`gwId`) that dies with the process.
   Navigate and persist by the durable id; stream by the runtime id; translate
   at the boundary. Resume a saved session with `resumeFrom`.
8. **Durable send.** Keep the user's unsent or in-flight message locally until
   the gateway acks it. A dead session drops to a fresh draft carrying the
   unsent text, with an undoable notice and no focus steal.
9. **Capabilities per session, not per host.** The client should announce what
   it can answer (approval dialogs, file preview, notifications); a client that
   can't answer dialogs shouldn't be the only one attached to an `always-ask`
   session. Planned gateway addition.
10. **Keep agent behavior server-side.** No client re-implements agent logic,
    command lists or config validation. The slash list comes from
    `get_available_commands`; config validation from the gateway. Every surface
    then behaves identically.
11. **Offer, don't hijack.** Background events update badges; they never
    switch the foreground session or steal focus.

## Connection and auth for native clients

- The gateway URL and token are entered once (or scanned from a QR code the
  dashboard shows in Settings → Connection; planned). Token goes in the
  platform keystore (Android Keystore / EncryptedSharedPreferences, OS
  keychain on desktop), never in plain prefs or IndexedDB.
- Native clients use `Authorization: Bearer`. WebSocket auth is the first
  message (`{"type":"auth","token":…}`), because tokens in URLs leak into logs.
- Only a confirmed 401 means "reauthenticate". Timeouts, 5xx and Cloudflare
  errors are connectivity problems and must not log the user out (Hermes
  OAuth corollary).
- A connection test must exercise the WebSocket leg, not just
  `GET /api/health`. Cloudflare and proxies can pass HTTP and still break WS.
- Through Cloudflare: idle WebSockets are cut around 100 s without traffic
  (the gateway heartbeats at 25 s, don't disable it), and a single HTTP request
  must start responding within 100 s, so never block on `wait: true` for long
  prompts; send, then follow the stream.
- If Cloudflare Access is ever put in front, native clients need a service
  token header or the API paths must be exempted.

## Mobile OS behavior to design around

- **Backgrounding kills sockets.** Android and iOS freeze background tabs and
  drop WebSockets. Reconnect on `visibilitychange`/`online` (web) or lifecycle
  resume (native), then replay from the cursor.
- **Push is the real mobile feature.** "Session X needs approval" with
  **Approve / Deny action buttons** on the notification, answered by a
  broadcast receiver calling `POST /api/sessions/{id}/ui/{requestId}`
  without opening the app
  (the MFA-approval pattern). Also "turn finished" for long runs, off by
  default. Web: VAPID Web Push. Android native: FCM. iOS web push needs the
  installed PWA (16.4+), and is restricted in the EU.
- **Foreground service** (Android 14+ requires the declared type) with an
  ongoing notification only while actively following a turn, with a Stop
  action. Don't hold one permanently.
- **Share intent / Web Share Target**: share text or a URL from any app into a
  new prompt. A Quick Settings tile that opens "Needs you".
- **Keyboard**: web needs `interactive-widget=resizes-content` plus a
  `visualViewport` inset for iOS; native gets this from `adjustResize` /
  `WindowInsets.ime`. Either way, pin the transcript to the bottom only if the
  user was already there.
- **Haptics** on approval answers and long-press; nothing on streaming.

## UX that must carry across all three clients

These make it feel like one product:

- Attention-grouped session list: Needs you / Running / Idle / History, amber
  dot outranks running.
- Approval takeover of the composer, one-tap answers, "1 of N" queue.
- Composer chips for model, thinking, approval mode; steer / queue / stop while
  running.
- Activity rows for tool calls, collapsed thinking, raw inspector.
- Same theme tokens and presets (export the token set as JSON so Compose and
  desktop read the same values).
- Same command palette with the same bindings where the platform allows.

## Things other products learned the hard way

- Don't embed a terminal as the chat on mobile; Hermes's dashboard does and
  needed special keyboard and PTY resize hacks to make it barely usable. Build
  a native transcript on the same event stream.
- Don't rotate the login token on every restart (DeepSeek Harness); it breaks
  every bookmarked and installed client.
- Don't gate settings on origin (DeepSeek Harness's loopback-only settings made
  phone admin impossible). Gate on explicit capability with clear UX.
- Don't let two answerers race for one question. The gateway's first-answer-wins
  with `ui_resolved` broadcast is the right shape; keep it.
- Don't let long silent turns look like hangs. Always show a live activity
  line (current tool, elapsed time) so six minutes of work never reads as a
  freeze.
- Remote supervision apps (Happy, Omnara) show the demand: people want to walk
  away from the desk and keep the agent moving from their phone. That loop
  (notify, open, read the ask, answer, pocket) is the Android app's reason to
  exist. Optimize it before anything else.

## Lessons from building the web client (phase 1)

Things the web build proved or tripped over that the desktop and Android apps inherit:

- **Reuse the web client's core, not just its looks.** `web/src/lib/api` (client, stream), `lib/transcript`
  (the pure reducer) and `lib/render` have no DOM or Svelte dependencies in their logic and are covered by
  tests against real captured payloads. A Capacitor or Tauri shell should wrap the same build; a native
  rewrite should port these modules' behaviour and reuse their test fixtures as its conformance suite.
- **History and live events must reduce to the same transcript.** This is the hardest correctness property
  and the one most worth testing in any new client: feed `/messages` and the event stream of the same turn
  through the reducer and compare.
- **Model picker data comes from `/api/catalog/models`**, never the per-session RPC model list (minutes
  slow). Cache it on the device.
- **Session identity is the canonical session file path.** The gateway emits resolved paths; compare them
  as given. Resuming a file that's already live returns `alreadyLive: true` with the existing session, so
  clients can call resume blindly from a history list.
- **Resume lands in the session's recorded folder** (`cwd` on saved entries). If `cwdFallback: true` comes
  back, tell the user their tools are running in the default folder.
- **Anything served through Cloudflare can be edge-cached** unless the gateway says `no-store` with the CDN
  cache headers. Native apps don't have a service worker, but any update-check or config file they fetch
  over plain HTTP needs the same treatment.
- **Cloudflare rejects some encoded paths with 400** before the gateway sees them. Treat 400 from the edge
  as "request refused", not as a gateway validation error.
- **Notifications:** the web app asks for permission only from a user gesture and only fires when hidden.
  The copy "desktop alert" reads wrong on phones; native apps should word it per platform.
- **Keyboard-inset math and 44 px targets** are in `lib/platform/keyboard.ts` and the tokens; the Android
  WebView behaves like mobile Chrome here, so a Capacitor shell gets this for free.
