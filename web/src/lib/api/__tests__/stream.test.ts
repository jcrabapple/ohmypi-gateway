import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBaseUrl } from '../client';
import { SessionStream } from '../stream';
import type { StreamOptions, StreamStatus } from '../stream';
import type { ControlEvent, OmpEvent, UnknownEvent } from '../types';
import sessionInfo from '../__fixtures__/session-info.json';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; }
  // ---- test helpers
  frame(seq: number, event: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ seq, event }) });
  }
  authOk(gap = false) {
    this.readyState = 1;
    this.frame(0, { type: 'auth_ok', session: sessionInfo, gap });
  }
  serverClose(code: number, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const sockets = () => FakeWebSocket.instances;
const last = () => sockets().at(-1)!;

let hidden = false;
let online = true;
function setHidden(v: boolean) {
  hidden = v;
  document.dispatchEvent(new Event('visibilitychange'));
}

interface Rig {
  stream: SessionStream;
  events: { seq: number; type: string }[];
  controls: string[];
  states: StreamStatus[];
  resyncs: string[];
  signedOut: number;
  gone: number;
}

function rig(opts: Partial<StreamOptions> = {}): Rig {
  const r: Rig = { stream: undefined as unknown as SessionStream, events: [], controls: [], states: [], resyncs: [], signedOut: 0, gone: 0 };
  r.stream = new SessionStream({
    gwId: 'abc',
    random: () => 0.5,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    onEvent: (e: OmpEvent | UnknownEvent, seq: number) => r.events.push({ seq, type: e.type }),
    onControl: (c: ControlEvent) => r.controls.push(c.type),
    onState: (s) => r.states.push(s),
    onResync: (reason) => r.resyncs.push(reason),
    onSignedOut: () => { r.signedOut += 1; },
    onGone: () => { r.gone += 1; },
    ...opts,
  });
  return r;
}

const seqs = (r: Rig) => r.events.map((e) => e.seq);
const ev = (type = 'agent_start') => ({ type });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  FakeWebSocket.instances = [];
  hidden = false;
  online = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  setBaseUrl('http://gw.test');
});

afterEach(() => {
  vi.useRealTimers();
  setBaseUrl('');
});

describe('connecting', () => {
  it('opens /omp-ws/{id}?after={cursor} on the gateway origin', () => {
    const r = rig({ gwId: 'a b', after: 12 });
    r.stream.start();
    expect(last().url).toBe('ws://gw.test/omp-ws/a%20b?after=12');
    expect(r.stream.state).toBe('connecting');
    r.stream.stop();
  });

  it('is live after auth_ok and hands the snapshot to onControl', () => {
    const r = rig();
    r.stream.start();
    last().authOk();
    expect(r.stream.state).toBe('live');
    expect(r.controls).toEqual(['auth_ok']);
    expect(r.states.map((s) => s.state)).toEqual(['connecting', 'live']);
    r.stream.stop();
  });

  it('ignores a second start()', () => {
    const r = rig();
    r.stream.start();
    r.stream.start();
    expect(sockets()).toHaveLength(1);
    r.stream.stop();
  });

  it('sends only while the socket is open', () => {
    const r = rig();
    r.stream.start();
    expect(r.stream.send({ type: 'ping' })).toBe(false);
    last().authOk();
    expect(r.stream.send({ type: 'get_state' })).toBe(true);
    expect(r.stream.send('ping')).toBe(true);
    expect(last().sent).toEqual(['{"type":"get_state"}', 'ping']);
    r.stream.stop();
  });
});

