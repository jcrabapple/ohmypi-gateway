# omp dashboard redesign: design brief

Status: proposal, awaiting approval. Distilled from four research reports in
`docs/research/` (Hermes desktop + dashboard source, general AI chat apps,
coding-agent UIs, DeepSeek Harness + mobile web). Native client lessons live in
[CLIENTS.md](CLIENTS.md).

The goal, in Jason's words: aesthetically pleasing, simple on the surface,
powerfully featureful and customizable underneath, excellent on desktop and
mobile.

## What the research agrees on

Four independent surveys converged on the same handful of ideas. When every
source says the same thing, that is the design.

1. **The conversation is home.** Everything else (settings, skills, models,
   usage) is a short visit that returns you to the session. Hermes desktop does
   this with route overlays; ChatGPT, Claude and T3 Chat do it with modals and
   side panels. Our current six top-level tabs are the pattern all of them
   moved away from.
2. **Attention is the scarce resource.** With a coding agent the question is
   rarely "what did it say" and usually "which session needs me". Conductor's
   status-grouped inbox, DeepSeek Harness's amber attention dots (blocked
   outranks running) and Claude Code desktop's "waiting for input" filter are
   the same idea three times.
3. **Blocking decisions take over the composer.** DeepSeek Harness replaces the
   input bar with the approval (headline, the exact command, one-tap answers).
   One answer surface, impossible to miss, no modal. Our approval card sits in
   the transcript and can scroll away.
4. **Depth hides behind a trigger grammar, not behind menus.** `/` for commands,
   `@` for context, `!` for shell. Open WebUI, opencode, Zed and Warp all
   converged here. The surface stays a plain text box.
