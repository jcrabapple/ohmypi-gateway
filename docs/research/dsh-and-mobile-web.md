# Research: DeepSeek Harness Web UI and Mobile-Web Best Practices for a Coding-Agent Dashboard

Audience: redesign of the ohmypi-gateway web dashboard, which must work well on desktop and mobile today, and later become a desktop app and an Android app.

---

## Part A: The DeepSeek Harness (`dsh`) Web UI

### What it is

DeepSeek Harness (`dsh`) is DeepSeek AI's open-source agent harness, built on an "everything is a plugin" architecture powered by Cordis. Repo: <https://github.com/deepseek-ai/deepseek-harness> (MIT, ~212k stars, developer preview with explicit warnings about breaking changes). `npx @deepseek-ai/dsh web` starts the Web UI at `http://127.0.0.1:3080`. Docs site: <https://deepseek-harness.github.io/deepseek-harness/>. Jason ran it publicly behind a Cloudflare tunnel with his own mobile CSS overlay, and retired it on 2026-09-28.

### Architecture and UX concepts

The interesting thing about dsh is that its UX surface is a thin adapter over a set of well-named interaction seams. From `packages/interaction/README.md` (<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/README.md>) the human-facing product packages are:

| Package | Role | ctx key |
|---|---|---|
| commands | Registers and dispatches human slash commands | `ctx.commands` |
| user-approval | Coordinates one-shot approval decisions | `ctx.approval` |
| permission-presets | Named bundles of sandbox mode + approval policy | `ctx.permissionPresets` |
| user-questions | Provider-neutral human question/answer seam | `ctx.userQuestions` |
| tool-ask-user | Exposes those questions to the model | `ctx.tools` |

Key UX concepts the web client implements:

1. **Sessions as first-class objects.** Sessions are append-only event logs (`~/.dsh/sessions/<workspace>/<id>/session.v4.jsonl.zstd`), replayable, resumable, with a durable `session/end-seed` boundary. The sidebar shows per-session live status. Session titles come from `dsh-session-title`.

2. **Approvals as one-shot answerable prompts.** The `approval/request` waterfall dispatches a decision to whatever adapter can answer (browser tab, Telegram gateway, ACP). The web wire contract reserves `approval/requested` / `approval/resolved` mux frames, and the proxy replays still-pending approvals on reconnect, so a refresh never loses an unanswered prompt (`.agents/notes/implemented/feature/2026-07-23-web-permission-and-approval.md`, <https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-07-23-web-permission-and-approval.md>).

3. **Pending approval takes over the composer.** Instead of a toast or modal, the ApprovalPanel replaces the InputBar with the justification headline, the paired command, and one-shot refuse/allow buttons. User questions and plan-review decisions use the same "take over the composer" mechanism. This is the single most distinctive UX decision in dsh.

4. **Sidebar attention dots.** The sidebar mirrors every blocked interaction with an amber warning dot that outranks the running spinner, and it tracks per-session approval/question identities rather than reading Session instances. Sessions never opened still light their dot. This is exactly the "which session needs me right now" problem every agent dashboard has.

5. **Permission presets.** Two named presets ship by default: `workspace-write` (sandbox `workspace-write` + approval `ask`) and `danger-full-access` (sandbox full + approval `never`), rendered as one selector chip in the composer's bottom row. Unmatched knob combinations derive a display-only `custom` state that can never be selected. Presets are pinned per session at creation; changing the default never mutates a live session (<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/permission-presets/README.md>).

6. **Loopback-only settings plane.** Settings pages (Models, provider directory, credentials, config editing) load only from a loopback origin. The client resolves persistence as `host` on loopback and `memory` otherwise; remote pages get "settings are unavailable in this browser". This is a deliberate security boundary because the settings plane exposes API keys. Remote configuration is done via SSH port forward, which makes the page loopback. This was the source of repeated misdiagnosis while dsh was deployed publicly (see the dsh-web skill notes).

