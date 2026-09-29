# ohmypi-gateway

HTTP/WebSocket gateway over the [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi)
RPC protocol. One service exposes the full agent surface (sessions, prompting,
models, config, skills, usage) so web, desktop, and mobile clients can sit on
top of it. Ships with a web dashboard at `/`.

## Layout

- `gateway/bridge.py` — async JSONL client for `omp --mode rpc --no-ui`:
  request correlation, protocol v2 negotiation with `rpc_chunk` reassembly,
  event fan-out + replay backlog, one child process per live session.
- `gateway/main.py` — FastAPI app: REST + per-session WebSocket + dashboard.
- `static/index.html` — Alpine.js dashboard (chat with streaming, session
  sidebar, config editor, skills/models/usage panels).
- `auth-token` — bearer token, generated on first run, chmod 600.

## Run

```sh
systemctl --user enable --now ohmpi-gateway   # unit file copied to ~/.config/systemd/user/
# http://<host>:9315/  — dashboard prompts for the token
```

## API (all under /api, Bearer token required)

| Endpoint | Purpose |
|---|---|
| `GET /api/health`, `GET /api/system` | liveness, versions |
| `GET /api/config` / `PUT /api/config` | read / replace `~/.omp/agent/config.yml` (validated by omp, auto-revert on rejection) |
| `GET /api/models?q=` | model catalog via omp CLI |
| `GET /api/skills`, `/api/plugins`, `/api/usage`, `/api/agents` | CLI surface as text |
| `GET /api/sessions` | live sessions + saved sessions (scanned from disk, titled) |
| `POST /api/sessions` | spawn: `{cwd, model, thinking, approvalMode, resumeFrom}` |
| `DELETE /api/sessions/{id}` | stop child |
| `POST /api/sessions/{id}/prompt` | `{message, wait?, steer?}` — `wait:true` resolves after the agent turn |
| `POST .../abort`, `.../compact`, `.../model`, `.../thinking` | session controls |
| `GET .../state`, `.../messages`, `.../events?after=seq` | inspection (events = replayable backlog) |
| `WS /omp-ws/{id}?token=` | live event stream, accepts raw RPC frames as text |

## Security

Anyone with the token can run an agent with shell access (`approvalMode:
yolo` is the default). Keep the port LAN-only; do not port-forward it.

## Protocol notes

The bridge speaks protocol v2 (chunked large frames); oversized frames are
reassembled from `rpc_chunk` base64 segments per the upstream contract in
`docs/rpc.md`. Sessions are resumed via `resumeFrom` with the session file
path from `GET /api/sessions`.