5. **Show the agent's work compactly, with an escape hatch to everything.**
   Tool calls as one-line activity rows that expand; thinking collapsed by
   default; a raw JSON inspector (big-AGI's "AI Inspector") for when you need
   the literal payload.
6. **Always show model, context and cost.** Roo Code, Warp, Zed and Cline all
   put these in persistent chrome. The Roo backlash ("active model not visible")
   is the counterexample.
7. **Stale beats loading.** T3 Chat's local-first cache means navigation never
   shows a spinner. Every source that didn't do this got complaints about it.
8. **Mobile is a supervision surface.** On a phone you read, approve and steer;
   you don't do final code review. Push notification, deep link, one-tap
   answer, done.

## Principles

- **Simple surface, deep floor.** A new user sees a session list, a transcript
  and a text box. Every other feature is one trigger, one chip or one
  keystroke away, never a new permanent panel.
- **Offer, don't hijack** (Hermes). Background events update badges and dots.
  They never move focus, switch sessions or pop panels.
- **One way to ask, one way to tell.** A single confirm dialog, a single toast,
  a single bottom sheet primitive.
- **Every hover has a touch path.** Long-press and overflow menus mirror hover
  actions. Nothing is hover-only.
- **The gateway owns truth.** The client is a cache: merge, never clobber;
  replay on reconnect; never lose an unsent draft or an unanswered approval.
- **Runtime customization.** Theme, accent, density, font, width: user settings
  persisted per device. Never a build step (big-AGI's mistake).

## Information architecture

```
┌ Rail ─────────┬ Session ─────────────────────────────┬ Context (toggle) ┐
│ ◉ Needs you 2 │ header: name · model · ctx 34% · $0.41│ Plan (todos)      │
│ ● Running   1 │ ───────────────────────────────────── │ Subagents         │
│ ○ Idle      3 │ transcript                            │ Stats             │
│ History       │   activity rows, messages             │ Session settings  │
│  Today        │ ───────────────────────────────────── │                   │
│  Yesterday    │ composer  (or approval takeover)      │                   │
│  This week    │ [model][think][mode]  ⏎ send / steer  │                   │
│ ⌘K  ⚙         │                                       │                   │
└───────────────┴───────────────────────────────────────┴───────────────────┘
```

- **Rail**: sessions grouped by attention. *Needs you* (pending approval or
  question), *Running*, *Idle* (live, waiting for a prompt), then *History*
  (saved transcripts, date-grouped, pinned first). Each row: title, cwd
  basename, a status glyph, relative time. Unanswered approvals put an amber
  dot on the row and a count on the group; amber outranks the running spinner.
  "Jump to next needing attention" on a key (`g n`) and in the palette.
- **Session**: header with name, model, context meter, cost; transcript;
  composer. Nothing else is permanent.
- **Context panel** (desktop: right side, toggle `]`; mobile: bottom sheet):
  Plan (live `todoPhases`), Subagents, Stats (tokens, cost, tokens/sec), and
  per-session settings (queue modes, auto-compaction, fast mode).
- **Command palette** (`⌘K` / `Ctrl+K`, mobile: search button in the rail):
  switch session, start session, jump to needing-attention, run any slash
  command, open settings pages, toggle theme. The palette is the power user's
  whole navigation system.
- **Settings overlay**: opens over the session, returns to it on close. Pages:
  Appearance, Agent (structured config.yml forms), Models, Skills, Usage,
  Connection, Advanced (raw YAML). A search box at the top matches every
  setting and deep-links to it (Hermes desktop `settings-search.ts`).

The current Skills, Models, Usage and Config tabs become settings pages. The
current Session tab becomes the Context panel.

## The session view

### Transcript

- **User turns** are right-aligned bubbles. **Assistant turns** are full-width
  documents (LibreChat). It reads like a work log.
- **Markdown rendering** with syntax-highlighted code blocks, copy buttons,
  tables, and collapsible long blocks. (Today we render plain text.) Vendored
  renderer + sanitizer; CSP stays strict.
- **Activity rows**: consecutive tool calls group into a compact block,
  one line per call: glyph, tool name, the human summary (`intent`, command or
  path), duration, status. Tap to expand output. Red is reserved for real
  failures (Hermes rule). Edits render as a diff when the tool result carries
  one.
- **Thinking** collapses into a one-line "thought for 12s" row that expands.
  It follows new tokens only while you're scrolled to the bottom.
- **Streaming**: deltas coalesced per animation frame; auto-scroll disengages
  when you scroll up and a "jump to latest" pill appears (Open WebUI's toggle,
  made automatic).
- **Message actions** (hover on desktop, long-press on touch, hidden while
  streaming): copy, fork from here (`branch`), retry (`/retry`), inspect raw
  JSON.
- **Long transcripts**: `content-visibility: auto` on rows; history paged in
  from the top via `get_messages_page`.

### Composer

- Plain auto-growing text box. Enter sends on keyboards; on touch, Enter is a
  newline and there's a send button.
- **Triggers**: `/` opens the command palette inline, fed by
  `get_available_commands` (71 today: builtins, your skills, extensions, custom
  commands) with fuzzy search and descriptions. `@` mentions files in the
  session's cwd (needs a gateway file-search endpoint). `!` runs a shell
  command through omp's `bash` RPC and shows it as an activity row.
- **Chips** under the box: model, thinking level, approval mode. Dropdowns on
  desktop, bottom sheets on mobile.
- **While the agent runs**, the send button becomes a split button: *Steer*
  (inject now), *Queue* (after this turn), and *Stop*. Queued messages show as
  a small stack above the composer and can be edited or cancelled.
- **Drafts** persist per session in local storage and survive reloads,
  reconnects and a session dying (Hermes "gone-session draft rescue").
- **Paste an image** and it rides omp's prompt `images` field (the gateway's
  prompt endpoint must start forwarding it; see gateway work).

### Approval takeover

When the session has a pending dialog, the composer is replaced by an approval
panel: what omp wants to do (the tool and the exact command or path, with a
diff for edits when available), and the answer buttons omp offered, full-width
and 48px tall. `select` gives one button per option, `confirm` gives Yes/No,
`input`/`editor` give a text box. Multiple pending dialogs queue with a
"1 of 3" counter. Answering on any device clears it everywhere (the gateway's
`ui_resolved`). On Android, a short haptic on answer.

## Visual language

Keep the dark, quiet, terminal-adjacent character you already like. Refine it:

- **Tokens, never literals.** A layered surface scale (page, canvas, surface,
  inset, field), three ink levels, a line and a strong line, one accent, and
  status colors (green done, amber attention, red failure, accent selected).
  Hairline ring shadows instead of heavy borders. Radii 10 / 8 / 6.
- **Type**: system UI sans for chrome and prose, monospace for code, paths,
  commands, numbers (`tabular-nums`). Base 14px desktop, 15px mobile. No web
  font dependency; optionally vendor Inter.
- **Motion**: 150-250ms, ease-out, only for things that move (drawer, sheets,
  panel). `prefers-reduced-motion` turns it off. No shimmer on text.
- **Theme presets**: *Terminal* (current look, green accent), *Graphite*
  (neutral dark, blue accent), *Paper* (light), *High contrast*. Plus a custom
  accent color, density (comfortable / compact), transcript width (reading /
  wide), font for prose (sans / mono), and follow-system light/dark. All
  runtime, per device.

## Mobile specifics

- Viewport meta with `interactive-widget=resizes-content` (Android), plus a
  `visualViewport` hook that publishes `--keyboard-inset` for iOS. The composer
  pads by `keyboard inset + safe-area-inset-bottom`.
- Rail becomes an off-canvas drawer opened by swiping from the left edge as
  well as by the button. Context panel and all pickers are bottom sheets
  capped at the visual viewport height.
- 44-48px touch targets everywhere; `overscroll-behavior: contain` on the
  transcript so pull-to-refresh never fires; blur the composer after send on
  coarse pointers so the reply is visible.
- **PWA**: manifest with maskable icons, a service worker that caches the app
  shell, install prompt on Android, Add-to-Home-Screen instructions on iOS.
- **Web Push for "needs you"**: the gateway pushes when a dialog becomes
  pending and nobody is watching that session; the notification deep-links to
  it. Android Chrome works directly; iOS needs the installed PWA.
- Optional screen Wake Lock while watching a live turn.

## Performance: stale, never loading

- Session list and transcripts cached in IndexedDB. Opening a session paints
  the cached transcript instantly, then reconciles with the gateway via the
  event cursor.
- Navigate on pointer-down. Prefetch the transcript of the session under the
  pointer.
- Streams keep running for sessions you're not looking at (the rail updates).

## Capability map: what omp actually supports

Verified against the live omp 18.4.2 via the gateway, not assumed from docs.

| Feature | Backing | Status |
|---|---|---|
| Slash palette | `get_available_commands` (71 commands incl. skills) | available |
| Plan panel | `get_state.todoPhases` | available |
| Subagent hub | `set_subagent_subscription`, `get_subagents`, `subagent_*` events | available, gateway must subscribe |
| Fork from message | `branch(entryId)`, `get_branch_messages` | available, needs entry ids per message |
| Steer / queue / stop | `prompt` + `streamingBehavior`, `abort` | available |
| Queue policy | `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode` | available |
| Fast mode, auto-compaction | `set_fast_mode`, `set_auto_compaction` | available |
| Retry, export, share, handoff, pin, worktree | `/retry` `/export` `/share` `/handoff` `/pin` `/wt` | available as slash commands |
| Inline shell | `bash` RPC | available |
| Provider login | `get_login_providers`, `login` (OAuth, emits `open_url`) | available |
| Checkpoint / rewind per message | none over RPC | **not available**; omit, or ask upstream |
| "Always allow" on approvals | omp offers only Approve / Deny | **not available**; a gateway-side session rule is possible but is the gateway making security calls, so off by default if built |
| Diff preview in approvals | depends on the tool's dialog text | partial; render when present |

## Gateway work the redesign needs

1. **Web Push**: VAPID keys, `POST /api/push/subscribe`, send on pending
   dialog when no socket for that session is live, prune dead subscriptions.
2. **File search** for `@` mentions: `GET /api/sessions/{id}/files?q=`,
   confined to the session's workspace, respecting `.gitignore`.
3. **Cross-session search**: full-text over saved session transcripts
   (SQLite FTS5 index built incrementally from `~/.omp/agent/sessions`).
4. **Subagent subscription** set to `progress` on every spawned session.
5. **Message entry ids** in `/messages` so the client can call `branch`.
6. **Typed contract**: declare Pydantic response models on every endpoint so
   `/api/openapi.json` generates real TypeScript (and later Kotlin) types, with
   a test that fails on drift (Hermes's single best architecture lesson).
7. **Images on prompt**: forward `images` from `POST .../prompt` to omp.
8. **Explicit replay gap flag** on `/events` and the WS resume frame, so
   clients don't have to infer a backlog overrun from seq numbers.
9. **Changes panel** (later): `git status` / `git diff` for the session's cwd.

## Proposed phases

**Phase 1: new shell and the core loop.** Framework migration (below), token
system and theme presets, attention rail, session header, markdown transcript
with activity rows and collapsed thinking, composer with `/` palette, chips,
steer/queue/stop and drafts, approval takeover, command palette, settings
overlay (current tabs moved in), mobile layout (keyboard inset, drawer swipe,
sheets), PWA shell, IndexedDB cache.

**Phase 2: supervision.** Web Push for approvals, Plan and Subagents panels,
fork from message, message actions and inspector, cross-session search,
structured config forms with settings search, queue-policy and fast-mode
controls.

**Phase 3: power.** `@` file mentions, `!` shell, Changes (git diff) panel,
rebindable shortcuts, custom theme authoring, provider login flow, multi-profile
support (you already run the `layla` and `remy` omp profiles).

## Frontend stack decision

The current dashboard is ~760 lines of Alpine with no build step. Phase 1
roughly triples that, and the same code later ships inside Electron/Tauri and
Capacitor. Options:

- **Svelte 5 + Vite + TypeScript** (recommended): compiled, small bundles
  (good on phones), components and stores that scale, types generated from the
  gateway's OpenAPI. Built with the `bun` already installed; the gateway serves
  the static `dist/`.
- **Stay on Alpine, no build**: zero toolchain, but no types, no components,
  and the file becomes hard to change safely past a couple thousand lines.
- **React**: largest ecosystem (and Hermes's choice), heaviest bundle and the
  most boilerplate for a one-person app.

## Explicitly not doing

- Embedding a terminal (Hermes's own report calls it a dead end on mobile).
- Multi-model side-by-side, marketplaces, personas marketplace, TTS: category
  features that don't serve supervising a coding agent.
- Hidden per-turn background calls (title generation etc.). omp already
  disables auto-titles in RPC mode; keep it that way unless a setting turns it
  on visibly.
