// WebSocket transport for one open session. Owns the resume cursor, dedupe by
// seq, reconnect with full-jitter backoff, the stable-open rule, the heartbeat
// watchdog, and visibility/online handling. UI code never touches WebSocket.
import { wsBaseUrl } from './client';
import type { AuthOkFrame, ControlEvent, OmpEvent, UnknownEvent } from './types';

export type StreamState = 'connecting' | 'live' | 'retrying' | 'offline' | 'gone';
export type ResyncReason = 'gap' | 'hidden';

export interface StreamStatus {
  state: StreamState;
  /** Epoch ms of the next attempt while `retrying`, else null. */
  retryAt: number | null;
  /** Human-readable note, e.g. the lockout message from a 4429 close. Cleared once live. */
  message: string | null;
}

export interface StreamHandlers {
  /** An omp event with seq > 0, delivered once, in order. */
  onEvent?(event: OmpEvent | UnknownEvent, seq: number): void;
  /** `auth_ok` (session snapshot), `ws_error`, `rpc_response`. Heartbeats and pongs are swallowed. */
  onControl?(frame: ControlEvent): void;
  onState?(status: StreamStatus): void;
  /**
   * Local state may be stale (backlog gap, or the tab was hidden for a long time).
   * Refetch state and messages, then call `stream.rebase(info.lastEventSeq)`. Until then
   * incoming events are held so they can't be applied twice on top of fresh history.
   */
  onResync?(reason: ResyncReason): void;
  /** Close code 4401. The stream stops. */
  onSignedOut?(): void;
  /** Close code 4404: the session is not running. The stream stops. */
  onGone?(): void;
}

export interface StreamTuning {
  baseDelayMs: number;
  capDelayMs: number;
  /** A socket must stay open this long after auth_ok before the attempt counter resets. */
  stableMs: number;
  /** No frame for this long while live: assume the socket is dead. */
  watchdogMs: number;
  /** Hidden longer than this: resync instead of trusting the delta. */
  hiddenResyncMs: number;
  lockoutRetryMs: number;
  /** Safety valve: release held events if the caller never rebases. */
  holdTimeoutMs: number;
}

export const DEFAULT_TUNING: StreamTuning = {
  baseDelayMs: 1000,
  capDelayMs: 30_000,
  stableMs: 5000,
  watchdogMs: 60_000,
  hiddenResyncMs: 5 * 60_000,
  lockoutRetryMs: 60_000,
  holdTimeoutMs: 15_000,
};

export interface StreamOptions extends StreamHandlers {
  gwId: string;
  /** Last seq already applied to local state. */
  after?: number;
  tuning?: Partial<StreamTuning>;
  random?: () => number;
  WebSocketImpl?: typeof WebSocket;
}

const WATCHDOG_TICK_MS = 5000;

export class SessionStream {
  readonly gwId: string;
  private cursor: number;
  private status: StreamStatus = { state: 'offline', retryAt: null, message: null };

  private readonly handlers: StreamHandlers;
  private readonly tune: StreamTuning;
  private readonly random: () => number;
  private readonly WS: typeof WebSocket;

  private ws: WebSocket | null = null;
  private started = false;
  private attempts = 0;
  private lastFrameAt = 0;
  private hiddenAt: number | null = null;
  private lockedUntil = 0;
  private held: Map<number, OmpEvent | UnknownEvent> | null = null;

  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(opts: StreamOptions) {
    this.gwId = opts.gwId;
    this.cursor = opts.after ?? 0;
    this.handlers = opts;
    this.tune = { ...DEFAULT_TUNING, ...opts.tuning };
    this.random = opts.random ?? Math.random;
    this.WS = opts.WebSocketImpl ?? WebSocket;
  }