describe('frames and the resume cursor', () => {
  it('delivers events in order and drops anything at or below the cursor', () => {
    const r = rig({ after: 5 });
    r.stream.start();
    last().authOk();
    last().frame(5, ev());
    last().frame(6, ev('turn_start'));
    last().frame(6, ev('turn_start'));
    last().frame(9, ev('turn_end'));
    last().frame(7, ev('late'));
    expect(seqs(r)).toEqual([6, 9]);
    expect(r.stream.lastSeq).toBe(9);
    r.stream.stop();
  });

  it('routes control frames and swallows heartbeat and pong', () => {
    const r = rig();
    r.stream.start();
    last().authOk();
    last().frame(0, { type: 'heartbeat' });
    last().frame(0, { type: 'pong' });
    last().frame(0, { type: 'ws_error', error: 'nope' });
    last().frame(0, { type: 'rpc_response', success: true });
    expect(r.controls).toEqual(['auth_ok', 'ws_error', 'rpc_response']);
    expect(r.events).toEqual([]);
    r.stream.stop();
  });

  it('ignores malformed frames', () => {
    const r = rig();
    r.stream.start();
    last().authOk();
    last().onmessage?.({ data: 'not json' });
    last().onmessage?.({ data: '{"seq":3}' });
    last().onmessage?.({ data: '{"seq":3,"event":{}}' });
    last().onmessage?.({ data: new ArrayBuffer(2) });
    expect(r.events).toEqual([]);
    r.stream.stop();
  });

  it('resumes after the last delivered seq when it reconnects', () => {
    const r = rig();
    r.stream.start();
    last().authOk();
    last().frame(1, ev());
    last().frame(2, ev());
    last().serverClose(1006);
    vi.advanceTimersByTime(500);
    expect(sockets()).toHaveLength(2);
    expect(last().url).toContain('?after=2');
    last().authOk();
    last().frame(2, ev());
    last().frame(3, ev());
    expect(seqs(r)).toEqual([1, 2, 3]);
    r.stream.stop();
  });
});

describe('reconnect backoff', () => {
  it('uses full-jitter exponential backoff with a 30 s cap', () => {
    const r = rig({ random: () => 0.999 });
    r.stream.start();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      last().serverClose(1006);
      const at = r.stream.retryAt!;
      delays.push(at - Date.now());
      expect(r.stream.state).toBe('retrying');
      vi.advanceTimersByTime(at - Date.now());
      expect(r.stream.state).toBe('connecting');
    }
    expect(delays).toEqual([999, 1998, 3996, 7992, 15984, 29970, 29970, 29970]);
    r.stream.stop();
  });

  it('spreads the delay across [0, cap)', () => {
    const r = rig({ random: () => 0 });
    r.stream.start();
    last().serverClose(1006);
    expect(r.stream.retryAt).toBe(Date.now());
    r.stream.stop();
  });

  it('counts a close within 5 s of auth_ok as a failure and keeps backing off', () => {
    const r = rig();
    r.stream.start();
    last().serverClose(1006);
    expect(r.stream.retryAt! - Date.now()).toBe(500);
    vi.advanceTimersByTime(500);
    last().authOk();
    vi.advanceTimersByTime(4900);
    last().serverClose(1006);
    expect(r.stream.retryAt! - Date.now()).toBe(1000);
    vi.advanceTimersByTime(1000);
    last().authOk();
    vi.advanceTimersByTime(4900);
    last().serverClose(1006);
    expect(r.stream.retryAt! - Date.now()).toBe(2000);
    r.stream.stop();
  });

  it('resets the counter once a socket has stayed open for 5 s', () => {
    const r = rig();
    r.stream.start();
    last().serverClose(1006);
    vi.advanceTimersByTime(500);
    last().serverClose(1006);
    vi.advanceTimersByTime(1000);
    last().authOk();
    vi.advanceTimersByTime(5000);
    last().serverClose(1006);
    expect(r.stream.retryAt! - Date.now()).toBe(500);
    r.stream.stop();
  });

  it('waits for the page to become visible instead of retrying in the background', () => {
    const r = rig();
    r.stream.start();
    last().authOk();
    setHidden(true);
    last().serverClose(1006);
    expect(r.stream.state).toBe('offline');
    vi.advanceTimersByTime(120_000);
    expect(sockets()).toHaveLength(1);
    setHidden(false);
    expect(sockets()).toHaveLength(2);
    expect(r.stream.state).toBe('connecting');
    r.stream.stop();
  });

  it('waits for the network when the browser reports offline, then reconnects on online', () => {
    const r = rig();
    r.stream.start();
    last().authOk();
    online = false;
    last().serverClose(1006);
    expect(r.stream.state).toBe('offline');
    online = true;
    window.dispatchEvent(new Event('online'));
    expect(sockets()).toHaveLength(2);
    r.stream.stop();
  });

  it('reconnects immediately on online while a retry is pending', () => {
    const r = rig({ random: () => 0.999 });
    r.stream.start();
    last().serverClose(1006);
    last().serverClose(1006);
    expect(r.stream.state).toBe('retrying');
    window.dispatchEvent(new Event('online'));
    expect(sockets()).toHaveLength(2);
    expect(r.stream.state).toBe('connecting');
    r.stream.stop();
  });

  it('does nothing on visibility or online events while live', () => {
    const r = rig();
    r.stream.start();
    last().authOk();
    setHidden(true);
    vi.advanceTimersByTime(30_000);
    last().frame(0, { type: 'heartbeat' });
    setHidden(false);
    window.dispatchEvent(new Event('online'));
    expect(sockets()).toHaveLength(1);
    expect(r.resyncs).toEqual([]);
    r.stream.stop();
  });
});

