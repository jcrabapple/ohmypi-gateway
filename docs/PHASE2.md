# Phase 2: stolen-from-omp-companion feature set

Orchestrator: GLM 5.3 (this Hermes session). Coder: glm-5.3-flashx via
OpenRouter, driven through an omp session spawned by this gateway. Code
review: Gemini 3.8 Flash (`agy`). Source analysis:
`docs/research/omp-companion-review.md` (data shapes verified against the
live gateway 2026-09-29).

Phase 1 context is in `docs/PHASE1.md` (build conventions), `CLAUDE.md`
(coder rules), `web/README.md` (stack + folder map). Phase 2 follows the same
conventions: Svelte 5 runes, TS strict, bun, no new dependencies without
justification in `web/README.md`, tokens-only styling, mobile-first.

Roadmap order: P2A (diff view, biggest value, pure web) -> P2B (plan panel,
gateway + web) -> P2C (session states + archive, small) -> P2D (steer states,
reducer-only) -> P2E (image magic bytes + working status, gateway + web).
P2A and P2B touch different files except `SessionView`/`SessionHeader`
mounting points; run them sequentially anyway since both are large.

---

## P2A: Diff view for edit results + per-session Changes page

**Goal:** edit/write tool results render as real diffs (unified/split,
word-level marks, per-file stats); a session-level "Changes" view rolls up
every file the session touched.

**Verified data shapes** (probe 2026-09-29 through our own gateway):

- `edit` toolResult `details`: `{diff: " 1|alpha\n-2|beta\n+2|delta\n 3|gamma",
  firstChangedLine, op: "update", path, oldText, newText}`. Multi-file
  patches: `details.perFileResults: [{path, op, diff}]`.
- `write` toolResult `details`: `{resolvedPath}` only; no diff. The write
  tool CALL's `arguments` carry `{path, content}`; a synthetic all-additions
  diff can be built from them, capped (their cap: 60 KB per file).
- omp routes some writes to virtual URIs (`xd://...` and any
  `scheme://` path); those are not file changes; filter
  `/^[a-z][\w+.-]+:\/\//i`.

**Reference implementation** (read it, port the good parts, credit the idea):
omp-companion `local-dist/app.js` lines 634-760: `parseDiff` (their format:
` N|context` = old line N, `-N|removed`, `+N|added`, blank lines split hunks,
lines starting `...` are gap notes), `blocks()` pairing del/add runs,
`wordMarks()` (common prefix/suffix; bail when >70% of both strings changed),
`diffTable()` with split/unified modes, created-file detection (all adds and
first add line number 1 -> unified, badge "A"; op write/create), gap rows
`... line N`, per-file `+adds -dels`, copy-path button, `extLang()` for
syntax highlight language from the path.

**Files (all under `web/src`):**

- Create `lib/render/diff2.ts`: `parseOmpDiff(diff: string): {hunks:
  {lines: {t:'ctx'|'add'|'del', o?: number, n?: number, text: string}[]}[],
  adds: number, dels: number}` (keep the existing `diff.ts` lookLikeDiff
  fallback untouched; this is the structured parser). Pure, no DOM.
- Create `lib/render/wordmarks.ts`: `wordMarks(a, b): [Range, Range] | null`.
- Create `lib/render/__tests__/diff2.test.ts` + `wordmarks.test.ts`: the
  verified probe diff parses to 1 hunk, 1 add, 1 del; multi-hunk (blank-line
  split); gap-note lines; wordMarks cases (no change, full change >70%,
  prefix+suffix middle change).
- Create `components/items/DiffBlock.svelte`: renders ONE file's diff.
  Header: op badge (A/W/M/D), short path (last 3 segments, full on hover
  title), `+adds -dels` colored, Unified|Split segmented toggle (per block,
  default split >1000px else unified; created files always unified and no
  toggle), copy-path button. Body: the diff table, syntax-highlighted
  (reuse `lib/render/highlight.ts` core registration; add language mapping
  from file extension), `+`/`-` row tinting, `<mark>` on word-level changed
  ranges, gap rows `... line N`, `... ` gap notes, `content-visibility: auto`
  per row group, first 400 lines rendered then "Show all".
  Escape all text (no `{@html}` of raw diff; highlighting goes through the
  existing escaped highlight pipeline).
- Modify `components/items/ToolOutput.svelte`: when the tool item's
  `raw.details.diff` (or `perFileResults`) exists, render `DiffBlock` per
  file instead of the current ANSI-ish pre; keep the plain pre for non-diff
  outputs and errors. Tool row summary for edit/write gains a `+n -m` stat
  chip when available.
