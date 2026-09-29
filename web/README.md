# ohmypi web client

Svelte 5 (runes) + TypeScript (strict) client for the ohmypi gateway. The
gateway serves the built output from `web/dist` (the old dashboard stays at
`/classic`). Build spec: `docs/PHASE1.md`. Wire contract: `docs/API.md`.

## Run it

Package manager is bun (`~/.bun/bin/bun`, 1.4.x).

```sh
cd web
bun install
bun run dev        # http://127.0.0.1:5183, proxies to the gateway
bun run check      # svelte-check + tsc
bun run test       # vitest
bun run build      # web/dist
bun run scripts/live-check.ts   # against a running `bun run dev`: login, one turn, reducer vs /messages
```

The dev server proxies `/api`, `/auth`, `/healthz`, `/.well-known` and
`/omp-ws` (WebSocket) to `http://127.0.0.1:9315`. Point it elsewhere with
`OMPGW_URL=http://127.0.0.1:9325 bun run dev`. The proxy does not rewrite the
Origin or Host headers on purpose: cookie auth requires Origin to match Host.
Vite's string shorthand (`'/api': url`) turns `changeOrigin` on, which makes the
gateway answer 403 to every login, so `vite.config.ts` spells the proxy out with
`changeOrigin: false`.

Node is not on PATH on this machine. `bun run <script>` puts a `node` shim
(bun itself) first, which is enough for vite, vitest and svelte-check.

## Dependencies

Versions are pinned exactly. Runtime (these ship in the bundle):

| Package | Why |
|---|---|
| `marked` | GFM markdown parser for assistant text. Small, fast, no DOM needed. |
| `dompurify` | Sanitizes marked's HTML before it reaches the page. Model output is untrusted. |
| `highlight.js` | Syntax highlighting. Imported as core with a fixed language list, so the bundle stays small. |

Dev only:

| Package | Why |
|---|---|
| `svelte` | The framework (v5, runes). Compiles away; the runtime is a few KB. |
| `vite` | Dev server and bundler. |
| `@sveltejs/vite-plugin-svelte` | Svelte support for vite, including `.svelte.ts` rune modules. |
| `typescript` | Strict type checking. Pinned to 5.x because bun resolves `latest` to 7. |
| `@tsconfig/svelte` | Base tsconfig recommended by Svelte. |
| `svelte-check` | Type checks `.svelte` files. This is `bun run check`. |
| `vitest` | Test runner, shares vite's config. |
| `happy-dom` | Default DOM for tests. Used instead of jsdom because vitest's jsdom environment crashes under bun ("addEventListener called on an object that is not a valid EventTarget"). |
| `fake-indexeddb` | In-memory IndexedDB for tests. happy-dom has no `indexedDB`, and the stale-while-revalidate cache (sessions list, per-session messages) is only worth testing against a real IndexedDB API: the tests check that cached data paints first and that the network result then replaces it. Test-only, 6.2.5, no runtime cost. |
| `jsdom` + `@types/jsdom` | Only for `render/__tests__/markdown.test.ts`. happy-dom cannot run DOMPurify (its node removal is incomplete, so `<script>` and `<iframe>` survive), so the XSS tests build a jsdom window and hand it to DOMPurify. Constructing `JSDOM` directly works under bun. |

## Layout