  get lastSeq(): number { return this.cursor; }
  get state(): StreamState { return this.status.state; }
  get retryAt(): number | null { return this.status.retryAt; }
  get message(): string | null { return this.status.message; }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline);
    this.connect();
  }

  stop(): void {
    this.started = false;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline);
    this.clearRetry();
    this.clearLive();
    this.clearHold();
    this.held = null;
    this.dropSocket();
    if (this.status.state !== 'gone') this.setStatus('offline', null, null);
  }

  /** Reconnect immediately with the current cursor, unless the gateway has locked us out. */
  reconnectNow(): void {
    if (!this.started || this.status.state === 'gone' || Date.now() < this.lockedUntil) return;
    this.clearRetry();
    this.clearLive();
    this.dropSocket();
    this.connect();
  }

  /**
   * Call after refetching state and messages in response to `onResync` (or any time the
   * caller holds a snapshot taken at `seq`). Raises the cursor and releases held events.
   */
  rebase(seq: number): void {
    if (seq > this.cursor) this.cursor = seq;
    this.release();
  }

  /** Send a client frame (a JSON-able RpcCommand, `"ping"`, ...). False when the socket isn't open. */
  send(frame: unknown): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
    return true;
  }

  // ------------------------------------------------------------- connection

  private connect(): void {
    if (!this.started) return;
    this.clearRetry();
    this.setStatus('connecting', null, this.status.message);
    const url = `${wsBaseUrl()}/omp-ws/${encodeURIComponent(this.gwId)}?after=${this.cursor}`;
    let ws: WebSocket;
    try {
      ws = new this.WS(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onFrame(ev.data);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onClose(ev.code, ev.reason);
    };
    ws.onerror = () => { /* a close event always follows */ };
  }

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* already closing */ }
  }

  private onClose(code: number, reason: string): void {
    this.clearLive();
    if (!this.started) return;
    switch (code) {
      case 4401:
        this.started = false;
        this.detachListeners();
        this.setStatus('offline', null, null);
        this.handlers.onSignedOut?.();
        return;
      case 4404:
        this.started = false;
        this.detachListeners();
        this.setStatus('gone', null, null);
        this.handlers.onGone?.();
        return;
      case 4429: {
        this.lockedUntil = Date.now() + this.tune.lockoutRetryMs;
        this.status = { ...this.status, message: reason || 'Too many failed attempts. Retrying in a minute.' };
        this.scheduleRetry(this.tune.lockoutRetryMs);
        return;
      }
      case 4408:
        // Dropped as a slow consumer: come straight back, but only the first time in a row.
        this.scheduleRetry(this.attempts === 0 ? 0 : undefined);
        return;
      default:
        this.scheduleRetry();
    }
  }

  private scheduleRetry(fixedDelayMs?: number): void {
    if (!this.started) return;
    if (fixedDelayMs === undefined && (this.isHidden() || this.isOffline())) {
      // Wait for visibilitychange / online instead of burning timers.
      this.setStatus('offline', null, this.status.message);
      return;
    }
    const cap = Math.min(this.tune.capDelayMs, this.tune.baseDelayMs * 2 ** this.attempts);
    const delay = fixedDelayMs ?? Math.floor(this.random() * cap);
    this.attempts += 1;
    const retryAt = Date.now() + delay;
    this.setStatus('retrying', retryAt, this.status.message);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  // ---------------------------------------------------------------- frames

  private onFrame(data: unknown): void {
    this.lastFrameAt = Date.now();
    if (typeof data !== 'string') return;
    let d: { seq?: unknown; event?: { type?: unknown } } | null;
    try { d = JSON.parse(data); } catch { return; }
    const ev = d?.event;
    if (!ev || typeof ev.type !== 'string') return;
    const seq = typeof d?.seq === 'number' ? d.seq : 0;

    if (seq > 0) {
      if (seq <= this.cursor) return;
      if (this.held) { this.held.set(seq, ev as OmpEvent); return; }
      this.cursor = seq;
      this.handlers.onEvent?.(ev as OmpEvent, seq);
      return;
    }

    switch (ev.type) {
      case 'auth_ok': this.onAuthOk(ev as AuthOkFrame); return;
      case 'heartbeat':
      case 'pong': return;
      default: this.handlers.onControl?.(ev as ControlEvent);
    }
  }

  private onAuthOk(frame: AuthOkFrame): void {
    this.setStatus('live', null, null);
    this.clearLive();
    this.lastFrameAt = Date.now();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.attempts = 0;
    }, this.tune.stableMs);
    this.watchdog = setInterval(this.checkWatchdog, WATCHDOG_TICK_MS);
    this.handlers.onControl?.(frame);
    if (frame.gap === true) this.requestResync('gap');
  }

  private checkWatchdog = (): void => {
    if (this.status.state !== 'live' || Date.now() - this.lastFrameAt < this.tune.watchdogMs) return;
    this.clearLive();
    this.dropSocket();
    this.scheduleRetry();
  };

  // ---------------------------------------------------------------- resync

  private requestResync(reason: ResyncReason): void {
    if (this.held) return;
    this.held = new Map();
    this.holdTimer = setTimeout(() => this.release(), this.tune.holdTimeoutMs);
    this.handlers.onResync?.(reason);
  }

  private release(): void {
    this.clearHold();
    const buf = this.held;
    this.held = null;
    if (!buf) return;
    for (const seq of [...buf.keys()].sort((a, b) => a - b)) {
      if (seq <= this.cursor) continue;
      this.cursor = seq;
      this.handlers.onEvent?.(buf.get(seq)!, seq);
    }
  }

  // ------------------------------------------------------ page life-cycle

  private onVisibility = (): void => {
    if (!this.started) return;
    if (this.isHidden()) {
      this.hiddenAt = Date.now();
      return;
    }
    const hiddenFor = this.hiddenAt === null ? 0 : Date.now() - this.hiddenAt;
    this.hiddenAt = null;
    if (hiddenFor > this.tune.hiddenResyncMs) {
      this.requestResync('hidden');
      // The socket may be a zombie after a long freeze: replace it.
      this.reconnectNow();
      return;
    }
    this.wake();
  };

  private onOnline = (): void => {
    if (this.started) this.wake();
  };

  private wake(): void {
    const s = this.status.state;
    if (s === 'retrying' || s === 'offline') this.reconnectNow();
  }

  private detachListeners(): void {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline);
  }

  private isHidden(): boolean {
    return typeof document !== 'undefined' && document.hidden;
  }

  private isOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  // ---------------------------------------------------------------- helpers

  private setStatus(state: StreamState, retryAt: number | null, message: string | null): void {
    const prev = this.status;
    if (prev.state === state && prev.retryAt === retryAt && prev.message === message) return;
    this.status = { state, retryAt, message };
    this.handlers.onState?.(this.status);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearLive(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.stableTimer = this.watchdog = null;
  }

  private clearHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }
}
