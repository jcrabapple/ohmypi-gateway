# Phase 3: taken from the ompweb review

Orchestrator: GLM 5.3 (this Hermes session). Coder: glm-5.3-flashx via the
gateway's own omp lane (`dev/run-omp-coder.py`, prompts in `dev/prompts/`,
systemd units). Code review: agy (gemini-3.8-flash-high, blind diff). Same
process as Phase 2: one task prompt per feature, orchestrator verifies with
`bun run check && bun run test && bun run build`, agy reviews the cached diff,
findings go back as numbered fix prompts or get fixed by the orchestrator when
small. Review docs/research/ompweb-review.md for where these came from.

Hard rules (unchanged, see CLAUDE.md): never touch auth-token values, never
restart the production gateway (9315), coder tests on 9325/9326, live probe
sessions must be stopped, orchestrator commits.

## P3A — Subagent panel (gateway + web)

Wire facts (rpc.md, verified):
- `set_subagent_subscription` level off|progress|events; default off. Send
  `{type:"set_subagent_subscription", level:"progress"}` right after v2
  negotiation (progress carries lifecycle + current tool + tokens/cost, and
  it is the cheaper subscription; the panel does not need full text deltas).
- Frames: `subagent_lifecycle`, `subagent_progress`. Payload mirrors omp's
  AgentProgress: all fields optional; parse leniently (see
  `lib/subagent-types.ts` shapes in the ompweb clone at
  $TMPDIR/ompweb, or docs/research/ompweb-review.md):
  id, index, agent, status (pending|running|completed|failed|aborted), task,
  assignment, currentTool, toolCount, tokens, contextTokens, contextWindow,
  cost, durationMs, retryState{attempt,maxAttempts}, model fields.
- `get_subagents` returns the registry snapshot (sorted by index/id).
- `get_subagent_messages` (subagentId?, sessionFile?, fromByte?) returns
  {sessionFile, fromByte, nextByte, reset, entries, messages}. Use for the
  per-subagent transcript dialog, incremental via nextByte.

Gateway (bridge.py + main.py):
1. On `ready` + v2 negotiation, send `set_subagent_subscription level:"progress"`
   (fire and forget via the existing command path, scheduled like _negotiate_v2;
   never inline in the reader loop).
2. Subagent frames already flow through `_publish` (they are ordinary events),
   so WS subscribers get them automatically. No backlog change needed.
3. New routes (all bearer + cookie auth as usual):
   - GET /api/sessions/{id}/subagents -> get_subagents registry snapshot.
   - GET /api/sessions/{id}/subagents/{sid}/messages?from= -> get_subagent_messages
     with subagentId and fromByte; return {messages, nextByte, reset, sessionFile}.
4. e2e checks: subagents route returns 200/JSON on a fresh session (empty
   list is fine); messages route 404s unknown sid.

Web:
5. types.ts: SubagentStatus = pending|running|completed|failed|aborted;
   SubagentInfo (all fields optional + the above); event frame types added to
   the WS event union.
6. lib/state/subagents.svelte.ts: rune store per active session folding
   subagent_progress frames into a Map keyed by id (or index when id absent);
   counts (running, failed); clears on session switch; tolerant of missing ids.
7. components/SubagentPanel.svelte: new tab "Agents n" beside Plan/Activity in
   the right panel (disabled when no subagents ever seen). Rows: agent name,
   task (truncated, title=full), status glyph, currentTool + spinner while
   running, tokens + cost when present, retry badge (attempt/max) when
   retryState present. Click a row -> per-subagent transcript sheet (fetch the
   messages route, render read-only with the existing transcript item
   components, "load more" via nextByte if present).
8. Wire subagent_progress into the store from the WS event handler in
   active.svelte.ts (same place message events land).
9. Tests: store fold (merge, status transitions, clear on switch, missing-id
   keys), panel render (statuses, counts, disabled empty state), messages fetch
   path with mock client, retry badge.

Verification: bun gates green; e2e extended and green on 9326; live check with
a real subagent run (orchestrator provides the session).

## P3B — Session fork (branch)

Wire facts: `{type:"branch", entryId}` accepts a USER entry id only (branching
at an assistant entry fails with "Invalid entry ID for branching"); it returns
the new branch info. `get_branch_messages` reads the branch after the fork.
Entry ids come from the session file entries; our transcript items do not
currently carry omp entry ids, so the gateway must map them.

Gateway:
1. GET /api/sessions/{id}/entries -> `get_entries`-based list of {entryId,
   role} (or extend the existing messages route to include entryId when omp
   provides it; check the `get_messages_page` payload for entry ids first —
   if they are already there, no new route, just expose them).