- Modify `lib/transcript/reducer.ts` + types: on `tool_execution_end` /
  toolResult, if `details.diff` or `details.perFileResults` present, store
  `files: {path, op, diff, adds, dels, created}[]` on the tool item
  (computed in `diff2.ts` so the component is dumb). For `write` tool CALLS
  (from the assistant message `toolCall` block, `arguments.content`), store
  a synthesized diff when there's no result diff, capped at 60 KB. History
  replay (`/messages`) must produce the same `files` (test against
  `dev/fixtures/messages.json` shape: toolResult details arrive in history
  too).
- Create `components/ChangesView.svelte` + route `#/s/<id>/changes`: rolls
  up ALL file items from the transcript state, grouped by path, latest diff
  per path wins, header `N files - M edits, +total -total`, Unified|Split
  global toggle, per-file DiffBlocks, back link to the session. Reachable
  from: SessionHeader action button `N files changed` (only when N > 0),
  palette action "Session changes", and a click on a DiffBlock's path when
  in the Changes view is no-op (already there).
- Tests: reducer files extraction (edit result, write synthesis, perFile,
  virtual-path filtering, created detection), DiffBlock mount (modes toggle,
  badge, counts), ChangesView grouping. `bun run check/test/build` green.

## P2B: Plan panel (todoPhases)

**Goal:** right-side panel showing omp's task plan with progress; slim ribbon
above the transcript showing the active step.

**Verified shapes:** `get_state` -> `todoPhases: [{id, name, tasks:
[{id, content, status: 'pending'|'in_progress'|'completed'}]}]`,
`contextUsage` already used. Gateway passes state through unchanged (probe:
`/api/sessions/<id>/state` mirrors omp's state), but our web types have
`todoPhases: unknown[]`.

**Gateway (small):** none required. Do NOT add new endpoints; the state
poll we already do carries todoPhases.

**Files:**

- Modify `lib/api/types.ts`: `TodoTask {id: string; content: string;
  status: 'pending'|'in_progress'|'completed'}`, `TodoPhase {id: string;
  name: string; tasks: TodoTask[]}`, `SessionState.todoPhases:
  TodoPhase[]` (treat unknown entries defensively: unknown status -> pending).
- Create `lib/state/plan.svelte.ts`: rune store deriving from the active
  session's state: `phases`, `done/total` counts, `activeTask` (first
  in_progress, else first pending), `hasPlan`.
- Create `components/PlanPanel.svelte`: right panel, tabs `Plan n/m` and
  `Activity` (Activity tab content: existing tool events summary - reuse the
  transcript's tool grouping logic read-only; keep it minimal: list of
  running tools with spinners). Plan tab: `n of m complete` + progress bar,
  phases as sections (name + icon per task status: check, target/ring,
  empty), completed tasks struck through muted, active task accent-bordered,
  clicking a task's content does nothing (read-only). Collapse/expand with
  the panel (persist open state per device in settings store). On <900px the
  panel becomes a full-height sheet opened from a header button.
- Create `components/PlanRibbon.svelte`: single line pinned above the
  transcript (inside the scroll area top): `Plan n/m -> first 60 chars of
  active task` when active, hidden when no plan. Click -> opens PlanPanel.
- Modify `components/SessionView.svelte`: mount PlanRibbon + PlanPanel;
  add the header toggle button (target icon).
- Modify `components/Rail.svelte` + `lib/state/grouping.ts`: a session with
  an in_progress task reads as working (spinner glyph) even between
  agent turns.
- Tests: plan store derivation (phases, counts, activeTask, empty),
  PlanPanel render (sections, strike-through, active highlight), ribbon
  show/hide.

## P2C: Session states: Ready for review + Mark done + archive

**Goal:** finished sessions read as "Ready for review", not Idle; Mark done
action; per-device archive to hide history rows.

**Semantics:**

- `readyForReview`: derived client-side (no gateway change): a live session
  that is not streaming, has pendingUi empty, has at least one assistant
  message, and whose last turn ended without an error (we track last
  `session_settled` + `prompt_result.status` in the sessions store). It's a
  UI grouping overlay on top of the existing live data; do not add gateway
  state for it. A session leaves the state when the user sends a new prompt
  or an approval arrives.
- `Mark done`: client-side too, for phase 2 (omp has no done concept over
  RPC): sets a per-device `doneAt` timestamp (storage `device` scope,
  `done:<gwSessionFile>` keyed by the canonical omp session file). Row moves
  to Done with a green dot and stops counting as ready-for-review. Undo
  available in the row's overflow menu. Document in `web/README.md` that
  done is a dashboard-side marker only.
- Archive: per-device `archived:<file>` set; archived rows hidden from
  History (still reachable via palette search with an "archived" tag and an
  Unarchive action; the file itself is never touched). Cannot archive a
  live session (guard + toast).

**Files:**

- Modify `lib/state/sessions.svelte.ts` (derived states + settle
  tracking), `lib/state/grouping.ts` (new group order: Needs you -> Running
  -> Ready for review -> Idle -> Done -> History), `components/Rail.svelte`
  + `RailRow.svelte` (state chips/dots, overflow menu: Mark done / Undo,
  Archive / Unarchive), `components/SessionHeader.svelte` (Mark done button
  when readyForReview).