```
src/
  main.ts               entry; imports styles, mounts App
  App.svelte            auth gate: spinner or retry while unknown, Login when signed out, Shell when signed in
  styles/
    tokens.css          spacing, type, radii, motion, --kb; no colors
    themes.css          terminal, graphite, paper, contrast via data-theme; ANSI palette
    base.css            reset, focus ring, .sr-only, .spinner, .hit (44px on touch)
    prose.css           markdown, code block, highlight.js and ANSI classes
    components.css      .btn, .icon-btn, .field, .eyebrow, streaming caret, diff lines
  lib/
    api/                fetch wrapper, typed endpoints, wire types, SessionStream (WebSocket)
    transcript/         pure reducer, Item types, blocks.ts (fold tool runs, progress check),
                        changes.ts (per-session file-change roll-up)
    render/             markdown -> DOMPurify, highlight.js core, ansi, diff, escape,
                        diff2 (omp diff parser + per-file extraction), wordmarks
    composer/           slash filtering, send plan, images, drafts, modes, approval answers
    platform/           storage, idb, keyboard (--kb), haptics, notify, clipboard
    state/              rune stores: auth, sessions (+ grouping), active, nav (hash routes), models, settings, plan, reviewed, ui
    ui/                 Sheet (native dialog), Popover, Adaptive, Menu, ConfirmDialog, Toasts,
                        Icon, Spinner, Kbd, longpress action, swipe, viewport media flags
    overlays.ts         registry for overlays (palette, settings, session-info, inspector), openSettings(target)
    keymap.ts           SHORTCUTS table (single source of truth), createKeyMap dispatcher, key labels
    actions.svelte.ts   app-level commands used by shortcuts, palette and menus
    palette/            fuzzy scoring, palette items + ranking, settings search index, rail order helpers
    pwa/                service worker registration (production only)
    color.ts            hex parsing, WCAG contrast, readable ink for a custom accent
    format.ts           basename, time, money, context level, saved-session labels
  components/
    Shell.svelte        rail + main, drawer on narrow screens, edge swipe, keyboard shortcuts, title badge
      Rail.svelte       header, Needs you / Ready for review / Running / Idle, history by day, footer
        RailRow, StatusGlyph, ConnectionDot
      SessionView.svelte
        SessionHeader   inline rename, cwd, model chip, Mark done (when pinned for review), ContextMeter, cost,
                      connection text, overflow menu, "N files changed" button when the session touched files,
                      plan panel toggle
        Transcript      auto-follow, jump pill, skeleton / error / gone / empty states
        PlanPanel       Plan n/m + Activity tabs: phases, progress bar, blocked rows expand, running tools
        PlanRibbon      one-line plan status pinned at the top of the transcript scroll area
        ChangesView     per-session Changes page (route `#/s/<id>/changes`), one DiffBlock per file
          items/        UserBubble, AssistantMessage, ThinkingRow, ToolGroup (+ToolOutput), DiffBlock,
                        SkillChip, CommandCard, NoticeLine, MessageActions
          EmptySession  three starters
        ApprovalPanel   takes over the dock for select / confirm / input / editor
        Composer        textarea, SlashMenu, ImageTray, ComposerChips (ModelPicker), send controls
      Home.svelte       no session selected
    Overlays.svelte     NewSessionSheet, registered overlays, ConfirmDialog, Toasts
    register.ts         registers the four Task D overlays
    CommandPalette, SettingsOverlay (+ settings/ pages), SessionInfoSheet, InspectorSheet
    Login.svelte
scripts/derive-fixtures.py   builds the trimmed test fixtures from dev/fixtures
scripts/live-check.ts        end-to-end check through the dev proxy (see above)
```

Test fixtures live in `src/**/__fixtures__/`. They are derived from the live
captures in `dev/fixtures/` (which stay out of git) with home paths and user
names redacted and long strings trimmed. Regenerate with
`python3 web/scripts/derive-fixtures.py` (from the repo root).

## Things to know

- `active.open(id)` fetches info, then messages, then opens the stream at
  `info.lastEventSeq`. After a resync (`onResync`) the store refetches and
  calls `stream.rebase(info.lastEventSeq)`; the stream holds events until then.
- The reducer takes text from message blocks, never from deltas, and uses
  `role:timestamp` as the key that ties history to live events.
- Remote images in model output render as links, not `<img>` (they would be an
  exfiltration channel, and the CSP only allows `img-src 'self' data: blob:`).

## Foundation changes made in Task C

- `vite.config.ts`: proxy no longer rewrites Host (see above). Dev logins were a 403 before.
- `state/active.svelte.ts`: events are coalesced per animation frame, `queued` is tracked from
  `/state`, and `available_commands_update` refreshes the slash list.
- `state/auth.svelte.ts`: `lockedSec` carries the 429 retry time so Login can count down.
- `state/ui.svelte.ts`: `inspect()`/`inspecting` seam, `error()` toast, `confirm()`.
- `state/nav.svelte.ts` (new): hash routing, resume, `create(body, beforeOpen)`, stop, `lastGone`.
- `state/grouping.ts`: the oldest history bucket is labelled "Earlier" (was "Older") to match the spec.
- `render/diff.ts`: diff output is block spans, so empty lines keep their height.
- `state/models.svelte.ts` (new): catalog cache with retry, `groupModels` for the picker.

## Notes on the UI

- No new runtime or dev dependencies. Component tests mount real components with Svelte's own
  `mount` under happy-dom (`components/__tests__/mount.ts`), so `@testing-library/svelte` is not needed.
- New sessions default to approval mode `yolo`, which is the gateway default. The approval chip in the
  composer is read-only because the gateway sets the mode at start.
- The composer stays mounted (hidden and inert) while an approval is showing so the draft survives.
- Slash menu: Enter or click sends a command that takes no argument; Tab always inserts `/name `.
- Overlays register with `registerOverlay(id, Component)` (see `components/register.ts`).

## Phase 2 A: diff view and Changes page

- `edit` tool results carry omp's line-numbered diff (`lib/render/diff2.ts` parses it; the older
  `diff.ts` heuristic for arbitrary tool output is untouched). Multi-file patches come from
  `details.perFileResults`. `write` results carry no diff, so the reducer synthesizes an
  all-additions diff from the call's `{path, content}`, capped at 60 KB per file. Virtual URIs
  (`xd://`, any `scheme://`) are not file changes and are filtered.
