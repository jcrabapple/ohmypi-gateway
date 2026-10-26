# ohmypi-gateway

An HTTP + WebSocket gateway over the [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`)
RPC protocol, with a web client that runs on a phone.

`omp` is a terminal agent. This turns it into something you can leave running on a desktop and
drive from a browser: one service exposes the whole agent (sessions, streaming, approvals,
queues, models, config, skills, usage, subagents) and serves a Svelte client at `/` that uses
nothing but that public API.

The point is the seam between "agent running in my terminal" and "agent I can reach from the
couch": approvals arrive as notifications, a session that starts waiting for input shows up in
a rail, and a terminal session you started by hand appears next to the ones the gateway spawned.

- Client contract: **[docs/API.md](docs/API.md)**. OpenAPI at `/api/openapi.json`.
- Design notes and phase specs: `docs/`.
- MIT licensed, unaffiliated with oh-my-pi: see [NOTICE.md](NOTICE.md).

## What it does

| | |
|---|---|
| Sessions | Create, resume from a saved transcript, fork, rename, stop. One `omp` child per live session, protocol v2 with chunk reassembly and a numbered event backlog so a reconnect never loses a gap. |
| Streaming | Per-session WebSocket with replay-after-cursor, heartbeats, and a plain HTTP events endpoint for clients that can't hold a socket. |
| Approvals | Blocking `omp` dialogs surface as pending UI: the client answers them, and a push notification goes out when nobody is watching that session. |
| Queue | Gateway-owned FIFO of follow-ups per session, editable and cancellable until they fire. |
| Plan and diffs | `todoPhases` rendered as a live plan, word-level diff view for every edit `omp` makes. |
| Subagents | Progress frames and per-subagent transcripts. |
| Usage | A turn-level ledger (tokens, cost, per model) plus search across live and archived transcripts. |
| External sessions | Read-only rows for interactive `omp` sessions the gateway did not spawn, discovered from omp's collab registry. |
| Push | Web Push for dialogs and for external sessions that start waiting on input. |

## Requirements

- Python 3.11+ (developed on 3.14)
- [`omp`](https://github.com/can1357/oh-my-pi) on `PATH`, with its own provider keys configured
- [bun](https://bun.sh) 1.4+ to build the web client
- Optional: `pywebpush` (installed by `requirements.txt`) for push notifications

## Run it

```sh
git clone https://github.com/jcrabapple/ohmypi-gateway.git
cd ohmypi-gateway
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# build the web client once (served from web/dist)
cd web && bun install && bun run build && cd ..

cp ohmpi-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ohmpi-gateway
```

The service binds `127.0.0.1:9315` only and generates `auth-token` on first start (mode 600,
gitignored). Open `http://127.0.0.1:9315/` and paste it. Remote access is meant to go through a
tunnel (Cloudflare Tunnel is what this was built against); there is no LAN listener to
port-forward by accident.

Tunables go in `gateway.env` (gitignored, loaded by the unit):

| Variable | Meaning |
|---|---|
| `OMPGW_MAX_SESSIONS` | Live session cap (default 8) |
| `OMPGW_IDLE_REAP_SEC` | Idle session reaper |
| `OMPGW_EXTRA_ORIGINS` | Extra allowed `Origin`s beyond same-origin |
| `OMPGW_DEFAULT_APPROVAL` | `always-ask` / `write` / `yolo` for new sessions |
| `OMPGW_WEB_DIST` | Where the built web client lives (default `web/dist`) |
| `OMPGW_VAPID_SUB` | Contact URI for Web Push (default is an unroutable placeholder) |
| `OMPGW_COLLAB_DIR` | omp collab discovery directory (default `~/.omp/run/collab-hosts`) |
| `OMPGW_COLLAB_POLL_S` | External-session poll interval (default 10s) |

If `web/dist/index.html` is missing, `/` falls back to the older Alpine dashboard in `static/`;
with a built client, the Alpine one moves to `/classic`.

## External sessions (optional)

`omp` can publish every interactive session it hosts to a local registry. Turn it on in omp:

```sh
omp config set collab.autoStart view     # view-only links; "control" also allows typing
```

New interactive sessions then appear in the gateway's rail as read-only rows with a `desk`
badge, and a push fires when one of them starts waiting for input. The gateway only reads that
registry: it never writes it, never stores a capability URL, and fetches a one-shot link only
when you tap a row. Note that `collab.autoStart` also connects those sessions to omp's
end-to-end encrypted relay, so it is a deliberate choice, not a local-only setting.
`GET /api/collab` returns the rows plus counters for judging whether it earns its place.

## Layout

- `gateway/bridge.py`: async JSONL client for `omp --mode rpc`. One child per live session,
  request correlation, protocol v2 negotiation, event backlog, pending-dialog tracking.
- `gateway/auth.py`: bearer token, signed session cookie, per-IP lockout.
- `gateway/collab.py`: read-only collab registry reader (`/api/collab`).
- `gateway/push.py`: VAPID keys, device subscriptions, dialog and attention pushes.
- `gateway/main.py`: FastAPI app (REST, per-session WebSocket, static clients).
- `web/`: Svelte 5 + TypeScript client, built into `web/dist`.
- `static/`: older Alpine.js dashboard, also installable as a PWA.
- `tests/`: stdlib `unittest` suites plus `e2e.py`, which runs against a live gateway and a
  real `omp`.

## Development

```sh
.venv/bin/python tests/test_collab.py     # any suite: python tests/test_*.py
cd web && bun run check && bun run test && bun run build
.venv/bin/python tests/e2e.py http://127.0.0.1:9315
```

`e2e.py` creates and deletes real sessions, so point it at a scratch gateway instance, not one
you are using.

## Security model

Whoever holds the token can run a coding agent with shell access on the host, and new sessions
default to `approvalMode: yolo`. Everything else follows from that:

- One 256-bit token. Native clients send it as a bearer header; the dashboard trades it for an
  HttpOnly/Secure/SameSite=Strict cookie so page JavaScript never holds it. Tokens in URLs are
  rejected.
- Cookie-authenticated writes and WebSocket upgrades require a same-origin `Origin`, so a
  hostile page can't drive the agent through your browser.
- 10 bad attempts from one IP in 15 minutes locks that IP out for 15 minutes.
- Strict CSP (no inline script, no third-party origins), `frame-ancestors 'none'`, no CDN
  dependencies.
- `resumeFrom` is confined to `~/.omp/agent/sessions`.

Rotate the token by deleting `auth-token` and restarting; every client and browser session is
signed out. For a second factor, put Cloudflare Access on the hostname with a bypass for
`/api/*`, `/omp-ws/*`, `/healthz` and `/.well-known/*` so native bearer clients keep working.

## Not affiliated

This is a community project. It is not affiliated with, endorsed by, or supported by the
oh-my-pi maintainers. See [NOTICE.md](NOTICE.md).

## License

MIT. See [LICENSE](LICENSE).
