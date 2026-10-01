# ohmypi-gateway

HTTP/WebSocket gateway over the [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi)
RPC protocol. One service exposes the whole agent (sessions, streaming,
approvals, models, config, skills, usage) so web, desktop and mobile clients
can sit on top of it. Ships with a web dashboard at `/` that uses nothing but
the public API.

Client contract: **[docs/API.md](docs/API.md)**. OpenAPI at `/api/openapi.json`.

## Layout

- `gateway/bridge.py`: async JSONL client for `omp --mode rpc`. One child per
  live session, request correlation, protocol v2 with `rpc_chunk` reassembly,
  numbered event backlog for gap-free reconnects, pending-dialog tracking for
  approvals.
- `gateway/auth.py`: bearer token, signed session cookie, per-IP lockout.
- `gateway/push.py`: Web Push ("needs you"): VAPID keys, device subscriptions, dialog pushes. Needs the `pywebpush` package in the venv (`pip install pywebpush`); without it the feature reports unavailable and everything else runs normally.
- `gateway/main.py`: FastAPI app: REST, per-session WebSocket, dashboard.
- `static/`: Alpine.js dashboard (vendored, no CDN), installable as a PWA.
- `tests/e2e.py`: suite run against a live omp; takes a base URL.
- `auth-token`: the secret, generated on first start, mode 600, gitignored.

## Run

```sh
cp ohmpi-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ohmpi-gateway
.venv/bin/python tests/e2e.py                   # local
.venv/bin/python tests/e2e.py https://<host>    # through the tunnel
```

The service binds `127.0.0.1:9315` only. Remote access goes through a
Cloudflare tunnel (`cloudflared` ingress → `http://127.0.0.1:9315`); there is
no LAN listener to port-forward by mistake. Tunables go in `gateway.env`
(gitignored): `OMPGW_MAX_SESSIONS`, `OMPGW_IDLE_REAP_SEC`,
`OMPGW_EXTRA_ORIGINS`, `OMPGW_DEFAULT_APPROVAL`, `OMPGW_WEB_DIST`.

`OMPGW_WEB_DIST` is the directory of the built web client (default `web/dist`).
When it contains `index.html`, `/` serves it and the Alpine dashboard moves to
`/classic`; otherwise `/` stays the Alpine dashboard. See `docs/API.md`.

## Security model

Whoever holds the token can run a coding agent with shell access on the host,
and new sessions default to `approvalMode: yolo`. Everything else follows
from that:

- One 256-bit token. Native clients send it as a bearer header; the dashboard
  trades it for an HttpOnly/Secure/SameSite=Strict cookie so page JavaScript
  never holds it. Tokens in URLs are rejected.
- Cookie-authenticated writes and WebSocket upgrades require a same-origin
  `Origin`, so a hostile page can't drive the agent through your browser.
- 10 bad attempts from one IP in 15 minutes locks that IP out for 15 minutes.
- Strict CSP (no inline script, no third-party origins), `frame-ancestors
  'none'`, no CDN dependencies.
- `resumeFrom` is confined to `~/.omp/agent/sessions`.

Rotate the token by deleting `auth-token` and restarting; every client and
browser session is signed out.

For a second factor in front of the dashboard, put Cloudflare Access on the
hostname with a bypass for `/api/*`, `/omp-ws/*`, `/healthz` and
`/.well-known/*` so native bearer clients keep working.