describe('close codes', () => {
  it('4401 signs out and never retries', () => {
    const r = rig();
    r.stream.start();
    last().authOk();
    last().serverClose(4401);
    expect(r.signedOut).toBe(1);
    expect(r.stream.state).toBe('offline');
    vi.advanceTimersByTime(600_000);
    expect(sockets()).toHaveLength(1);
    setHidden(true);
    setHidden(false);
    expect(sockets()).toHaveLength(1);
  });

  it('4404 reports the session as gone and never retries', () => {
    const r = rig();
    r.stream.start();
    last().serverClose(4404);
    expect(r.gone).toBe(1);
    expect(r.stream.state).toBe('gone');
    vi.advanceTimersByTime(600_000);
    expect(sockets()).toHaveLength(1);
    window.dispatchEvent(new Event('online'));
    expect(sockets()).toHaveLength(1);
    expect(r.stream.state).toBe('gone');
  });

  it('4408 reconnects at once with the cursor, then backs off if it keeps happening', () => {
    const r = rig();
    r.stream.start();
    last().authOk();
    last().frame(4, ev());
    last().serverClose(4408);
    expect(r.stream.state).toBe('retrying');
    vi.advanceTimersByTime(0);
    expect(sockets()).toHaveLength(2);
    expect(last().url).toContain('after=4');
    last().serverClose(4408);
    expect(r.stream.retryAt! - Date.now()).toBe(1000);
    r.stream.stop();
  });

  it('4429 surfaces the message and retries after a minute, ignoring manual reconnects', () => {
    const r = rig();
    r.stream.start();
    last().serverClose(4429, 'Too many attempts. Try again in 60 s.');
    expect(r.stream.state).toBe('retrying');
    expect(r.stream.message).toBe('Too many attempts. Try again in 60 s.');
    expect(r.stream.retryAt! - Date.now()).toBe(60_000);
    window.dispatchEvent(new Event('online'));
    r.stream.reconnectNow();
    vi.advanceTimersByTime(59_000);
    expect(sockets()).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(sockets()).toHaveLength(2);
    last().authOk();
    expect(r.stream.message).toBeNull();
    r.stream.stop();
  });

  it('4429 without a reason still explains itself', () => {
    const r = rig();
    r.stream.start();
    last().serverClose(4429);
    expect(r.stream.message).toMatch(/minute/);
    r.stream.stop();
  });
});