- Tests: grouping order, readyForReview derivation (settled after assistant
  message, cleared on new prompt / approval), archive guard on live.

## P2D: Steer lifecycle (pending -> echoed -> dropped, resend)

**Goal:** honest steer UX. omp reads steers at tool/turn boundaries; unread
steers are dropped at turn end.

**Verified behavior** (rpc.md + companion's handling): the client's steer
message shows immediately (optimistic user item, `note: steer`); omp echoes
it back via `message_start` role user when the agent actually reads it;
if the turn ends first, the steer is never echoed and never applied. Our
reducer currently dedupes the echo but treats silence as success.

**Files:**

- Modify `lib/transcript/types.ts`: `UserItem.note` gains
  `'steer-pending' | 'steer-read' | 'steer-dropped'` (string union widened).
- Modify `lib/transcript/reducer.ts`: on local steer send -> item
  `steer-pending`; on echo (`message_start` user matching the sent text,
  existing dedupe path) -> `steer-read` (and, as in companion, MOVE the item
  to the position omp actually saw it, since steers surface at the boundary);
  on `session_settled` / `turn_end` / `prompt_result` end-of-turn -> any
  remaining `steer-pending` becomes `steer-dropped`.
- Modify `components/items/UserBubble.svelte`: badge per state ("Steering -
  waiting for a break", "Steered in", "Dropped - send again" with a resend
  button that re-queues the same text via steer).
- Tests: full lifecycle, multiple concurrent steers (order preserved), echo
  matching by trimmed text (images: match by "Image attached" when no
  text), drop on turn end.

## P2E: Image magic-byte validation + working status

**Gateway:**

- Modify `gateway/main.py` prompt images validation: after base64 decode
  (existing size/mime checks), verify magic bytes: PNG `89 50 4E 47 0D 0A 1A
  0A`; JPEG `FF D8 FF`; WebP `RIFF....WEBP` (bytes 0-3 RIFF, 8-11 WEBP); GIF
  `GIF87a`/`GIF89a`. Mismatch -> 422 with a clear message. Keep the 4-image
  and 5 MB caps.
- Modify `tests/e2e.py`: bad-magic probe (valid base64 PNG-labeled data that
  is actually text) -> 422, good PNG passes through.
- docs/API.md: one line on magic-byte validation.

**Web:**

- Modify `components/Transcript.svelte` working status line: while
  streaming, if the last event arrived >20s ago show "Waiting for the model -
  no activity for 45s" (computed from the last event timestamp in the active
  store; update on a 5s tick), after 120s add the quiet style + title hint
  "No events for a while. If it never recovers, Stop and resend." Reuse the
  existing spinner. No new dependencies.
- Tests: status label thresholds via fake timers.

## Out of scope for phase 2 (recorded, not built)

Advisor UI, subagents/background jobs panel, worktree isolation, structured
settings editor, plugin manager, one-click omp update (never through the
public tunnel), native history model enrichment (may fold into P2C archive
work later if trivial).

## Execution protocol

1. Orchestrator (me) writes per-task coder prompts from these specs into
   `dev/prompts/p2a.md` ... `p2e.md`, including the CLAUDE.md rules by
   reference, the relevant fixture shapes, and the TDD loop.
2. Coder lane: `dev/run-omp-coder.sh <task>` spawns an omp session
   (`~/projects/ohmypi-gateway`, model `z-ai/glm-5.3-flashx` via OpenRouter,
   yolo) driven through this gateway with the bridge protocol; the task
   prompt file is the session's first message. The coder edits only
   `web/` (+ `gateway/`, `tests/`, `docs/API.md` for P2E), runs
   `bun run check/test/build` itself, and reports. Never grant it repo-wide
   trust: its cwd is the repo, but the CLAUDE.md rules apply to any agent;
   verify after each run with `git status --short` + `git diff --stat`.
3. Review gate per task: `agy` (gemini-3.8-flash-high, `--mode plan`,
   from /tmp, NO `--add-dir` of the repo unless read-only; embed the diff in
   the prompt) reviews the diff against the task spec; findings return to
   the coder lane as a follow-up omp message in the same session; second
   review pass after fixes. UI-critique reviews (DiffBlock, PlanPanel visual
   quality) go to Kimi K3 via OpenRouter per `code-review-routing`.
4. I verify myself: `bun run check/test/build`, `tests/e2e.py` on 9326 for
   gateway tasks, a real browser pass in the harness for each UI piece
   (diff render against a live edit, plan panel against a session with
   todoPhases, states on the rail), then commit per task on
   `phase2` branch (cut from master at `a9b136f`).
5. Ship: merge `phase2` -> `master`, build, restart `ohmpi-gateway` (check
   live sessions first), run `tests/e2e.py https://gateway.example.com`.