7. **Auth via rotating token.** Every restart mints a new `?token=` login token; the cookie is SameSite=Strict, so a token link opened from another site lands on "authentication required".

8. **Brand/theme package** (`dsh-brand`) owns visual identity as a plugin, consistent with the everything-is-a-plugin philosophy.

### What seemed good

- Composer takeover for approvals and questions is unmissable and has exactly one answer surface. No buried modals.
- Replay of pending approvals on reconnect: refresh-safe by design.
- Sidebar attention dots with clear priority (blocked beats running).
- Fail-closed approval seam: no answerer means "unavailable", not silent allow.
- Settings plane deliberately loopback-only. Keys never ride the tunnel.
- Permissions pinned per session, so a global change never surprises a running task.

### What seemed clunky (observed by Jason plus upstream notes)

- The web UI was desktop-shaped. Jason had to write his own mobile CSS overlay to make it usable on a phone, and still disliked it enough to retire the deployment.
- The login token rotating on every restart broke bookmarks and share links constantly.
- The loopback-only settings boundary, while correct, made remote admin from a phone painful: Termux SSH port-forward is the only sanctioned path.
- The Telegram gateway answered nothing during a long tool-heavy turn (6+ minutes of silence looked like a hang), and answerer ordering mattered: the web adapter could capture a question the phone never saw.
- Deep config (`cordis.patch.yml` per profile, `web` vs `headless` drift) is powerful but easy to get wrong.

### Lessons to carry into the redesign

Steal: composer takeover for blocking decisions, replay-on-reconnect, sidebar attention dots, per-session permission pinning, fail-closed approvals. Avoid: restart-rotating tokens (use stable sessions plus re-auth), settings that depend on origin (use explicit capability gating with clear UX), and adapters that race each other for the same pending question.

---

## Part B: Mobile-Web Best Practices for Chat/Agent Apps (2025-2026)

### Viewport and virtual keyboard

The core failure mode: a bottom-anchored composer disappears under the on-screen keyboard. `100dvh` tracks the URL bar but not the keyboard.

