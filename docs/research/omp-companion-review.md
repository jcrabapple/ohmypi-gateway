# omp-companion: review and takeaways

Source: github.com/ataberkus/omp-companion (read in full: companion/server.mjs 598
lines, local-dist/app.js 1,840 lines, tests, screenshots). Reviewed 2026-09-29.
It's a localhost-only Node control room for omp using the same RPC protocol we
speak (`--mode rpc-ui`). One author, day-old repo, Windows-first. Their dashboard
is a prebuilt no-framework JS bundle.

## Where we already match or win

- Same core insight: sessions as an attention queue ("NEEDS YOUR REVIEW" group
  floats on top) = our Needs you / Running / Idle / History rail. Validated.
- They poll `/api/state` every 4 s and rerender everything; we have a real
  WebSocket with replay. Ours is the better transport.
- Their auth: random per-launch token in the URL fragment (`#token=`), which
  leaks into shared links and screen shares, no lockout. Ours: HttpOnly cookie +
  CSRF + lockout, no tokens in URLs. Ours is the right posture for a
  tunnel-exposed host.
- Their markdown is a hand-rolled renderer piped into innerHTML. Ours is
  marked + DOMPurify with XSS tests.
- Their UI is one theme, magenta, no mobile story worth the name. Ours: four
  themes, mobile-first composer, PWA.

## Worth stealing (ranked)

1. **A real diff view for edit results.** Their best feature. omp's `edit` tool
   results carry a line-numbered diff (`" 1|alpha"`, `"-2|beta"`, `"+2|delta"`)
   plus `op`, `path`, `perFileResults` for multi-file patches. VERIFIED: our
   gateway already receives this (probe 2026-09-29, `/messages` toolResult
   details: `diff`, `firstChangedLine`, `op`, `path`, `oldText`, `newText`).
   They render it GitHub/VS Code style: split and unified modes, word-level
   marks on changed tokens, per-file +/- counts, created-file detection (new
   files get unified mode so split isn't half empty), gap rows between hunks,
   `xd://` virtual paths filtered out. Our ToolOutput currently colour-codes
   raw diff text; this upgrades it to a first-class component, plus a per-session
   "Changes" roll-up: every file touched by the session, grouped by path with
   total adds/dels, one click to review all edits. This is the highest-value
   item and it needs no gateway change.
2. **Plan panel from `todoPhases`.** `get_state` returns `todoPhases`
   (phases > tasks with `content` + `status`: pending/in_progress/completed).
   We already poll state but type it `unknown[]`. Their presentation: right
   panel with progress ("3 of 5 complete"), done items checked and struck
   through, active item highlighted, plus a slim "Plan 3/5 -> current task"
   ribbon pinned above the transcript so the goal never scrolls away. Also a
   rail-dot treatment (task in progress = working state).
3. **Session lifecycle states.** They distinguish queued / working /
   ready-for-review / idle / error / done, with a "Mark done" action. The
   interesting part is *ready for review*: when the agent finishes a turn and
   the session sits idle, it's not "idle", it's "finished, look at me". We
   detect the same moment (`session_settled`) but collapse it into Idle. Worth
   adding as a rail state + a quiet "done" marker so finished work ages out of
   the attention group visually.
4. **Steer lifecycle honesty.** Steers wait for a tool/turn boundary; omp echoes
   them via `message_start` when actually read, and silently drops them if the
   turn ends first. They mark steers pending -> (echoed, moved to the position
   the agent saw them) -> dropped, and offer a resend. Our reducer dedupes the
   echo but has no pending/dropped steer state. Cheap fix in the reducer,
   honest UX.
5. **Image magic-byte validation.** They verify PNG/JPEG/WebP/GIF magic bytes
   after base64 decode, so a renamed `.exe` can't ride the `images` field. We
   validate base64 + mime label only. Straightforward hardening for our prompt
   endpoint (they also cap one image at a time; our 4-image limit is fine).
6. **"No activity for Xs" working status.** While running, they show "Waiting
   for the model - no activity for 45s" and go quiet after 120 s with a
   tooltip suggesting Stop + resend. Better than a bare spinner on slow turns.
7. **Archive/hide for the session list.** Archiving a row hides it without
   deleting the transcript. Our history list grows unbounded (50+ test sessions
   already); a per-device archive flag would keep the rail useful. They also
   gate it: can't archive a running session.
8. **Native history enrichment.** For dead sessions they show model/thinking
   from the transcript (scan head + tail for `model_change` /
   `assistant.provider/model`), plus last-context tokens from the final usage
   entry. Our saved list shows title + cwd + mtime; model on history rows is a
   nice touch and we already read the head bytes.

## Situational (only if the use case shows up)

- **Advisor support.** omp has an advisor concept: a second model that reviews
  each turn, notes arriving as custom messages (`customType: 'advisor'`,
  `details.notes[]` with severity nit/concern/blocker). They surface it as a
  composer chip + collapsed review groups + a config read from `WATCHDOG.yml`.
  If Jason ever enables advisors, this is the pattern. Until then it's dead UI.
- **Subagents / background jobs panel.** They subscribe
  (`set_subagent_subscription: 'progress'`) and render a registry; they also
  scan session files for async bash jobs and `task` subagents with status.
  Our gateway doesn't subscribe. Only matters for long parallel work.
- **Worktree isolation per session.** They can start a session in a throwaway
  git worktree (`git worktree add -b omp-web/<id>`), never auto-merged.
  Attractive for risky tasks, but it changes where files land and needs a merge
  story. Not phase 2.
- **Structured settings editor.** `omp config list --json` gives types,
  descriptions, enum options; they diff against a defaults run to flag
  modified settings and mask secret-ish keys (token/secret/password/apikey
  suffix match). Our raw YAML editor is honest but unfriendly; a structured
  view with search is a good future Settings page. Their plugin manager
  (install/enable/disable) and one-click `omp update` we should NOT expose
  through the public tunnel without a second thought; that's remote code
  installation. Keep those CLI-only.

## Things to avoid

- Polling the full store and rerendering everything (theirs) vs our event
  stream.
- Token in URL fragment.
- No request body cap discipline (they have one; we already cap).
- Their frontend source is a prebuilt bundle edited directly; the repo even
  says "the frontend source isn't in this repo". We keep our source in the
  repo, which is why we can test it.

## Data-shape notes (verified against our gateway)

- edit toolResult details: `{diff: " N|ctx / -N|old / +N|new", firstChangedLine,
  op: "update", path, oldText, newText}`; multi-file patches: `perFileResults:
  [{path, op, diff}]`; write toolResult: `{resolvedPath}` only (no diff; they
  synthesize a fake all-additions diff from args.content, capped at 60 KB).
- `get_state`: `todoPhases: [{id, name, tasks: [{id, content, status}]}]`,
  `contextUsage: {tokens, contextWindow, percent}` (we already use contextUsage).
- Steer echo arrives as `message_start` with role user; omp drops unread steers
  at turn end (their `dropSteers`).
- Subagent frames exist in the protocol (`subagent_lifecycle`,
  `subagent_progress`, `get_subagents`, `get_subagent_messages`), subscription
  defaults to off.
