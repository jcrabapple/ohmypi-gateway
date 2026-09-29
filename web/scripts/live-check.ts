// Live check against a running dev server (bun run dev, port 5183 by default) that proxies to a gateway.
// Logs in with ../auth-token (read here, never printed), runs one turn in a throwaway /tmp session,
// follows /omp-ws to agent_end, then feeds the live events and /messages through the reducer and
// compares the two transcripts. Always deletes the session it created.
//   bun run scripts/live-check.ts [http://127.0.0.1:5183]
import { readFileSync } from 'node:fs';
import { emptyTranscript, reduce } from '../src/lib/transcript/reducer';
import type { Item, TranscriptState } from '../src/lib/transcript/types';
import type { OmpEvent, OmpMessage, SessionInfo } from '../src/lib/api/types';

const base = (process.argv[2] ?? 'http://127.0.0.1:5183').replace(/\/+$/, '');
const origin = new URL(base).origin;
const token = readFileSync(new URL('../../auth-token', import.meta.url), 'utf8').trim();
let cookie = '';

const log = (s: string) => console.log(s);
const fail = (s: string): never => {
  throw new Error(s);
};

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(base + path, {
    method: init.method ?? 'GET',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) fail(`${init.method ?? 'GET'} ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

function summary(items: readonly Item[]) {
  return items
    .filter((i) => i.kind === 'user' || i.kind === 'assistant' || i.kind === 'tool' || i.kind === 'thinking')
    .map((i) => {
      if (i.kind === 'user' || i.kind === 'assistant') return `${i.kind}:${i.text.trim()}`;
      if (i.kind === 'tool') return `tool:${i.name}`;
      return 'thinking';
    });
}

async function main() {
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!login.ok) fail(`login -> ${login.status}`);
  cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  log(`login: ${login.status}, cookie ${cookie ? 'set' : 'missing'}`);
  if (!cookie) fail('no session cookie');

  const info = await call<SessionInfo>('/api/sessions', { method: 'POST', body: { cwd: '/tmp' } });
  log(`created session, cwd ${info.cwd}, model ${info.model?.id ?? 'default'}`);
  try {
    let live: TranscriptState = emptyTranscript();
    const events: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/omp-ws/${encodeURIComponent(info.gwId)}?after=${info.lastEventSeq}`, {
        headers: { Origin: origin, Cookie: cookie },
      } as unknown as string[]);
      const timer = setTimeout(() => reject(new Error('timed out waiting for agent_end')), 120_000);
      ws.onmessage = (m) => {
        const d = JSON.parse(String(m.data)) as { seq?: number; event?: { type: string } };
        if (!d.event) return;
        if (typeof d.seq === 'number' && d.seq > 0) {
          events.push(d.event.type);
          live = reduce(live, { kind: 'event', event: d.event as OmpEvent });
          if (d.event.type === 'agent_end') {
            clearTimeout(timer);
            ws.close();
            resolve();
          }
        } else if (d.event.type === 'auth_ok') {
          log('ws: auth_ok');
          void call(`/api/sessions/${info.gwId}/prompt`, {
            method: 'POST',
            body: { message: 'Reply with exactly: ok', mode: 'prompt', wait: false },
          }).then(() => log('prompt: accepted'), reject);
        }
      };
      ws.onerror = () => reject(new Error('websocket error'));
      ws.onclose = (e) => {
        if (e.code >= 4000) reject(new Error(`websocket closed ${e.code}`));
      };
    });
    await done;
    const kinds = new Map<string, number>();
    for (const e of events) kinds.set(e, (kinds.get(e) ?? 0) + 1);
    log(`ws: ${events.length} events, ${[...kinds].map(([k, n]) => `${k}x${n}`).join(' ')}`);

    const { messages } = await call<{ messages: OmpMessage[] }>(`/api/sessions/${info.gwId}/messages`);
    const history = reduce(emptyTranscript(), { kind: 'history', messages });
    const a = summary(live.items);
    const b = summary(history.items);
    log(`live items:    ${JSON.stringify(a)}`);
    log(`history items: ${JSON.stringify(b)}`);
    if (JSON.stringify(a) !== JSON.stringify(b)) fail('live and history transcripts differ');
    const last = live.items.filter((i) => i.kind === 'assistant').at(-1);
    if (!last || last.kind !== 'assistant' || last.text.trim().toLowerCase() !== 'ok') fail('assistant did not reply "ok"');
    if (live.items.some((i) => i.kind === 'assistant' && i.streaming)) fail('an assistant item is still streaming');
    if (live.running) fail('reducer still says running after agent_end');
    log('match: yes');
  } finally {
    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(info.gwId)}`, {
      method: 'DELETE',
      headers: { Origin: origin, Cookie: cookie },
    });
    log(`deleted session: ${res.status}`);
  }
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
