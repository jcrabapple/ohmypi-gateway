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
    transcript/         pure reducer, Item types, blocks.ts (fold tool runs, progress check)
    render/             markdown -> DOMPurify, highlight.js core, ansi, diff, escape
    composer/           slash filtering, send plan, images, drafts, modes, approval answers
    platform/           storage, idb, keyboard (--kb), haptics, notify, clipboard
    state/              rune stores: auth, sessions (+ grouping), active, nav (hash routes), models, settings, ui
    ui/                 Sheet (native dialog), Popover, Adaptive, Menu, ConfirmDialog, Toasts,
                        Icon, Spinner, Kbd, longpress action, swipe, viewport media flags
    overlays.ts         registry for Task D overlays (palette, settings, session-info, inspector)
    format.ts           basename, time, money, context level, saved-session labels
  components/
    Shell.svelte        rail + main, drawer on narrow screens, edge swipe, keyboard shortcuts, title badge
      Rail.svelte       header, Needs you / Running / Idle, history by day, footer
        RailRow, StatusGlyph, ConnectionDot
      SessionView.svelte
        SessionHeader   inline rename, cwd, model chip, ContextMeter, cost, connection text, overflow menu
        Transcript      auto-follow, jump pill, skeleton / error / gone / empty states
          items/        UserBubble, AssistantMessage, ThinkingRow, ToolGroup (+ToolOutput), SkillChip,
                        CommandCard, NoticeLine, MessageActions
          EmptySession  three starters
        ApprovalPanel   takes over the dock for select / confirm / input / editor
        Composer        textarea, SlashMenu, ImageTray, ComposerChips (ModelPicker), send controls
      Home.svelte       no session selected
    Overlays.svelte     NewSessionSheet, registered overlays, ConfirmDialog, Toasts
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
- Overlays for Task D register with `registerOverlay(id, Component)`; until then their entry points
  toast "Not available yet".
