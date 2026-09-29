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
```

The dev server proxies `/api`, `/auth`, `/healthz`, `/.well-known` and
`/omp-ws` (WebSocket) to `http://127.0.0.1:9315`. Point it elsewhere with
`OMPGW_URL=http://127.0.0.1:9325 bun run dev`. The proxy does not rewrite the
Origin header on purpose: cookie auth requires Origin to match Host.

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
  App.svelte            placeholder: login, then a plain list of live sessions (Task C replaces it)
  styles/
    tokens.css          spacing, type, radii, motion, --kb; no colors
    themes.css          terminal, graphite, paper, contrast via data-theme; ANSI palette
    base.css            reset, focus ring, .sr-only, .spinner, .hit (44px on touch)
    prose.css           markdown, code block, highlight.js and ANSI classes
  lib/
    api/
      client.ts         fetch wrapper, ApiError, signed-out event, base URL
      endpoints.ts      one typed function per gateway route
      types.ts          wire types, written against dev/fixtures
      stream.ts         SessionStream: WebSocket, resume cursor, dedupe, backoff, watchdog
    transcript/
      reducer.ts        pure reduce(state, input): history and live events share one code path
      types.ts          Item union, TranscriptState, TranscriptInput
    render/
      markdown.ts       marked -> DOMPurify -> highlighted code blocks with copy buttons
      highlight.ts      highlight.js core, fixed languages, no auto-detect
      ansi.ts           SGR colors to spans, everything else stripped
      escape.ts
    platform/
      storage.ts        localStorage keys: ompgw:v1:<origin>:<scope>:<key>
      idb.ts            keyval store for list and transcript caches
      keyboard.ts       publishes --kb from visualViewport
      haptics.ts        tap() on coarse pointers
      notify.ts         desktop notifications while the tab is hidden
    state/              rune stores: auth, sessions (+ grouping), active, settings, ui
    ui/                 primitives (Task C/D)
  components/           feature components (Task C/D)
scripts/derive-fixtures.py   builds the trimmed test fixtures from dev/fixtures
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