- The reducer stores the computed files on the tool item (`ToolItem.files`), so history replay and
  live events produce identical output; the equivalence tests cover this against
  `transcript/__fixtures__/edits.json`.
- `DiffBlock` renders one file: op badge (A/W/M/D), short path with full title, +/− counts,
  Unified|Split toggle (split by default above 1000 px of container width; created files are
  unified only), word-level marks, syntax highlighting from the file extension, gap rows, 400-line
  cap with "Show all", `content-visibility` per row group.
- `ChangesView` (route `#/s/<id>/changes`, reachable from the header button and the palette's
  "Session changes" action) rolls up every file, latest diff per path, one global mode toggle.

## Task D: power layer and PWA

- **Keyboard.** `lib/keymap.ts` holds one `SHORTCUTS` table. `createKeyMap` dispatches the global
  entries (Shell wires it to `runShortcut` in `actions.svelte.ts`), the Shortcuts settings page and the
  palette hints read the same table. While a text control has focus only Escape and Ctrl/Cmd chords
  fire, so Alt+Up/Down and `/`, `[`, `g n` do not work inside the message box. That is deliberate.
- **Palette.** `lib/palette/palette.ts` builds items and ranks them (pure, tested). `>` narrows to
  actions and settings, `/` to the open session's slash commands. Settings pages are palette items;
  jumping to one setting is done by the search box inside Settings (`settings-index.ts`).
- **Settings.** The Agent config page edits a shared draft (`state/config-draft.svelte.ts`) so it
  survives page switches. Closing settings with unsaved edits goes through `ui.guard` / `ui.tryClose`
  and asks first. Saving is `PUT /api/config` as `text/yaml`; the gateway's validation message is
  shown as is. Tests mock the endpoint and never send a real PUT.
- **Accent.** A custom accent also sets `--accent-ink` from its luminance so button text stays
  readable; the picker warns when the accent is low contrast on the canvas.
- **Offline cache.** `sessionsStore.paintCached` and `active.paintCache` read IndexedDB
  (`platform/idb.ts`) first and then reconcile with the network. Skeletons show only when there is no
  cache. Failed IndexedDB access is ignored (private windows).
- **Service worker.** The source is `sw/sw.js`; the build (`buildServiceWorker` in `vite.config.ts`)
  writes `dist/sw.js` with the routing function from `sw/routing.js` inlined, so there is exactly one
  worker file and a CDN cannot pin a stale second script. The routing function (`navigate` / `asset` /
  `bypass`) stays a plain script so the tests evaluate the exact source that ships. Navigations are
  network-first with the cached `/` as the fallback, `/assets/*` is cache-first, and `/api`, `/auth`,
  `/omp-ws`, `/healthz` are never touched. The cache name carries a build hash stamped into
  `dist/sw.js`; activation deletes every other cache. Registration happens only in production builds
  over a secure context, with `updateViaCache: 'none'`. The gateway serves `/sw.js` with `no-store`
  (plus CDN variants) because Cloudflare edge-caches `.js` files otherwise.
- **Static files.** The gateway serves only root-level files from `dist`, so the manifest and icons
  sit at the root of `public/`; `sw.js` is generated into the root of `dist`.
- **Icons.** `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` and `apple-touch-icon.png` were
  generated once from `static/icon.svg` with ImageMagick (`magick`) and are committed. They are not
  rebuilt by `bun run build`. The maskable icon keeps the glyph inside the safe zone.
