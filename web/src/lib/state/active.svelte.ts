// The open session: info, transcript, stream, approvals, stats and slash commands.
//
// Load order matters. `info` is fetched before `messages` so `info.lastEventSeq` is never
// newer than the history; any event in between is replayed on top and the reducer treats
// replays as no-ops. After a resync the stream holds events until we `rebase` it.
import { emitSignedOut } from '../api/client';
import { sessions as api, type PromptImage, type PromptMode } from '../api/endpoints';
import { SessionStream, type StreamStatus } from '../api/stream';
import type {
  ControlEvent, OmpMessage, SessionInfo, SessionStatsData, SlashCommand, ThinkingLevel, UiAnswer,
} from '../api/types';
import { cacheKey, idbDelete, idbGet, idbSet } from '../platform/idb';
import { emptyTranscript, reduce } from '../transcript/reducer';
import type { TranscriptInput, TranscriptState } from '../transcript/types';
import { sessionsStore } from './sessions.svelte';

export type Phase = 'idle' | 'loading' | 'ready' | 'gone' | 'error';

const CACHED_MESSAGES = 200;
const STATS_DEBOUNCE_MS = 600;

let localCounter = 0;

class ActiveSession {
  gwId = $state<string | null>(null);
  phase = $state<Phase>('idle');
  error = $state<string | null>(null);
  info = $state.raw<SessionInfo | null>(null);
  transcript = $state.raw<TranscriptState>(emptyTranscript());
  connection = $state.raw<StreamStatus>({ state: 'offline', retryAt: null, message: null });
  stats = $state.raw<SessionStatsData | null>(null);
  commands = $state.raw<SlashCommand[]>([]);
  /** Set when omp reports a websocket-level error for this session. Cleared on the next send. */
  wsError = $state<string | null>(null);

  pendingUi = $derived(this.transcript.pendingUi);
  running = $derived(this.transcript.running);

  private stream: SessionStream | null = null;
  private generation = 0;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;

  async open(gwId: string): Promise<void> {
    if (this.gwId === gwId && this.phase !== 'error' && this.phase !== 'gone') return;
    this.close();
    const gen = ++this.generation;
    this.gwId = gwId;
    this.phase = 'loading';
    this.error = null;

    void this.paintCache(gwId, gen);
    try {
      const snap = await this.snapshot(gwId);
      if (gen !== this.generation) return;
      this.applySnapshot(snap.info, snap.messages);
      this.phase = 'ready';
      this.startStream(gwId, snap.info.lastEventSeq, gen);
      void this.loadCommands();
      void this.refreshStats();
    } catch (e) {
      if (gen !== this.generation) return;
      const status = (e as { status?: number }).status;
      this.phase = status === 404 ? 'gone' : 'error';
      this.error = e instanceof Error ? e.message : 'Could not open the session';
    }
  }

  close(): void {
    this.generation++;
    this.stream?.stop();
    this.stream = null;
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = null;
    this.gwId = null;
    this.phase = 'idle';
    this.error = null;
    this.info = null;
    this.transcript = emptyTranscript();
    this.stats = null;
    this.commands = [];
    this.wsError = null;
    this.connection = { state: 'offline', retryAt: null, message: null };
  }

  reconnect(): void {
    this.stream?.reconnectNow();
  }

  /** Optimistic send. The reducer shows a pending bubble; the echo (or a failure) settles it. */
  async send(text: string, mode: PromptMode = 'prompt', images?: PromptImage[]): Promise<boolean> {
    const gwId = this.gwId;
    if (!gwId) return false;
    const localId = `local-${++localCounter}`;
    this.wsError = null;
    this.dispatch({ kind: 'local-send', localId, text, mode, images });
    try {
      const info = await api.prompt(gwId, text, mode, images);
      if (this.gwId === gwId) this.setInfo(info);
      return true;
    } catch (e) {
      if (this.gwId === gwId) {
        this.dispatch({
          kind: 'local-send-failed', localId, error: e instanceof Error ? e.message : 'Send failed',
        });
      }
      return false;
    }
  }

  abort(): Promise<unknown> {
    return this.need((id) => api.abort(id));
  }

  answerUi(requestId: string, answer: UiAnswer): Promise<unknown> {
    return this.need((id) => api.answerUi(id, requestId, answer));
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.need((id) => api.setModel(id, provider, modelId));
    await this.refreshInfo();
  }

  async setThinking(level: ThinkingLevel): Promise<void> {
    await this.need((id) => api.setThinking(id, level));
    await this.refreshInfo();
  }

