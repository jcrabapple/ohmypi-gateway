# UX Research: General-Purpose AI Chat Web Apps

Research to inform the redesign of the oh-my-pi (omp) dashboard: a web client for a terminal coding agent exposed over HTTP/WebSocket. Goals: simple surface, deep power, excellent on desktop and mobile, and a design language that can carry over to a desktop app and an Android app later.

Apps surveyed: Open WebUI, LibreChat, LobeHub (LobeChat), big-AGI, plus ChatGPT, Claude.ai, and T3 Chat as polish references. Sources are docs, READMEs, feature pages, and user complaints (Reddit/GitHub/forums), cited inline.

---

## 1. Open WebUI

The dominant self-hosted chat UI. Famously feature rich, famously sprawling.

**Navigation / IA**
- Sidebar with pinned chats, folders, and archived chats; folders can be upgraded into "project workspaces" with their own system prompt and attached knowledge bases ([chat features docs](https://docs.openwebui.com/features/chat-conversations/chat-features/)).
- Chat list search supports full-text plus tag filters via `tag:name`; pagination at 60 chats per page ([chat interface guide](https://www.mintlify.com/open-webui/open-webui/features/chat-interface)).
- Rebindable keyboard shortcuts, managed in Settings > Keyboard. This is rare in the category and directly relevant for an omp power-user dashboard.
- Chat-input command grammar: `/` for commands and prompts, `@` for models and context, `#` for knowledge/files, `$` for skills, `:` for emoji. Built-in slash commands like `/status` (context usage, queued messages, running tasks, chat ID) and `/fork` map almost one-to-one onto what a coding-agent dashboard needs.

**Chat UX**
- Multi-model side-by-side comparison, message queue (keep typing while the model responds; messages auto-send), edit + resend, regenerate, conversation branching, structured editing of assistant turns that contain tool calls and reasoning (each output item becomes its own collapsible field, with a raw JSON toggle) ([features](https://docs.openwebui.com/features/)).
- Per-message rating (thumbs up/down with custom tags) feeding analytics about which models respond better.
- Renders markdown, LaTeX, mermaid, tables, and auto-detected HTML/SVG artifacts; code blocks get copy buttons and can be auto-collapsed ([message rendering](https://deepwiki.com/daw/open-webui/3.2-message-rendering)).
- Auto-scroll is a toggle ("Response Auto-Scroll" off lets you read earlier content while the rest streams). Small, but power users love it.

**Customization**
- Interface settings: chat bubbles vs document style, wide-screen mode, chat direction LTR/RTL, show username, custom background, streaming fade effect, collapsing code blocks, haptic feedback on mobile ([settings guide](https://dev.to/admantium/open-webui-complete-guide-to-user-settings-1ci4)).
- Model presets: wrap any base model with a system prompt, bound tools, knowledge, and parameters; dynamic variables like `{{ USER_NAME }}` injected automatically; per-chat, per-account, or per-model chat parameters.

**Progressive disclosure**
- The good pattern: the composer is dead simple (type, send) and depth lives behind trigger characters (`/`, `@`, `#`, `$`) and per-message hover actions.
- The bad pattern: a giant settings surface with dozens of toggles and 200+ environment variables ([reference](https://docs.openwebui.com/reference/)). Users routinely report being overwhelmed and report hidden per-turn overhead: background calls for title generation, tag generation, and follow-up suggestions slow every response, and disabling them is buried in admin settings ([Reddit thread](https://reddit.sentinel-team.org/posts/1uy50kf/snapshots/2026-07-16T18%3A55%3A39.061383Z)).

**Mobile**: usable PWA, but the density of the desktop UI does not translate; users praise it mainly relative to even-clunkier alternatives ([forum thread](https://www.aitalkboard.com/deepseek-forum/which-web-ui-is-best-for-self-hosting-deepseek-53624/)).

## 2. LibreChat

The most "ChatGPT-clone-like" of the self-hosted apps, with strong search and agents.

**Navigation / IA**
- Sidebar conversation list plus integrated Meilisearch: typo-tolerant, as-you-type search over conversation titles, tags, and message contents, opening directly to the matching conversation ([search docs](https://www.librechat.ai/docs/features/search)). Full-text message search is the feature self-hosted users ask for most and ChatGPT-class apps still do poorly.
- Presets: save and load predefined conversation settings (endpoint, model, params) from the composer ([user guides](https://www.librechat.ai/docs/user_guides)).

**Chat UX**
- Clear layout split: user turns are right-aligned bubbles, assistant turns are full-width document style. Actions reveal on hover or keyboard focus, hidden while a response is still streaming ([message actions](https://www.librechat.ai/docs/features/message_actions)).
- Fork from any message; edit, rerun, continue, read-aloud, feedback.
- Agent runs support Steer / Queue / Interrupt-and-steer mid-run, with quoted excerpts that survive reconnects and even server restarts. This is the single best reference for omp's approval-and-steering flow: a coding agent that pauses for approval is structurally the same as an agent run that accepts mid-run steer messages.

**Agents / power features**
- No-code Agent Builder: instructions, files, tools, capabilities per agent ([agents docs](https://www.librechat.ai/docs/features/agents)).
- Deferred tools: tools excluded from context until discovered at runtime via a ToolSearch tool. Programmatic tool calling inside a code sandbox. Subagents with isolated context that return compact results. All directly analogous to omp's skill/tool model.
- Per-message API-key prompting: if the admin has not configured web search, users are prompted for their own keys in the UI rather than failing. Good progressive-disclosure-of-credentials pattern.

**Criticisms**: handling of reasoning/"thinking" tokens has historically been worse than Open WebUI's; users report wall-of-text thinking output ([forum thread](https://www.aitalkboard.com/deepseek-forum/which-web-ui-is-best-for-self-hosting-deepseek-53624/)). Configuration is YAML-heavy and intimidating.

## 3. LobeHub (LobeChat)

The design-led option. Polished visuals, marketplace mentality.

**IA / UX**
- Agent-centric IA: assistants (GPTs) are first-class objects with a marketplace; conversations live under agents rather than in one flat history ([README](https://github.com/lobehub/lobe-chat/)).
- Feature set: chain-of-thought display, branching conversations, artifacts/whiteboard, knowledge bases, TTS/STT, plugin system with custom message renderers, MCP marketplace with one-click install.
- The plugin system can introduce new ways to render message results, not just new function calls. For omp, tool-call cards are exactly this: a renderer registry per tool type.

**Customization**
- Custom themes, light/dark, mobile-adapted layout, strong motion design. Explicit goal: "indistinguishable from native apps" via PWA with smooth animations and responsive layouts ([PWA feature](https://github.com/lobehub/lobehub/blob/v2.0.0-next.387/README.md)).

**Mobile**: best-in-category mobile adaptation and PWA story; desktop app also offered. The lesson: treat PWA as a first-class deliverable, not an afterthought.

**Criticisms**: feature breadth means the settings and marketplace surfaces can feel like a product catalog rather than a tool; reasoning-tag rendering has needed custom CSS tweaks in some versions.

## 4. big-AGI

The expert's workspace. Dense, fast, keyboard-first, honest about being for power users.

**Personas** (the standout concept): a persona is a saved role bundling system instruction, up to ten reference documents, chat starters, a pinned model with its own settings, a voice, custom Beam merge buttons, and per-turn "reinforcement instructions" ([personas docs](https://big-agi.com/docs/feature-personas)). Assigned per chat via dropdown (`Ctrl+P`); `@` in the composer addresses a different persona for one message. For omp, this maps to "agent presets": a bundle of model + thinking level + skill set + system prompt, switchable per session.

**Power features**
- Beam: run several models on one question and merge answers ([version comparison](https://big-agi.com/docs/choose-version)).
- AI Inspector: shows the literal request as sent to the provider. Radical transparency that coding-agent users will love; omp should show the exact payload/tool call behind every card.
- Per-request model controls: effort, temperature, verbosity, reasoning budget, per request or per persona ([big-agi.com](https://big-agi.com/)).
- One-file backup/restore/import of chats and settings.

**Criticisms / limits**: customization of theme and personas on self-hosted requires editing source files (`src/common/app.theme.ts`); there is no admin panel ([customizations docs](https://big-agi.com/docs/customizations)). Density is high; it does not pretend to be simple.

## 5. Polish references: ChatGPT, Claude.ai, T3 Chat

**ChatGPT**: sets the baseline expectations: sidebar with search + date-grouped history, projects (folders with instructions and files), temporary chats, canvas side panel for documents/code, memory, voice mode, share links. Its weaknesses are instructive: history search is weak, the sidebar list is a flat undifferentiated pit, and navigation between threads has visible loading states.

**Claude.ai**: artifacts panel (content renders in a side pane, versioned, with publish/share), styles (concise/explanatory/formal, plus custom), projects with knowledge, visible thinking blocks that collapse cleanly. Users complain about loading spinners on every navigation ([Theo's build log](https://rosetta.to/u/t3dotgg/how-i-built-t3-chat-in-5-days)).

**T3 Chat**: the most instructive reference for perceived performance.
- Local-first architecture: the whole app is a static client shell, navigation is fully client-side, threads and messages live in IndexedDB (Dexie), sync layer behind it. Result: "no loading states, only stale states"; you can navigate everything offline ([launch post](https://rosetta.to/u/t3dotgg/my-new-app-is-here-it-s-really-fast)).
- Speed details worth stealing: navigate on mouse-down rather than click, prefetch everything, heavy memoization, fast custom syntax highlighter, streaming continues while you hop between threads.
- Sidebar time-grouping (Today / Yesterday / etc.) was called out by users as a favorite detail ([redesign thread](https://www.linkedin.com/posts/t3gg_t3-chat-is-now-the-cheapest-fastest-and-activity-7307892576580161536-eYBv)).
- User requests from that same thread we should preempt: theme chooser / accent color, PWA support, better chat-list scannability (tags, short descriptions, outcome markers), in-chat threading/branching.
- Cautionary: their first UI was widely mocked as ugly and generic; visual quality is a feature, not a coat of paint ([redesign video notes](https://rosetta.to/u/t3dotgg/fixing-t3-chat-s-biggest-problem-me)).

---

## Mobile patterns to adopt

- Ship a real PWA (manifest, service worker, installable) like LobeHub; it is the cheapest path to "Android app" before the native one exists.
- Sidebar becomes a drawer with swipe-to-open; composer sticks above the keyboard with safe-area padding; use bottom sheets for pickers (model, thinking level, session actions) instead of dropdowns.
- Enter sends, shift+enter newline on desktop; on mobile provide a send button and never rely on hover. LibreChat's hover-revealed actions must get a touch equivalent (long-press or always-visible overflow menu).
- Streaming must survive backgrounding: queue input while the agent runs (Open WebUI message queue, LibreChat steer/queue), and restore stream state on reconnect.
- Haptic feedback on approvals is a nice Open WebUI touch for mobile.

## Notable UX criticisms to design around

1. Hidden per-turn background work (title/tag/follow-up generation) makes responses feel slow and users cannot find the toggles (Open WebUI, [Reddit](https://reddit.sentinel-team.org/posts/1uy50kf/snapshots/2026-07-16T18%3A55%3A39.061383Z)). Make auxiliary jobs visible and cheap to disable.
2. Flat, unscannable chat history lists; everything becomes "a pit" (T3 Chat feedback, [LinkedIn](https://www.linkedin.com/posts/t3gg_t3-chat-is-now-the-cheapest-fastest-and-activity-7307892576580161536-eYBv)).
3. Reasoning/thinking dumped as wall-of-text instead of a collapsed, styled block (LibreChat/DeepSeek complaints, [forum](https://www.aitalkboard.com/deepseek-forum/which-web-ui-is-best-for-self-hosting-deepseek-53624/)).
4. Loading spinners on every navigation (ChatGPT/Claude); T3 Chat proved local-first eliminates this.
5. Settings sprawl: hundreds of toggles with no search and unclear defaults (Open WebUI). Settings need search, sensible defaults, and grouping by task.
6. Requiring source edits for theming (big-AGI self-hosted). Theming must be a runtime setting, not a build step.
7. Dropdown pickers that are unusable on mobile; bottom sheets win.

---

## Top 15 ideas to steal, ranked

1. **Local-first snappy navigation** (T3 Chat): client-side routing + local message cache, "stale states not loading states". The single biggest perceived-quality lever.
2. **Composer trigger grammar** `/` `@` `#` `$` (Open WebUI): slash commands, model switching, context attach, skill mention, zero screen real estate.
3. **Steer / Queue / Interrupt mid-run with quoted excerpts** (LibreChat): perfect model for interacting with a running coding agent between approvals.
4. **Fork from any message** (Open WebUI `/fork`, LibreChat, LobeHub): branch a session without disturbing the original; essential for trying alternate fixes.
5. **Personas/presets bundle** (big-AGI): one object = model + params + instructions + skills + starters; switch per chat via `Ctrl+P`.
6. **Full-text history search with typo tolerance** (LibreChat/Meilisearch): search titles AND message contents; the most requested power feature.
7. **Sidebar time-grouping + pins + folders** (T3 Chat, Open WebUI, ChatGPT): Today/Yesterday/This week grouping plus pinned live sessions on top.
8. **AI Inspector: show the literal request/tool payload** (big-AGI): one toggle reveals exact JSON behind any message or tool card. Trust-building for a coding agent.
9. **Structured tool-call cards with per-item collapse and raw JSON toggle** (Open WebUI structured response editing): each tool call, thought, and result is its own collapsible block.
10. **Message actions reveal on hover/focus, hidden while streaming** (LibreChat): keeps the document clean without losing discoverability.
11. **Assistant turns as full-width documents, user turns as bubbles** (LibreChat): reads like a log where the agent's output is the content, not a chat with yourself.
12. **Rebindable keyboard shortcuts** (Open WebUI Settings > Keyboard): power users, desktop app parity later.
13. **Auto-scroll toggle while streaming** (Open WebUI): read earlier output while generation continues.
14. **Bottom-sheet pickers + drawer navigation + PWA install** (LobeHub, T3 feedback): the mobile baseline.
15. **Artifacts-style side panel** (Claude.ai, LobeHub): open a generated file, diff, or config in a versioned side pane instead of inline. Ideal for omp file edits.

## Anti-patterns to avoid

- **Settings sprawl without search or sane defaults** (Open WebUI): hundreds of toggles; users cannot find the one that fixes their problem. Group by task, provide search, keep the visible surface small.
- **Hidden background jobs per turn** (Open WebUI title/tags/follow-up): invisible latency and cost. Surface auxiliary work in the UI (e.g. the `/status` panel) and default it to cheap.
- **Loading spinners between every screen** (ChatGPT, Claude.ai): cache aggressively; navigate instantly and reconcile.
- **Flat, unscannable history list** (every app): no tags, no status, no outcome. Add per-session metadata (repo/branch, status: running/waiting/done, cost) to each list row.
- **Thinking/reasoning as wall-of-text** (LibreChat R1 complaints): always render thinking in a collapsed, styled, expandable block.
- **Build-time theming** (big-AGI self-hosted): themes, accent color, and density must be runtime user settings, persisted per device.
- **Hover-only affordances** (most desktop-first apps): every hover action needs a touch path (long-press, overflow menu).
- **Dropdown menus for primary pickers on mobile**: use bottom sheets with search.
- **Feature-parity bloat on the simple surface** (LobeHub marketplace feel): depth belongs behind triggers and drawers, not on the main screen.
- **Losing in-flight input on reconnect** (older LibreChat behavior): queue composer content locally; never silently drop a steer or approval.