2. POST /api/sessions/{id}/branch {entryId} -> `branch` command; on success
   return the new session identity so the UI can open it (check what branch's
   response data carries: likely the branch point + session file; the new
   branch shares the SAME session file lineage, so the UI may just need to
   re-fetch messages rather than spawn a new gateway session — verify live and
   document in API.md).

Web:
3. Transcript item context menu (the existing item actions): "Fork from here"
   on user messages (and on assistant messages, resolving to the user prompt
   of that turn — mirror ompweb's resolveForkEntryIds: assistant -> nearest
   preceding user entry; messages with no earlier user entry are disabled).
4. New session appears via re-fetch; show a toast "Forked from <title>"; the
   rail gets the new branch title from session info.
5. Tests: fork-target resolution (user/assistant/no-user cases), menu action,
   toast, disabled states.

Live verify by the orchestrator: create a session, prompt, branch at the user
entry, confirm the response shape, adjust the spec-claimed shape in API.md.

## P3C — @-file mentions (gateway file index + composer autocomplete)

Gateway:
1. GET /api/sessions/{id}/files?prefix= -> directory listing of the session
   cwd, allow-listed: resolve requested path against cwd, refuse escapes
   (realpath containment, refuse symlinks whose target leaves cwd), max depth
   3 below the prefix, max 200 entries per response, no file CONTENTS served
   (index only; names, isDir, size). Dotfiles excluded. Sort dirs first.
2. e2e: traversal probe (`?prefix=../../` or encoded variants) must 403/422.

Web:
3. Composer: `@` triggers autocomplete when at line start or after
   whitespace (never mid-email). Query = text after @; quoted form `@"...`
   supported for paths with spaces. Popup list from the files route (debounced
   150ms, cached per cwd), TUI-compatible ranking: exact prefix > substring >
   fuzzy subsequence, then dirs-first, then path length. Enter/click inserts
   `@relative/path ` (trailing space); Escape dismisses; arrow keys navigate;
   no layout shift (popover anchored above the composer).
4. Keyboard + touch: suggestions are buttons with 44px rows; on mobile the
   popover becomes a bottom sheet (existing Sheet primitive).
5. Tests: extractAtQuery (start/whitespace/quoted/mid-email non-trigger),
   ranking, insertion, route confinement (mock), debounce behavior.

## P3D — Retry failed turns

Gateway:
1. POST /api/sessions/{id}/retry -> `abort_retry` command (timeout 15).

Web:
2. Stop button becomes a two-state control while streaming: Stop (abort,
   exists) and, once the turn has failed (prompt_result status failed/error
   or a late same-id error response), a Retry affordance appears in the
   composer dock + on the failed assistant item ("Retry" chip). Retry calls
   the route and lets the normal event stream refresh the transcript.
3. Tests: retry button visibility states, route call, failure toast on 4xx.

## P3E — Persistent usage ledger

Gateway:
1. SQLite at ~/.local/state/ompgw/usage.db (XDG state dir; create on start):
   table turns(id INTEGER PK, gw_id TEXT, omp_session_file TEXT, model TEXT,
   provider TEXT, ts INTEGER, input INT, output INT, cache_read INT,
   cache_write INT, reasoning INT, total INT, cost_input REAL, cost_output
   REAL, cost_cache_read REAL, cost_total REAL). Write from the bridge where
   assistant usage metadata is observed (per assistant message_end or from
   agent_end messages[] usage — pick the one that does not double-count; a
   turn is one row).
2. GET /api/usage?days=7&group=day|model|provider|session -> aggregated sums
   + counts, default 7 days. Cache savings = cache_read tokens * (input -
   cache_read rate) if rates are knowable; otherwise report cache_read tokens
   raw and label the column "cache read" (no invented savings math).
3. e2e: usage route 200 shape check after one live turn.

Web:
4. Settings -> Usage page extension: totals row, a day-grouped bar chart
   (existing chart primitives if any; plain CSS bars are fine), breakdown
   tables by model and session. Uses the same data fetch as today's
   live-session stats but from the ledger route for history.
5. Tests: aggregation query unit tests (mock db), Usage page render, empty
   state.

## Order + effort

P3A is the big one (gateway subscription + 2 routes + store + panel + sheet);
P3C second (security-sensitive index route); P3B small but needs live
wire verification of branch's response; P3D tiny; P3E medium. Dispatch in
order A, C, B, D, E — A and C can overlap if the lane is idle, but keep one
coder session per task (fix rounds continue the same session).

## Deferred (documented, not built)

- File explorer + previews (needs the P3C index first; confinement reference
  ready when we do it).
- Compaction summary card + STT voice input (next batch).
- Everything rejected in the Phase 2 review stays rejected.
