# nibblebot/omp-web review — what to borrow for the gateway

Reviewed 2026-11-17. Repo: https://github.com/nibblebot/omp-web (MIT). Bun +
Solid.js fleet control plane and web UI for oh-my-pi, v0.4.0 (2026-11-12).
Distinct from the earlier kahme247/ompweb review: this is a much larger system
(session processes dial OUT to a stateless control plane; the SDK runs
in-process per session). Read at source level: README, AGENTS.md (engineering
map), CHANGELOG (6 releases), file tree.

## What they do differently (architecture)

Sessions are separate processes bound to a worktree that dial the control
plane (callback pair, credential minted per spawn, digests only). The control
plane holds no agent truth — the session `.jsonl` is durable — so it can
restart without killing sessions; persisted enrollments re-enroll at boot.
Fleet restarts never kill sessions or revoke enrollments.

Our gateway spawns one `omp --mode rpc` child per session and bridge.py:198
already admits the weakness: "gateway restart kills the omp children."

## Ranked borrows

1. **Crash supervision (high value, small effort).** Their one crash policy:
   unexpected exit → revoke dead generation, jittered 1–30s backoff, restart
   with `--resume <lastSessionFile>` and a RestartBudget; past budget show
   `error` + reason. Exit 77 (lock) / 78 (resume-failed) never restart. We
   have `--resume` plumbing; `_on_exit` currently just fails pending futures.
   A supervisor loop in the bridge manager is a day of work and turns any omp
   crash from "session gone" into "reconnected, maybe one turn lost."
2. **Idle sleep/wake instead of reap (high value, medium effort).** Our reaper
   kills idle sessions after 6h. Theirs sleeps them and wakes on open with
   auto-resume: tapping an asleep session transparently resumes it with full
   context. Same primitives we already have (spawn with `--resume`); the
   change is UX — wake-on-attach instead of reap-and-manually-resume.
3. **Background jobs in the UI (high value, medium effort).** SDK 18.11+ job
   tree: `getJobTree`/`getJobDetail`/`cancelJob`; a bash/eval/task call that
   returns while its job keeps running stays on the job (`background` badge,
   live output, final exit state from the `async` field on
   `tool_execution_update`); consecutive `wait` calls fold into one card with
   per-job rows. If a session backgrounds work, our cards currently go stale.
   Also: re-assert `out.enabled` on gateway-spawned sessions (out:// replies
   are off outside the TUI; omp-web pins them on via `out-replies-default.ts`).
4. **Gateway-restart survival, cheap version (medium value, medium effort).**
   Full dial-out inversion is a rewrite — skip it. Middle path: on boot,
   adopt orphaned `omp --mode rpc` children (they publish to the collab
   registry already) instead of only listing them read-only; promote an
   external row to controlled when `collab.autoStart=control`.
5. **Approval bar (medium value, small effort).** Their dedicated approval
   bar: full multi-line prompt, Approve Once / approve-for-session /
   remembered grants (`always-ask-cached`), Esc = Deny, keyboard reachable.
   Concrete reference for our DESIGN brief's "approval takes over the
   composer" item, which is still unimplemented.
6. **Provider usage meters (medium value, medium effort).** Sidebar bars for
   every provider account's rate-limit window with an elapsed-window tick and
   self-refresh. We ledger per-turn cost but show no account quota state.
7. **Static serving upgrades (small value, small effort).** Content-hashed
   immutable `/assets/*`, build-time `.br`/`.gz` siblings served by
   `Accept-Encoding`, ETag/304 for the rest, gzip JSON >1KiB. We serve
   `no-cache` only. Mobile-over-Cloudflare measurable.
8. **Composer add-ons (small each).** `^model` mention completion with effort
   levels; `/btw` steering inject; session log viewer (child stderr to a
   1MiB-rotated file, live view with errors-only filter) for debugging.

## Not worth borrowing

- Dial-out control-plane split (control/ui processes, callback pair,
  generations): rewrite-scale for a single-user gateway; our WS+replay-cursor
  already survives client reconnects better than their browser layer needed
  to before this design.
- Worktree/project fleet management (create/delete worktrees from sidebar,
  git-state sync, clones on bwrap/Kubernetes): real feature, wrong priority —
  we reach for `omp worktree` rarely and git CLI covers the rest.
- Themes-as-data system with contrast solver: our runtime customization
  (design brief) is simpler and sufficient.
- Feature manifest + lazy feature registry, design-system stories, fixture
  demo: pattern to admire, not worth the machinery at our size.
- Command palette, appearance sheet, browser notifications: already in our
  design brief or shipped (Web Push with per-kind policy covers theirs).

## Where we already win (unchanged from the ompweb review)

WS replay cursor, cookie+CSRF+lockout auth incl. origin-checked WS upgrades,
word-level diffs, per-turn usage ledger + transcript search, push policy.
