# ompweb review (kahme247/ompweb) — ideas for the omp dashboard

Reviewed 2026-09-29. Repo: https://github.com/kahme247/ompweb (MIT; forked from
agegr/pi-web). Next.js 14 app + one `omp --mode rpc-ui` child per live session,
SSE for events, reads `~/.omp/agent` session files directly. Very different
architecture from ours (Node vs FastAPI gateway, SSE vs WS, on-disk reads vs
RPC-only), but the feature surface is the most complete of any omp web UI seen
so far. Reviewed at source level: `app/api/**` routes, `lib/**`, DESIGN.md,
CHANGELOG (v0.2.8 -> v0.5.0, ~500 lines).

## What changes our picture of omp (verified against rpc.md)

Two things the Phase 2 review got wrong or missed, now corrected:

1. **Subagents ARE an RPC surface.** rpc.md documents
   `set_subagent_subscription` (off/progress/events), `get_subagents`,
   `get_subagent_messages`, and `subagent_lifecycle` / `subagent_progress` /
   `subagent_event` frames. Our earlier claim "no subagent in rpc.md" was wrong
   (stale grep). ompweb's panel shows: status, tool, retries, tokens/cost per
   subagent, nested tasks, a per-subagent transcript dialog, and history
   recovery after reload.
2. **`branch` is a real RPC command** and ompweb ships session forking on it.
   Live-verified by them: branch accepts a USER entry id only (branching at an
   assistant entry returns `success:false, "Invalid entry ID for branching"`);
   the UI resolves every message to the user prompt that started its turn.
   Also relevant: `abort_retry` exists (retry after abort) — we expose Stop
   (abort) but not retry.

## Ranked ideas to take

1. **Subagent panel** (high value, medium effort; gateway work first).
   Plan panel sibling pinned above the composer: live subagents with status,
   current tool, retries, token/cost, expandable transcript. Gateway needs:
   `set_subagent_subscription: "events"` at session start, forward the three
   frame types on the WS, a `/api/sessions/{id}/subagents` route (registry via
   `get_subagents`), and `/subagents/{sid}/messages` (`get_subagent_messages`).
   ompweb recovers the roster from the parent session file's task toolResults
   `details.progress` / `details.results` when the process is gone — subagent
   transcripts live as `<session-dir>/<subagent-id>.jsonl` siblings of the
   parent file. Our bridge already keeps task toolResults, so the same
   recovery is possible.
2. **Session fork/branch** (high value, small effort). `branch` at a user
   entry creates a new session from any point in the transcript. "Fork from
   here" on the message menu; resolver logic mirrors ompweb's
   `resolveForkEntryIds` (assistant -> its turn's user prompt). No gateway
   change beyond a thin route; our WS/new-session plumbing already exists.
3. **@-file mentions with fuzzy index** (high value, medium effort).
   Composer `@` triggers at line start / after whitespace (emails never
   trigger), quoted form `@"my dir/fi` for spaces, TUI-compatible ranking
   (`scoreEntry` ladder), inserts `@relative/path`. Needs a gateway file-index
   route constrained to the session cwd (ompweb ships
   `/api/file-index` + `directory-browser` with allow-listing; their
   `file-access.ts` is the confinement reference — symlink checks, realpath).
   This is the feature I most want while actually using our dashboard.
4. **Retry** (small). `abort_retry` RPC + a Retry affordance next to Stop for
   failed turns. Pairs with the steer work from P2D.
5. **Per-session usage ledger with breakdowns** (medium value, medium effort).
   Settings -> Usage exists here but is live-session only. ompweb persists
   tokens/cost/cache-savings to SQLite with per-provider/model/day/project
   breakdowns (`provider-usage.ts`). Our gateway already sees per-turn token
   counts in message metadata; a small SQLite sink + a Usage page grouping
   would give real spend visibility across sessions. We already care about
   this (spend-dashboard for Hermes exists).
6. **File explorer + previews** (medium value, high effort, security
   sensitive). Side-by-side workspace browser under the session cwd: code,
   markdown, Mermaid, images, audio, PDF, diffs. Their confinement model
   (allow-list + realpath + symlink refusal) is the right reference. Defer
   behind the @-mention index (same gateway route powers both).
7. **Compaction summary card** (small). On `auto_compaction_start/end` show a
   quiet "compacted, freed ~Xk tokens" row. We already carry the events in
   the reducer; just render them.
8. **Voice input (STT)** (small, optional). Their `/api/stt` posts audio to a
   configured `OMP_WEB_STT_ENDPOINT` (25 MB cap). On mobile this is the
   difference between usable and not. We already run Harper TTS on the output
   side; a matching whisper-style endpoint is trivial for us infra-wise.

## Things to admire but not copy

- **DESIGN.md as a product contract** — their principles ("OMP remains
  authoritative", "no second source of truth") read well; ours (docs/DESIGN.md)
  is a brief, theirs is an architecture contract. Worth a look if docs/ ever
  grows a contributors section.
- **Test culture**: nearly every lib module has a sibling `.test.mjs`, even for
  tiny helpers (type guards, path normalization). We're at 578; their ratio of
  test-to-source files is higher.
- **i18n (EN/zh-CN/ja)** — not our audience.
- **Windows tray / macOS launchd / self-update routes** — we're a systemd
  service; our distribution story is different on purpose.
- **8-tab settings incl. provider API keys, MCP config, skill install/search,
  omp update** — still deliberately out of scope per Phase 2 review (the
  dashboard shouldn't hold secrets in browser reach; `omp config` stays the
  source of truth).

## Where we already win

- WS + replay cursor vs SSE reconnects (theirs can't resume mid-stream without
  refetching entries; our `lastEventSeq` gap flag is cleaner).
- Cookie+CSRF auth with lockout vs optional plaintext password; they warn
  about it themselves in the README.
- Split/unified diff with word marks (Phase 2) vs their preview diffs.
- The plan panel from `todoPhases` including `blocked`+`blocker` states; their
  plan panel is todo-only as far as the source shows.
- Steer lifecycle states (pending/echoed/stale) — theirs has queue controls
  but nothing equivalent surfaced in the source we read.

## Correcting the record for docs/research/omp-companion-review.md

The companion review claimed subagents were unsupported over RPC. rpc.md (and
ompweb's working panel) disprove that. Any Phase 3 planning should start from
the corrected list above.