- Add `interactive-widget=resizes-content` to the viewport meta. On Android Chrome this shrinks the layout viewport when the keyboard opens, so `dvh` and fixed `bottom: 0` elements ride up with it. (<https://stackoverflow.com/questions/77812591/>)
- iOS Safari ignores that directive. Use `window.visualViewport`: publish `--keyboard-inset` as `layoutHeight - vv.height - vv.offsetTop` on `resize` AND `scroll`, coalesced with `requestAnimationFrame`. Guard against pinch-zoom (`vv.scale > 1`) and ignore insets under ~120px (collapsing URL bar, not a keyboard). (<https://www.observerviewport.com/core-observer-fundamentals-browser-apis/visual-viewport-and-mobile-viewport-units/handling-the-mobile-virtual-keyboard-with-visualviewport/>)
- The VirtualKeyboard API (`navigator.virtualKeyboard.overlaysContent = true` + `env(keyboard-inset-height)`) is Chrome-Android only; treat it as progressive enhancement, never the baseline. (<https://ishadeed.com/article/virtual-keyboard-api/>)
- A real-world reference implementation: Agenta PR #6169, which combines the meta directive for Android with a `useVisualViewportHeight` hook for iOS, and blurs the editor after send on `(pointer: coarse)` so the keyboard closes and the reply is visible. (<https://github.com/Agenta-AI/agenta/pull/6169>)
- When the keyboard opens, shrink the transcript container by the inset and re-pin `scrollTop` to bottom via ResizeObserver, but only if the user was already at the bottom. Never yank a user reading history.

### Layout and safe areas

- Use `dvh`/`svh` for full-height shells with the visualViewport variable as the keyboard-aware override, and `env(safe-area-inset-bottom)` padding on the composer so the home indicator never overlaps it: `padding-bottom: calc(var(--keyboard-height, 0px) + env(safe-area-inset-bottom, 0px))`.
- Keep the chat column within `100vw`: `min-width: 0` on flex children, `overflow-x` containment on code blocks, and let composer controls (model picker, permission chip, mic, send) wrap or truncate. The nanobot WebUI issue #4693 and PR #4694 catalogue exactly these overflow failure modes. (<https://github.com/HKUDS/nanobot/issues/4693>)
- Touch targets: 44-48px minimum. Open WebUI's mobile complaints are dominated by too-small sidebar items and double-tap requirements. (<https://github.com/open-webui/open-webui/issues/18966>)

### Navigation patterns on mobile

- Off-canvas drawer for session list, opened by swipe-right from the edge, not only by a top-left button (two-hand reach problem, per the Open WebUI feedback above).
- Bottom sheets for secondary actions (model picker, permission preset, attach): thumb-reachable, cancellable by swipe-down, and capped at the visual viewport height so they never extend under the keyboard.
- Bottom tabs only if the app has 3-5 peer destinations; a chat/agent app usually has one primary surface (the session) plus a drawer, so tabs are optional.
- Guard against pull-to-refresh hijacking vertical scroll inside the transcript (`overscroll-behavior-y: contain` on the scroll container). Long-press menus on messages should mirror the desktop context menu. `navigator.vibrate()` gives cheap Android haptics for long-press and approval confirmation; it is ignored on iOS.

### PWA installability and push

- Manifest: `name`, `short_name`, `start_url`, `display: standalone`, `theme_color`, `background_color`, icons at 192 and 512 plus maskable. Service worker with a `fetch` handler is required for Chrome's `beforeinstallprompt`.
- iOS has no `beforeinstallprompt`; show explicit Add to Home Screen instructions and detect `navigator.standalone`. Provide `apple-touch-icon` (180px) and `apple-mobile-web-app-capable`. (<https://openpwa.net/reference/installation/ios-add-to-home-screen/>)
- Web Push: works on Android Chrome out of the box; on iOS 16.4+ only for home-screen-installed PWAs, with permission requested from a user gesture and `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` using VAPID. Every push must show a notification. Prune subscriptions on 404/410. For an agent dashboard this is the killer feature: "session X needs approval" push that deep-links to the session. (<https://openpwa.net/reference/notifications/web-push/>)
- Note the iOS 17.4 EU caveat: Apple has restricted PWA push in the EU under DMA pressure.
- Wake Lock (`navigator.wakeLock.request('screen')`) while watching a long-running agent turn; re-acquire on `visibilitychange` back to visible.
- Share Target (`share_target` in the manifest) lets Android share text/URLs straight into a new prompt.

### Backgrounding and reconnect

Mobile browsers freeze background tabs and kill WebSockets. Design the stream like dsh did: the server owns truth, the client reconnects and replays missed events (per-connection generation, pending interactions replayed verbatim on reopen). Implement exponential-backoff reconnect on `online`/`visibilitychange`, and treat "backgrounded for N minutes" as a full state refresh, not a delta resume.

### Performance for long streaming transcripts

- `content-visibility: auto` with `contain-intrinsic-size` on message rows skips rendering offscreen history.
- Virtualize past a few hundred messages; render markdown incrementally into a stable tail node instead of re-parsing the transcript per token.
- Throttle streaming DOM updates to animation frames; coalesce token deltas.
- Respect `prefers-reduced-motion` for streaming animations and `prefers-color-scheme` for dark mode, with an explicit theme override stored per user.

### How the incumbents do it

- ChatGPT mobile web/PWA: bottom-anchored composer that grows upward, model picker as a compact chip in the header, off-canvas left drawer for history, streaming with auto-scroll that disengages on user scroll-up.
- Claude: similar bottom composer, artifacts open as a side/bottom panel, minimal chrome, aggressive safe-area handling.
- Open WebUI: a genuine installable PWA with admin-configurable manifest (`EXTERNAL_PWA_MANIFEST_URL`) and opt-in push, but its mobile UX has long-standing complaints: tiny touch targets, drawer only via top-left button, double-tap selection, header/composer hiding during scroll. These are the anti-patterns to avoid. (<https://github.com/open-webui/open-webui/issues/18966>, <https://github.com/open-webui/open-webui/issues/2840>)

### What the Android app should do differently

- FCM push for "approval needed" / "turn complete" with notification actions (Approve / Deny) handled by a broadcast receiver so the user never opens the app for routine decisions, exactly the MFA approve/deny pattern. (<https://deepwiki.com/pingidentity/pingone-sample-app-android/4.1-push-notification-authentication>)
- Foreground service (or WorkManager long-running worker with `setForeground()`) with an ongoing notification while an agent turn is being actively followed, with a cancel action. Declare the foreground service type; Android 14+ enforces it. (<https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running>)
- Share intents to start a prompt with shared text/URL, and a Quick Settings tile to jump to "sessions needing attention".
- Secure storage (EncryptedSharedPrefs / Keystore) for server credentials instead of IndexedDB.

---

## Top 15 mobile ideas, ranked

1. Composer takeover for blocking decisions (approvals, questions) with one-tap answers. Direct steal from dsh.
2. `interactive-widget=resizes-content` meta plus a visualViewport `--keyboard-inset` hook for iOS. This is the highest-value, lowest-effort fix.
3. Push notifications for "session needs you" with deep links (VAPID web push now, FCM in the Android app).
4. Swipe-right edge gesture to open the session drawer; no top-left-button-only navigation.
5. Sidebar session list with attention dots that outrank running indicators, replay-safe on reconnect.
6. Server-owned event log with replay-on-reconnect; backgrounded-tab full refresh after N minutes.
7. Bottom-sheet model picker and permission-preset selector instead of header dropdowns on mobile.
8. Safe-area-aware, bottom-anchored composer: `calc(var(--keyboard-height,0px) + env(safe-area-inset-bottom,0px))`.
9. Blur the composer after send on `(pointer: coarse)` so the keyboard closes and the reply is visible.
10. Virtualized, `content-visibility: auto` transcript with frame-throttled streaming.
11. 44-48px touch targets everywhere; single-tap selection; long-press for context menus.
12. PWA manifest plus install guidance, with explicit iOS Add-to-Home-Screen instructions and `navigator.standalone` detection.
13. `overscroll-behavior-y: contain` on the transcript to stop pull-to-refresh fights.
14. Haptic feedback on Android (`navigator.vibrate`) for long-press and approval confirmation.
15. Wake Lock while actively watching a live agent turn; re-acquire on visibility return.

## Recommendation for the Android app path

Ship the PWA first with full push support; it covers Android well and iOS acceptably, and it is the same codebase as the desktop redesign. For the native step, prefer **Capacitor** over a TWA/Bubblewrap wrapper and over a full Kotlin rewrite. The decisive argument comes from a directly analogous decision record (pi-dashboard, another per-user self-hosted agent dashboard, <https://github.com/BlackBeltTechnology/pi-agent-dashboard/blob/develop/docs/research/mobile-app-bubblewrap-vs-capacitor.md>): a TWA is locked to one verified origin via Digital Asset Links, and a self-hosted product reached through dynamic tunnels and per-user origins breaks fullscreen the moment the user navigates to their own server. Capacitor bundles the web UI in a WebView with no origin lock, adds the native bridge we actually need (FCM push with Approve/Deny actions, secure credential storage, share intents, foreground-service notification), covers iOS for free, and keeps one codebase. Reserve a Kotlin/Compose rewrite for the day streaming performance or background-execution limits genuinely demand it; a dashboard that is mostly lists, text, and forms will not hit that wall soon. The same reasoning applies to desktop: an Electron/Tauri shell wrapping the same web app beats a separate desktop codebase.