  async rename(name: string): Promise<void> {
    await this.need((id) => api.rename(id, name));
    await this.refreshInfo();
  }

  async compact(instructions?: string): Promise<void> {
    await this.need((id) => api.compact(id, instructions));
    await this.refreshInfo();
  }

  async refreshInfo(): Promise<void> {
    const gwId = this.gwId;
    if (!gwId) return;
    try {
      const info = await api.info(gwId);
      if (this.gwId === gwId) this.setInfo(info);
    } catch {
      /* the stream reports real trouble */
    }
  }

  async refreshStats(): Promise<void> {
    const gwId = this.gwId;
    if (!gwId) return;
    try {
      const r = await api.stats(gwId);
      if (this.gwId === gwId) this.stats = r.data;
    } catch {
      /* stats are optional */
    }
  }

  async loadCommands(): Promise<void> {
    const gwId = this.gwId;
    if (!gwId) return;
    try {
      const r = await api.commands(gwId);
      if (this.gwId === gwId) this.commands = r.data.commands;
    } catch {
      /* the palette works without slash commands */
    }
  }

  /** Forget the cached transcript, e.g. after the session was stopped for good. */
  async forgetCache(gwId: string): Promise<void> {
    await idbDelete(cacheKey('messages', gwId));
  }

  // ---------------------------------------------------------------- internals

  private dispatch(input: TranscriptInput): void {
    this.transcript = reduce(this.transcript, input);
  }

  private async need<T>(fn: (gwId: string) => Promise<T>): Promise<T> {
    if (!this.gwId) throw new Error('No open session');
    return fn(this.gwId);
  }

  private setInfo(info: SessionInfo): void {
    this.info = info;
    sessionsStore.patch(info);
  }

  private async snapshot(gwId: string): Promise<{ info: SessionInfo; messages: OmpMessage[] }> {
    const info = await api.info(gwId);
    const { messages } = await api.messages(gwId);
    return { info, messages };
  }

  private applySnapshot(info: SessionInfo, messages: OmpMessage[]): void {
    this.setInfo(info);
    this.dispatch({ kind: 'history', messages, streaming: info.isStreaming });
    this.dispatch({ kind: 'pending-ui', requests: info.pendingUi });
    void idbSet(cacheKey('messages', info.gwId), messages.slice(-CACHED_MESSAGES));
  }

  private async paintCache(gwId: string, gen: number): Promise<void> {
    const cached = await idbGet<OmpMessage[]>(cacheKey('messages', gwId));
    if (!cached?.length || gen !== this.generation || this.phase !== 'loading') return;
    this.dispatch({ kind: 'history', messages: cached });
  }

  private startStream(gwId: string, after: number, gen: number): void {
    const stream = new SessionStream({
      gwId,
      after,
      onEvent: (event) => {
        if (gen !== this.generation) return;
        this.dispatch({ kind: 'event', event, at: Date.now() });
        if (event.type === 'agent_end') this.scheduleStats();
      },
      onControl: (frame) => {
        if (gen === this.generation) this.onControl(frame);
      },
      onState: (status) => {
        if (gen === this.generation) this.connection = status;
      },
      onResync: () => void this.resync(gen),
      onSignedOut: () => emitSignedOut(),
      onGone: () => {
        if (gen !== this.generation) return;
        this.phase = 'gone';
        sessionsStore.remove(gwId);
      },
    });
    this.stream = stream;
    stream.start();
  }

  private onControl(frame: ControlEvent): void {
    if (frame.type === 'auth_ok') {
      this.setInfo(frame.session);
      this.dispatch({ kind: 'pending-ui', requests: frame.session.pendingUi });
    } else if (frame.type === 'ws_error') {
      this.wsError = frame.error;
    }
  }

  private async resync(gen: number): Promise<void> {
    const gwId = this.gwId;
    const stream = this.stream;
    if (!gwId || !stream) return;
    try {
      const snap = await this.snapshot(gwId);
      if (gen !== this.generation) return;
      this.applySnapshot(snap.info, snap.messages);
      stream.rebase(snap.info.lastEventSeq);
    } catch {
      // Release held events so the stream keeps flowing; the next gap tries again.
      if (gen === this.generation) stream.rebase(stream.lastSeq);
    }
  }

  private scheduleStats(): void {
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = setTimeout(() => {
      void this.refreshStats();
      void this.refreshInfo();
    }, STATS_DEBOUNCE_MS);
  }
}

export const active = new ActiveSession();
