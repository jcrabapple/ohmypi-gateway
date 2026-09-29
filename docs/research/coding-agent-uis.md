# Coding Agent UI/UX Research: What to Steal for the omp Dashboard

Research compiled September 2026 from public docs, READMEs, changelogs, reviews, and issue trackers. Purpose: inform the redesign of the oh-my-pi (omp) web dashboard and later desktop + Android apps. The omp gateway exposes sessions, prompt/steer/abort, streaming events, approval dialogs, todos, stats, branching, slash commands, subagents, and config over REST+WebSocket, so every UI idea below is mapped to those primitives.

---

## 1. How products show agent work

### Tool calls

The consensus pattern is **card-based tool rendering with a compact/expanded toggle**.

- **opencode** renders tool calls inline in the conversation; `/details` toggles execution details between compact and expanded; thinking blocks are hidden by default and toggled with `/thinking` ([docs](https://opencode.ai/docs/tui/)).
- **Goose** renders tool calls as inline cards with tool name + args, a status indicator (pending/loading/success/error), collapsible results, and visual grouping of consecutive tool calls; long histories batch-render to avoid UI lock; distinct Compacting state shown in the header ([deepwiki](https://deepwiki.com/aaif-goose/goose/6.1-chat-interface-and-message-rendering)).
- **OpenHands** streams tool calls into chat as events alongside a resizable dual-pane "Agent Canvas": chat left, tabbed tool panel right (Files, Changes, Commits, Terminal, Browser, Planner, embedded VS Code, live App preview) ([docs](https://allhandsai.mintlify.app/openhands/usage/key-features), [deepwiki](https://deepwiki.com/All-Hands-AI/OpenHands/4.4-conversation-tabs-and-main-layout)).
- **omp's own TUI** already does differential card rendering (`pi-tui`) with per-tool cards, so the dashboard should preserve the card vocabulary.

### Diffs and file edits

- **Pre-apply preview beats post-hoc review.** **Crush** renders the proposed edit as a diff (unified or split, toggleable, fullscreen) inside the permission dialog *before* you approve ([deepwiki](https://deepwiki.com/charmbracelet/crush/5.6-commands-and-models-dialogs)). **Zed** has the opposite acknowledged gap: approving ACP edit tool calls is blind, "approve first, review later" ([discussion #47695](https://github.com/zed-industries/zed/discussions/47695)). omp already previews edits before landing (`ast_edit` "proposed N replacements" card + Accept card): keep and foreground this.
- **Cline** renders every edit as an inline diff you can review, modify, or revert before applying ([README](https://github.com/cline/cline)).
- **Zed** offers a Review Changes multi-buffer (⇧⌃R) with per-hunk accept/reject, plus optional inline keep/reject overlays per file, and "Follow the agent" jumps the editor to each touched file ([docs](https://zed.dev/docs/ai/agent-panel)).
- **OpenHands** Changes tab: side-by-side Monaco diffs with status icons, plus a Commits tab; file/diff caches auto-invalidate on agent edit events for near-real-time updates.
- **Claude Code web/desktop**: session diff with file list left, changes right, inline line comments that bundle into the next message, "Create PR" button; desktop adds Accept/Reject per diff and a "Review code" self-review button ([web quickstart](https://code.claude.com/docs/en/claude-code-on-the-web)).
- **Codex app**: right sidebar shows diffs and uncommitted changes; clicking a diff row leaves feedback that feeds the next agent turn.
- **opencode** exposes per-session diffs via API (`GET /session/:id/diff`) and configures stacked vs side-by-side by width.

### Terminal output, todos, subagents, status

- **Terminal**: opencode's `!` prefix runs bash from the composer and injects output as a tool result. OpenHands embeds a full Terminal tab. Claude Code desktop has an integrated terminal pane plus an embedded dev-server Preview that Claude can screenshot and click.
- **Todos/plans**: opencode makes todos first-class session state; plan mode is a read-only agent toggled with Tab and indicated in the footer. OpenHands shows a dynamic Task List tab plus an always-on Planner tab. omp has phase-tracked todos (`get_state.todoPhases`): render as a persistent plan panel, not transient chat lines.
- **Subagents**: opencode gives subagents child sessions (`GET /session/:id/children`). Goose links "View subagent session" from subagent tool calls. **omp's Agent Hub (Alt+A)**: roster of live subagents with per-agent status/cost/duration, live transcripts, steer, revive/kill: is a genuine differentiator; opencode users complain about slowdowns with many subagent tabs and no good supervision surface.
- **Cost/token/context meters**: Roo Code's task header shows tokens, cache usage, API cost, and context window. Warp puts a Context Usage chip on the composer toolbelt. Zed puts a token meter near the model selector. Crush tracks cumulative tokens/cost per session in SQLite with "~" markers for estimates. Cline tracks cost per request and per task loop in the header. Verdict: a persistent task header with tokens + cost + context-usage is table stakes.

## 2. Human-in-the-loop

- **Permission modes are tiered everywhere.** Goose: `auto` / `approve` / `smart_approve` (read-only auto, writes confirmed, with an LLM PermissionJudge classifying safety) / `chat`, plus per-tool AlwaysAllow/AskBefore/NeverAllow overrides ([deepwiki](https://deepwiki.com/block/goose/6.2-permission-modes-and-tool-approval)). opencode: allow/ask/deny per-tool, per-agent, wildcard patterns, last match wins ([permissions](https://opencode.ai/docs/permissions/)). Cline: granular auto-approve toggles per action class plus a cap on API requests before re-asking. Warp: Agent Profiles with allow/deny command lists.
- **Approval dialog shape**: opencode offers once / always / reject, where "always" whitelists tool-suggested patterns (e.g. `git status*`) for the session. Crush: Allow / Allow-all-for-session / Deny with the diff in the dialog. Codex auto-review can route approval to a second reviewer agent; denials overridable once via `/approve`.
- **Notifications**: opencode has an `attention` config (desktop notifications when blurred, per-event sounds for question/permission/error/done/subagent_done). Zed: OS notification + sound when generation finishes or agent waits. Warp: in-app + system notifications, vertical tabs show attention-needed status per session. Conductor: macOS notifications, sound on completion, distinct icons for "plan approval" vs "user input needed."
- **Remote/mobile approval**: Claude Code Remote Control (`/rc`) bridges a local session to claude.ai/code and the Claude mobile app over outbound HTTPS; push notifications for "when Claude decides" and/or "when actions required," suppressed while typing, QR pairing ([docs](https://code.claude.com/docs/en/remote-control)). See section 4.

## 3. Session management

- **Parallel sessions + worktrees**: Conductor is the reference: one workspace = one git worktree + branch per task, each with its own chat, terminal, diff, run scripts, and review state ([workflow](https://www.conductor.build/docs/workflow)). Claude Code desktop gives each session its own worktree in `~/.claude/worktrees/`; Remote Control supports up to 32 concurrent sessions with `--spawn worktree`. Codex app: project → thread hierarchy, each thread an agent in its own worktree, switched like browser tabs. Zed: per-thread worktree isolation picker in the title bar. omp's `task` tool already fans subagents into isolated worktrees: surface this in the UI.
- **Inbox of sessions needing attention**: Conductor's sidebar groups workspaces by status with counts, bold titles when awaiting response, unread indicators, and a ⌘K palette with "jump to next session needing attention" ([changelog 0.39.0](https://www.conductor.build/changelog/0.39.0-insta-summarize-command-palette-opus-4-6)). Claude Code desktop filters the session sidebar by status ("waiting for input", running, failed) and groups by project, with Verbose vs Summary view modes for background sessions. Codex app has a review queue collecting results from parallel agents and scheduled automations. This is the canonical multi-agent attention model.
- **Checkpoints/undo**: Zed puts a "Restore Checkpoint" button on every message that caused edits, revertible even mid-generation. Cline checkpoints every step with Compare and Restore (workspace-only or task+workspace). Roo: git-based checkpoints rendered inline in the conversation. opencode: `/undo` and `/redo` revert messages and file changes via Git, with server-side revert/unrevert. omp has checkpoint/rewind: expose per-message checkpoint buttons.
- **Branching/forking**: opencode: `POST /session/:id/fork` forks at any message. Goose: fork from any user message. Warp: `/fork`, `/fork from <point>`, `/compact`, `/fork-and-compact`. Zed: "New From Summary" compaction handoff. omp RPC has branch/get_branch_messages: build a branch picker on any message.
- **Resume/handoff**: opencode: `/resume`, plus `opencode attach <url>` so a TUI attaches to a web server sharing sessions. Crush: `crush serve` lets multiple clients share sessions, permission queue, and LSP state. Claude Code: `--cloud` pushes local → cloud, `--teleport` pulls cloud → local, `/desktop` moves CLI → desktop. Codex: delegate local → cloud from the IDE, preview cloud diff, apply locally; cloud-to-local sync continues on mobile.

## 4. Mobile/remote control patterns

What actually works on a phone for supervising a coding agent:

- **The loop**: push notification → deep link into the paused session → review compact diff/question → approve/reject/steer via quick text or voice → agent resumes. Voice is genuinely used for hands-free approval during commutes.
- **Happy** (happy.engineering, open source): wrapper CLI streaming E2E-encrypted to iOS/Android/web; push for permission requests, approve/deny from phone, QR pairing, worktree selection at session creation, inline diffs, optional paid voice assistant ([site](https://happy.engineering/)).
- **Omnara**: CLI wrapper relaying session files to web/mobile via SSE; opt-in push notifications deep-link into the paused session; replies by text or a two-way voice agent; mobile-optimized diff rendering; localhost dev-server previews on the phone without tunnels ([HN](https://news.ycombinator.com/item?id=44878650)). Caveat: conversations stored on Omnara's servers.
- **Codex mobile** (inside the ChatGPT app, May 2026): pairs to a running desktop host via QR; the phone is purely a control/review surface: start threads, follow-ups, answer questions, approve/reject commands and diffs, switch models, inspect evidence (diffs, screenshots, terminal output, test results). Execution stays on the host.
- **Claude mobile**: Remote Control push for permission prompts; cloud sessions monitored from the Claude app's Code tab.

Design rule for the Android app: read + approve + steer, not full review. Mobile diffs are compressed, fine for checkpoint approvals, not final merge review.

## 5. Composer features

- **@mentions**: opencode fuzzy file mention with `@alias` roots; Zed mentions files/dirs/symbols/threads/skills/diagnostics/branch diffs/URLs and auto-formats pasted selections as mentions; Cline/Roo/Warp all support @file mentions.
- **Slash commands**: universal. opencode `/`; Crush merges system actions, user commands, and MCP prompts into one commands dialog; omp has get_available_commands: render a palette.
- **Image paste**: opencode drag-and-drop, Zed paste/drag, Goose attachments + voice dictation.
- **Queued messages/steering**: Roo explicitly queues messages while the agent works; Zed has queued messages with optional "Steer" (interrupt between steps); Warp and Codex support mid-task interrupt/question/redirect; omp RPC has steering/follow-up/interrupt queue modes: the composer must expose "send now vs queue vs steer" explicitly.
- **Model/mode switchers**: opencode `ctrl+x m` + variant cycling; Zed model selector with favorites + token meter; Crush mid-session model switching preserving context + reasoning-effort picker; omp has model and thinking switching over RPC plus nine model roles.
- **Inline bash**: opencode `!` prefix; omp RPC has a bash command.

## 6. Criticisms to avoid

- **opencode**: TUI flicker/blank screens, severe slowdowns in long sessions with many subagent tabs, unscrollable permission prompts under load ([issues](https://github.com/sst/opencode/issues/3935)).
- **Cline**: token cost ("a long session can cost more than an hour of junior-developer time"); auto-approve toggles moved into a modal, called "a huge downgrade in UX" ([issue #7430](https://github.com/cline/cline/issues/7430)).
- **Roo Code**: complexity backlash: "buttons everywhere," "too many modes, zero mastery," active model not visible in the UI, lossy context compaction, surprise costs ($47 afternoons).
- **Conductor**: worktrees aren't sandboxes (agents run with user permissions); parallel dev servers eat local resources; per-workspace dependency reinstalls add setup cost.
- **Claude Code**: "You can't review code in a terminal": CLI diff rendering pushes users to desktop/web for review; Remote Control dies with terminal exit, initially Max-tier only.
- **Codex**: cloud execution means code leaves your machine; restrictive Plus-tier limits; macOS-first launches alienate Linux users.
- **Crush**: no prompt history at launch, no cost dashboard, higher token burn.
- **Omnara**: privacy tradeoff (server-side message storage), notification-storm bug on resume.

Recurring lessons: keep permission controls one click away (never in a modal); show the active model and live cost always; keep the attention surface single and flat (one inbox, not seven tabs); don't ship Linux-last.

---

## Top 15 ideas to steal, ranked

1. **Status-grouped session inbox with "jump to next needing attention"** (Conductor): the single most valuable multi-agent pattern; maps directly to omp session states.
2. **Diff inside the approval dialog** (Crush): pre-apply review beats Zed's blind-approve gap; omp already previews edits, so wire previews into extension_ui_request approvals.
3. **Per-message checkpoint restore buttons** (Zed): revert even mid-generation; trivial over omp checkpoint/rewind.
4. **Persistent task header: tokens + cost + context usage** (Roo/Warp): table stakes; session stats endpoint already provides it.
5. **Fork-from-any-message** (opencode, Goose, Warp): omp branch/get_branch_messages makes this cheap.
6. **Subagent hub with per-agent status/cost/steer/kill** (omp Agent Hub, brought to web): omp's differentiator vs opencode's known pain point.
7. **Push-notification approval loop on mobile** (Happy, Claude Remote Control): notify → deep link → approve/steer → resume.
8. **Queued vs steer send modes in the composer** (Zed/Roo/Warp): maps to omp steering/follow-up/interrupt queue modes.
9. **Tiered permission modes with per-tool pattern memory** (Goose smart_approve + opencode always-patterns): "always allow `git status*`" is beloved.
10. **Todo/plan as a persistent side panel** (OpenHands Task List, opencode plan mode): render get_state.todoPhases live.
11. **Inline diff comments that become next-turn feedback** (Claude Code web, Codex app): high-leverage review loop, cheap to build on branch+prompt.
12. **Tabbed tool panel beside chat: Files / Changes / Terminal / Preview** (OpenHands Agent Canvas): organizes everything that isn't conversation.
13. **@mentions for files and more, slash-command palette, image paste** (Zed/opencode): composer baseline via get_available_commands.
14. **Attention notifications per event type with typing-aware suppression** (opencode attention config, Claude RC presence file): avoids notification storms (Omnara's bug).
15. **Session attach/multi-client** (opencode attach, crush serve): desktop app, web dashboard, and phone as peers on the same gateway session.

## omp features the dashboard should expose

| Surface | RPC/event backing |
|---|---|
| Session list + inbox (spawn, resume, stop, filter by waiting/running/failed) | sessions REST, streaming status events |
| Conversation stream with tool-call cards (compact/expanded) | message deltas, tool_execution_start/update/end |
| Thinking blocks, collapsible | thinking events |
| Approval dialogs with diff preview, once/always/reject | extension_ui_request (select/confirm/input/editor) |
| Todo/plan side panel with phase progress | get_state.todoPhases, todo state events |
| Subagent hub: roster, live transcript, steer, kill | set_subagent_subscription, subagent_lifecycle/progress events |
| Task header: tokens, cost, context usage; auto-compaction notice | session stats, auto_compaction event |
| Composer: prompt, steer, follow-up, abort; queue-mode selector | prompt/steer/follow_up/abort RPC |
| Model + thinking switchers; fast-mode toggle | set_model, set_fast_mode |
| Branch/fork picker on any message | branch, get_branch_messages |
| Slash-command palette | get_available_commands |
| Config editing (permissions, models) | config.yml endpoint |
| Skills/browser, models browser, usage dashboard | skills, models, usage endpoints |
| Share/export transcript | export_html RPC |
| Handoff between surfaces (web → desktop → phone) | handoff RPC |
| Inline bash from composer | bash RPC |
| Auto-compaction toggle | auto-compaction toggle RPC |
| Login/provider management | login providers RPC |