describe('resync', () => {
  it('asks for a resync on auth_ok with gap and holds events until rebase', () => {
    const r = rig({ after: 3 });
    r.stream.start();
    last().authOk(true);
    expect(r.resyncs).toEqual(['gap']);
    last().frame(10, ev('turn_start'));
    last().frame(11, ev('turn_end'));
    last().frame(9, ev('old'));
    expect(seqs(r)).toEqual([]);
    r.stream.rebase(10);
    expect(seqs(r)).toEqual([11]);
    expect(r.stream.lastSeq).toBe(11);
    last().frame(12, ev());
    expect(seqs(r)).toEqual([11, 12]);
    r.stream.stop();
  });

  it('releases held events in seq order', () => {
    const r = rig();
    r.stream.start();
    last().authOk(true);
    last().frame(6, ev());
    last().frame(5, ev());
    last().frame(7, ev());
    r.stream.rebase(4);
    expect(seqs(r)).toEqual([5, 6, 7]);
    r.stream.stop();
  });

  it('does not ask twice while a resync is in flight', () => {
    const r = rig();
    r.stream.start();
    last().authOk(true);
    last().serverClose(1006);
    vi.advanceTimersByTime(500);
    last().authOk(true);
    expect(r.resyncs).toEqual(['gap']);
    r.stream.rebase(0);
    last().serverClose(1006);
    vi.advanceTimersByTime(30_000);
    last().authOk(true);
    expect(r.resyncs).toEqual(['gap', 'gap']);
    r.stream.stop();
  });

  it('releases held events by itself if the caller never rebases', () => {
    const r = rig();
    r.stream.start();
    last().authOk(true);
    last().frame(1, ev());
    vi.advanceTimersByTime(14_000);
    last().frame(0, { type: 'heartbeat' });
    expect(seqs(r)).toEqual([]);
    vi.advanceTimersByTime(1500);
    expect(seqs(r)).toEqual([1]);
    r.stream.stop();
  });

  it('a normal auth_ok does not resync and rebase without a hold is harmless', () => {
    const r = rig();
    r.stream.start();
    last().authOk(false);
    r.stream.rebase(50);
    last().frame(50, ev());
    last().frame(51, ev());
    expect(r.resyncs).toEqual([]);
    expect(seqs(r)).toEqual([51]);
    r.stream.stop();
  });

  it('resyncs and replaces the socket after the tab was hidden for more than 5 minutes', () => {
    const r = rig();
    r.stream.start();
    last().authOk();
    last().frame(1, ev());
    setHidden(true);
    vi.advanceTimersByTime(5 * 60_000 + 1000);
    setHidden(false);
    expect(r.resyncs).toEqual(['hidden']);
    expect(sockets().length).toBeGreaterThanOrEqual(2);
    expect(last().url).toContain('after=1');
    last().authOk();
    last().frame(2, ev());
    expect(seqs(r)).toEqual([1]);
    r.stream.rebase(2);
    last().frame(3, ev());
    expect(seqs(r)).toEqual([1, 3]);
    r.stream.stop();
  });

  it('does not resync after a short hide', () => {
    const r = rig();
    r.stream.start();
    last().authOk();
    setHidden(true);
    vi.advanceTimersByTime(4 * 60_000);
    last().frame(0, { type: 'heartbeat' });
    setHidden(false);
    expect(r.resyncs).toEqual([]);
  });
});

describe('watchdog', () => {
  it('drops and retries a socket that went silent for 60 s', () => {
    const r = rig();
    r.stream.start();
    last().authOk();
    const first = last();
    vi.advanceTimersByTime(59_000);
    expect(r.stream.state).toBe('live');
    vi.advanceTimersByTime(1000);
    expect(first.closed).toBe(true);
    expect(r.stream.state).toBe('retrying');
    vi.advanceTimersByTime(500);
    expect(sockets()).toHaveLength(2);
    r.stream.stop();
  });

  it('is kept quiet by heartbeats', () => {
    const r = rig();
    r.stream.start();
    last().authOk();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(30_000);
      last().frame(0, { type: 'heartbeat' });
    }
    expect(r.stream.state).toBe('live');
    expect(sockets()).toHaveLength(1);
    r.stream.stop();
  });
});

describe('stop', () => {
  it('closes the socket, cancels retries and detaches listeners', () => {
    const r = rig();
    r.stream.start();
    last().authOk();
    const ws = last();
    r.stream.stop();
    expect(ws.closed).toBe(true);
    expect(r.stream.state).toBe('offline');
    ws.serverClose(1006);
    vi.advanceTimersByTime(600_000);
    setHidden(true);
    setHidden(false);
    window.dispatchEvent(new Event('online'));
    expect(sockets()).toHaveLength(1);
  });

  it('cancels a pending retry', () => {
    const r = rig();
    r.stream.start();
    last().serverClose(1006);
    r.stream.stop();
    vi.advanceTimersByTime(600_000);
    expect(sockets()).toHaveLength(1);
  });

  it('can start again after stop and keeps the cursor', () => {
    const r = rig();
    r.stream.start();
    last().authOk();
    last().frame(8, ev());
    r.stream.stop();
    r.stream.start();
    expect(sockets()).toHaveLength(2);
    expect(last().url).toContain('after=8');
    r.stream.stop();
  });
});
