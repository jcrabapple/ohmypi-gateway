# ohmypi-gateway: rules for coding agents

You are working in a FastAPI gateway (`gateway/`) over the oh-my-pi (`omp`)
RPC protocol, plus a new Svelte 5 + TypeScript web client (`web/`). Read
`docs/PHASE1.md` for the current build spec, `docs/DESIGN.md` for the design
intent, `docs/API.md` for the HTTP/WS contract, and `docs/CLIENTS.md` for
client architecture rules.

## Hard rules

- Never read, print, copy, or commit `auth-token`, `gateway.env`, or anything
  under `~/.omp/`, `~/.cloudflared/`, `~/.hermes/`. Scripts may read
  `auth-token` at runtime (tests/e2e.py already does); you never echo it.
- Never restart, stop, or edit `ohmpi-gateway.service` or
  `cloudflared-ohmypi.service`, and never kill processes you didn't start.
  The production gateway on 127.0.0.1:9315 must stay up. To test gateway
  changes, run your own instance:
  `.venv/bin/uvicorn gateway.main:app --host 127.0.0.1 --port 9325` and
  stop it when done. It shares the same auth-token file automatically.
- Live sessions you create for testing must be stopped (DELETE) before you
  finish. Don't touch live sessions you didn't create.
- Don't `git commit`, `git push`, or change branches. The orchestrator
  reviews and commits.
- Don't edit `docs/DESIGN.md`, `docs/CLIENTS.md`, `docs/research/*`.
- `dev/fixtures/*.json` are real captures from the live gateway (shapes are
  authoritative). They contain local paths, so they stay out of git; test
  fixtures you derive from them go under `web/src/**/__fixtures__/` with paths
  and long text trimmed.

## Conventions

- Package manager for `web/`: bun (`~/.bun/bin/bun`, 1.4.x). Node 22 is also
  available. Pin exact dependency versions. Keep dependencies few and small;
  justify each one in `web/README.md`.
- TypeScript strict. No `any` except at the JSON boundary, narrowed
  immediately.
- User-facing copy: plain, short, no em-dashes, no exclamation marks, no
  "Loading..." text (use skeletons or a quiet spinner glyph).
- Accessibility: real buttons, labels, focus rings, `aria-live` for streaming
  status, Escape closes overlays, focus returns to the opener.
- Every hover action has a touch path. Touch targets >= 44px on coarse
  pointers.
- Python: match the existing style in `gateway/`; exception handlers, not
  decorators, for errors.

## Verification you must run before saying you're done

- `cd web && bun run check && bun run test && bun run build` all pass.
- Gateway changes: `.venv/bin/python tests/e2e.py http://127.0.0.1:9325`
  against your own instance passes.
- Report exactly which commands you ran and their results. If something
  failed and you couldn't fix it, say so plainly.
