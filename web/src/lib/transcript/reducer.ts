// Pure transcript reducer. History (GET /messages) and live events go through
// the same message appliers, so the same turn yields the same items either way.
//
// omp emits whole message objects, not just deltas: every message_update carries
// the message so far in `message` (and `assistantMessageEvent.partial`). Text is
// always taken from those blocks. Deltas are never appended, which keeps replays,
// resumes and a missed frame harmless.
import { isBlockingUi } from '../api/types';
import { sendNote } from '../composer/send';
import { extractFiles } from '../render/diff2';
import type {
  AssistantMessage, ContentBlock, CustomMessage, ModelRef, OmpEvent, OmpMessage,
  ToolCallBlock, ToolResultMessage, UiRequest, UnknownEvent, UserMessage,
} from '../api/types';
import type {
  AssistantItem, CommandItem, Item, NoticeItem, SkillItem, ThinkingItem, ToolItem,
  TranscriptInput, TranscriptState, UserItem,
} from './types';

type Ev<T extends OmpEvent['type']> = Extract<OmpEvent, { type: T }>;

interface Work {
  items: Item[];
  pendingUi: UiRequest[];
  running: boolean;
  counter: number;
}

interface Ctx {
  /** Live event (as opposed to a history load). */
  live: boolean;
  /** Client clock for the event, if the caller supplied one. */
  at?: number;
}

export function emptyTranscript(): TranscriptState {
  return { items: [], pendingUi: [], running: false, counter: 0 };
}

export function reduce(state: TranscriptState, input: TranscriptInput): TranscriptState {
  switch (input.kind) {
    case 'history':
      return fromHistory(state, input.messages, input.streaming === true);
    case 'event':
      return onEvent(state, input.event, input.at);
    case 'local-send': {
      if (state.items.some((it) => it.kind === 'user' && it.localId === input.localId)) return state;
      const d = open(state);
      const item: UserItem = {
        kind: 'user',
        id: `local:${input.localId}`,
        localId: input.localId,
        text: input.text,
        images: input.images?.length ?? 0,
        pending: true,
        note: sendNote(input.mode),
      };
      d.items.push(item);
      return d;
    }
    case 'local-send-failed': {
      const i = state.items.findIndex((it) => it.kind === 'user' && it.localId === input.localId);
      if (i < 0) return state;
      const d = open(state);
      d.items[i] = { ...(d.items[i] as UserItem), pending: false, failed: true, error: input.error };
      return d;
    }
    case 'pending-ui': {
      const d = open(state);
      d.pendingUi = input.requests.filter(isBlockingUi);
      return d;
    }
  }
}

function open(s: TranscriptState): Work {
  return { items: s.items.slice(), pendingUi: s.pendingUi.slice(), running: s.running, counter: s.counter };
}

// ------------------------------------------------------------------ helpers

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

interface Split {
  text: string;
  thinking: string;
  images: number;
  calls: ToolCallBlock[];
}

export function splitContent(content: string | ContentBlock[] | undefined): Split {
  if (typeof content === 'string') return { text: content, thinking: '', images: 0, calls: [] };
  const out: Split = { text: '', thinking: '', images: 0, calls: [] };
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    switch (b?.type) {
      case 'text': out.text += b.text ?? ''; break;
      case 'thinking': out.thinking += b.thinking ?? ''; break;
      case 'image': out.images += 1; break;
      case 'toolCall': out.calls.push(b); break;
    }
  }
  return out;
}

/** Text of a tool result: a toolResult message, a `{content, details}` result, or a plain string. */
export function resultText(r: unknown): string {
  if (r === null || r === undefined) return '';
  if (typeof r === 'string') return r;
  const o = rec(r);
  const c = o && 'content' in o ? o.content : r;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((x) => rec(x))
      .filter((x) => x?.type === 'text')
      .map((x) => String(x?.text ?? ''))
      .join('\n');
  }
  return JSON.stringify(r, null, 2);
}

function keyOf(m: { role: string; timestamp?: number }, messageId: string | undefined, fallback: string): string {
  if (typeof m.timestamp === 'number') return `${m.role}:${m.timestamp}`;
  return `${m.role}:${messageId ? `id:${messageId}` : fallback}`;
}

const SUMMARY_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url'];

export function summarize(args: Record<string, unknown> | undefined, intent: string | undefined): string {
  if (intent) return intent;
  if (!args) return '';
  for (const k of SUMMARY_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v) return v;
  }
  if (!Object.keys(args).length) return '';
  const j = JSON.stringify(args);
  return j.length > 300 ? `${j.slice(0, 300)}…` : j;
}

function normArgs(args: unknown): { args?: Record<string, unknown>; intent?: string } {
  const o = rec(args);
  if (!o) return {};
  const { i, ...rest } = o;
  return { args: rest, intent: typeof i === 'string' && i ? i : undefined };
}

const RANK: Partial<Record<Item['kind'], number>> = { thinking: 0, assistant: 1, tool: 2 };

/** Add an item. Items of one message stay together in thinking, text, tools order. */
function place(d: Work, item: Item): void {
  const key = item.messageKey;
  const rank = RANK[item.kind];
  if (key === undefined || rank === undefined) {
    d.items.push(item);
    return;
  }
  let after = -1;
  let before = -1;
  for (let i = 0; i < d.items.length; i++) {
    const it = d.items[i]!;
    if (it.messageKey !== key) continue;
    const r = RANK[it.kind];
    if (r === undefined) continue;
    if (r <= rank) after = i;
    else if (before < 0) before = i;
  }
  const at = after >= 0 ? after + 1 : before >= 0 ? before : d.items.length;
  d.items.splice(at, 0, item);
}

function findKeyed(d: Work, kind: Item['kind'], key: string): number {
  return d.items.findIndex((it) => it.kind === kind && it.messageKey === key);
}

function put(d: Work, i: number, item: Item): void {
  if (i >= 0) d.items[i] = item;
  else place(d, item);
}

function nextId(d: Work, prefix: string): string {
  d.counter += 1;
  return `${prefix}:${d.counter}`;
}

// ----------------------------------------------------------------- messages

function applyMessage(d: Work, m: OmpMessage, ctx: Ctx, opts: { messageId?: string; ending: boolean; thinkingStreaming?: boolean; fallback: string }): void {
  switch (m.role) {
    case 'user': applyUser(d, m, ctx, opts); return;
    case 'assistant': applyAssistant(d, m, ctx, opts); return;
    case 'toolResult': applyToolResult(d, m, ctx); return;
    case 'custom': applyCustom(d, m, ctx, opts); return;
  }
}

function applyUser(d: Work, m: UserMessage, ctx: Ctx, opts: { messageId?: string; fallback: string }): void {
  const b = splitContent(m.content);
  if (!b.text && !b.images) return;
  const key = keyOf(m, opts.messageId, opts.fallback);
  if (findKeyed(d, 'user', key) >= 0) return;
  const steering = m.steering === true;

  if (ctx.live) {
    const text = b.text.trim();
    // Steer echoes only confirm steers; plain echoes never swallow one. Without this
    // split, a normal prompt matching a pending steer would merge into it, and a
    // steering echo would upgrade an unrelated queued follow-up.
    const matches = (it: Item): it is UserItem =>
      it.kind === 'user' && it.pending && it.text.trim() === text &&
      (steering ? it.note === 'steer-pending' : it.note !== 'steer-pending');
    const i = d.items.findIndex(matches);
    if (i >= 0) {
      const prev = d.items[i] as UserItem;
      // A steering echo confirms a steer; a plain echo of a queued follow-up is the
      // next turn picking it up, so it reads as an ordinary message from here on.
      const note: UserItem['note'] = steering ? 'steer' : prev.note === 'queued' ? undefined : prev.note;
      d.items[i] = { ...prev, pending: false, note, messageKey: key, timestamp: m.timestamp, raw: m };
      return;
    }
    if (steering) {
      // The turn ended before this steer's echo: the stale item is still the same
      // message, so confirm it in place instead of adding a second bubble.
      const j = d.items.findIndex(
        (it) => it.kind === 'user' && it.note === 'steer-pending' && it.stale === true && it.text.trim() === text,
      );
      if (j >= 0) {
        d.items[j] = {
          ...(d.items[j] as UserItem),
          pending: false,
          stale: false,
          note: 'steer',
          messageKey: key,
          timestamp: m.timestamp,
          raw: m,
        };
        return;
      }
    }
  }
  d.items.push({
    kind: 'user',
    id: `u:${key}`,
    messageKey: key,
    text: b.text,
    images: b.images,
    pending: false,
    note: steering ? 'steer' : ctx.live ? 'other-client' : undefined,
    timestamp: m.timestamp,
    raw: m,
  });
}

function applyAssistant(d: Work, m: AssistantMessage, ctx: Ctx, opts: { messageId?: string; ending: boolean; thinkingStreaming?: boolean; fallback: string }): void {
  const key = keyOf(m, opts.messageId, opts.fallback);
  const b = splitContent(m.content);

  if (b.thinking) {
    const i = findKeyed(d, 'thinking', key);
    const prev = i >= 0 ? (d.items[i] as ThinkingItem) : undefined;
    const streaming = !opts.ending && opts.thinkingStreaming === true;
    const item: ThinkingItem = {
      kind: 'thinking',
      id: `th:${key}`,
      messageKey: key,
      text: b.thinking,
      streaming,
      startedAt: prev?.startedAt ?? ctx.at ?? m.timestamp,
      endedAt: !streaming && prev?.streaming ? (ctx.at ?? prev.endedAt) : prev?.endedAt,
      raw: m,
    };
    put(d, i, item);
  }

  const error = m.errorMessage || (m.stopReason === 'error' ? 'The model returned an error' : undefined);
  if (b.text || error) {
    const i = findKeyed(d, 'assistant', key);
    const item: AssistantItem = {
      kind: 'assistant',
      id: `a:${key}`,
      messageKey: key,
      text: b.text,
      streaming: !opts.ending,
      model: m.model,
      provider: m.provider,
      usage: m.usage,
      stopReason: m.stopReason,
      error,
      timestamp: m.timestamp,
      duration: m.duration,
      ttft: m.ttft,
      raw: m,
    };
    put(d, i, item);
  }

  for (const call of b.calls) {
    upsertTool(d, { id: call.id, name: call.name, args: call.arguments, intent: call.intent, messageKey: key, call });
  }
}

function applyToolResult(d: Work, m: ToolResultMessage, ctx: Ctx): void {
  const prev = d.items.find((it): it is ToolItem => it.kind === 'tool' && it.toolCallId === m.toolCallId);
  upsertTool(d, {
    id: m.toolCallId,
    name: m.toolName,
    output: resultText(m),
    status: m.isError ? 'error' : 'done',
    details: m.details,
    endedAt: prev?.endedAt ?? ctx.at ?? m.timestamp,
    result: m,
  });
}

function applyCustom(d: Work, m: CustomMessage, ctx: Ctx, opts: { messageId?: string; fallback: string }): void {
  const key = keyOf(m, opts.messageId, opts.fallback);
  const existing = d.items.findIndex((it) => it.messageKey === key && (it.kind === 'skill' || it.kind === 'notice'));
  if (existing >= 0) return;
  const b = splitContent(m.content);

  if (m.customType === 'skill-prompt') {
    const details = rec(m.details);
    const prompt = typeof details?.prompt === 'string' ? details.prompt : undefined;
    const name =
      (typeof details?.name === 'string' && details.name) ||
      /invoked the "([^"]+)" skill/.exec(b.text.split('\n', 1)[0] ?? '')?.[1] ||
      'skill';
    const skill: SkillItem = {
      kind: 'skill',
      id: `s:${key}`,
      messageKey: key,
      name,
      content: b.text,
      prompt,
      lineCount: typeof details?.lineCount === 'number' ? details.lineCount : undefined,
      timestamp: m.timestamp,
      raw: m,
    };
    if (ctx.live) {
      const i = d.items.findIndex(
        (it) => it.kind === 'user' && it.pending && (it.text.trim() === prompt || it.text.trim().startsWith('/')),
      );
      if (i >= 0) {
        d.items[i] = { ...skill, id: d.items[i]!.id };
        return;
      }
    }
    d.items.push(skill);
    return;
  }

  if (m.display === false || !b.text) return;
  d.items.push({ kind: 'notice', id: `n:${key}`, messageKey: key, level: 'info', text: b.text, raw: m });
}

// -------------------------------------------------------------------- tools

interface ToolPatch {
  id: string;
  name?: string;
  args?: unknown;
  intent?: string;
  messageKey?: string;
  output?: string;
  status?: ToolItem['status'];
  details?: unknown;
  startedAt?: number;
  endedAt?: number;
  call?: unknown;
  result?: unknown;
}

function upsertTool(d: Work, p: ToolPatch): void {
  const i = d.items.findIndex((it) => it.kind === 'tool' && it.toolCallId === p.id);
  const prev = i >= 0 ? (d.items[i] as ToolItem) : undefined;
  const n = normArgs(p.args);
  const args = n.args && Object.keys(n.args).length ? n.args : (prev?.args ?? n.args);
  const intent = p.intent || n.intent || prev?.intent;
  // A replayed start or update must not reopen a tool that already finished.
  const finished = prev !== undefined && prev.status !== 'running';
  const status = p.status ?? (finished ? prev.status : 'running');
  const item: ToolItem = {
    kind: 'tool',
    id: `tool:${p.id}`,
    messageKey: prev?.messageKey ?? p.messageKey,
    toolCallId: p.id,
    toolName: p.name || prev?.toolName || 'tool',
    args,
    summary: summarize(args, intent),
    intent,
    output: finished && p.status === undefined ? prev.output : (p.output ?? prev?.output ?? ''),
    status,
    details: p.details ?? prev?.details,
    startedAt: prev?.startedAt ?? p.startedAt,
    endedAt: p.endedAt ?? prev?.endedAt,
    raw: { ...rec(prev?.raw), ...(p.call !== undefined && { call: p.call }), ...(p.result !== undefined && { result: p.result }) },
  };
  // Results carry the diff details (edit) or just enough to synthesize from the
  // call arguments (write). Computed whenever a result has been applied and the
  // inputs for this tool are present, so a late tool_execution_start still
  // yields the same files as an in-order stream. Errored results contribute
  // nothing: the change never happened.
  if (p.result !== undefined || rec(prev?.raw)?.result !== undefined) {
    const files = status === 'error' ? [] : extractFiles(item.toolName, item.args, item.details);
    item.files = files.length ? files : undefined;
  } else {
    item.files = prev?.files;
  }
  if (i >= 0) d.items[i] = item;
  else place(d, item);
}

function interrupt(d: Work): void {
  for (let i = 0; i < d.items.length; i++) {
    const it = d.items[i]!;
    if (it.kind === 'tool' && it.status === 'running') d.items[i] = { ...it, status: 'interrupted' };
    else if ((it.kind === 'assistant' || it.kind === 'thinking') && it.streaming) d.items[i] = { ...it, streaming: false };
  }
}

// ------------------------------------------------------------------ history

function fromHistory(prev: TranscriptState, messages: readonly OmpMessage[], streaming: boolean): TranscriptState {
  const d: Work = { items: [], pendingUi: prev.pendingUi.slice(), running: streaming, counter: prev.counter };
  messages.forEach((m, i) => applyMessage(d, m, { live: false }, { ending: true, fallback: `h${i}` }));
  if (!streaming) interrupt(d);

  // Keep local sends the server has not echoed yet. Text match against recent user messages.
  const recent = d.items.filter((it): it is UserItem => it.kind === 'user').slice(-5);
  const used = new Set<UserItem>();
  for (const it of prev.items) {
    if (it.kind !== 'user' || !it.pending) continue;
    const text = it.text.trim();
    const hit = recent.find((r) => !used.has(r) && r.text.trim() === text);
    if (hit) used.add(hit);
    else if (!streaming && it.note === 'steer-pending') d.items.push({ ...it, pending: false, stale: true });
    else d.items.push(it);
  }
  return d;
}

// ------------------------------------------------------------------- events

function onEvent(state: TranscriptState, event: OmpEvent | UnknownEvent, at: number | undefined): TranscriptState {
  const ctx: Ctx = { live: true, at };
  switch (event.type) {
    case 'agent_start': {
      if (state.running) return state;
      const d = open(state);
      d.running = true;
      return d;
    }
    case 'agent_end': {
      const d = open(state);
      d.running = false;
      interrupt(d);
      // Steers the turn ended without echoing stay visible but unconfirmed: no echo
      // means we cannot tell consumed from dropped, so there is no "dropped" note.
      // Pending 'steer' is defensive (sendNote emits 'steer-pending'), but catch it
      // so a never-echoed steer can never read as confirmed.
      for (let i = 0; i < d.items.length; i++) {
        const it = d.items[i]!;
        if (it.kind === 'user' && it.pending && (it.note === 'steer-pending' || it.note === 'steer')) {
          d.items[i] = { ...it, pending: false, stale: true, note: 'steer-pending' };
        }
      }
      return d;
    }
    case 'session_settled': {
      if (!state.items.some((it) => it.kind === 'user' && it.pending)) return state;
      const d = open(state);
      d.items = d.items.map((it) => {
        if (it.kind !== 'user' || !it.pending) return it;
        return it.note === 'steer-pending' || it.note === 'steer'
          ? { ...it, pending: false, stale: true, note: 'steer-pending' }
          : { ...it, pending: false };
      });
      return d;
    }
    case 'prompt_result': {
      const ev = event as Ev<'prompt_result'>;
      if (ev.agentInvoked !== false) return state;
      const i = state.items.findIndex((it) => it.kind === 'user' && it.pending && it.text.trim().startsWith('/'));
      if (i < 0) return state;
      const d = open(state);
      d.items[i] = { ...(d.items[i] as UserItem), pending: false };
      return d;
    }
    case 'message_start':
    case 'message_update':
    case 'message_end': {
      const ev = event as Ev<'message_start' | 'message_update' | 'message_end'>;
      const m = ev.message ?? (ev.type === 'message_update' ? ev.assistantMessageEvent?.partial : undefined);
      if (!m) return state;
      const ame = ev.type === 'message_update' ? ev.assistantMessageEvent : undefined;
      const d = open(state);
      applyMessage(d, m, ctx, {
        messageId: ev.messageId,
        ending: ev.type === 'message_end',
        thinkingStreaming: !!ame && ame.type.startsWith('thinking_') && ame.type !== 'thinking_end',
        fallback: 'anon',
      });
      return d;
    }
    case 'tool_execution_start': {
      const ev = event as Ev<'tool_execution_start'>;
      const d = open(state);
      upsertTool(d, { id: ev.toolCallId, name: ev.toolName, args: ev.args, intent: ev.intent, startedAt: at });
      return d;
    }
    case 'tool_execution_update': {
      const ev = event as Ev<'tool_execution_update'>;
      const d = open(state);
      upsertTool(d, {
        id: ev.toolCallId, name: ev.toolName, args: ev.args, startedAt: at,
        output: ev.partialResult === undefined ? undefined : resultText(ev.partialResult),
      });
      return d;
    }
    case 'tool_execution_end': {
      const ev = event as Ev<'tool_execution_end'>;
      const d = open(state);
      upsertTool(d, {
        id: ev.toolCallId,
        name: ev.toolName,
        output: resultText(ev.result),
        status: ev.isError ? 'error' : 'done',
        details: rec(ev.result)?.details,
        startedAt: at,
        endedAt: at,
        result: ev.result,
      });
      return d;
    }
    case 'extension_ui_request': {
      const ev = event as Ev<'extension_ui_request'>;
      if (isBlockingUi(ev)) {
        if (state.pendingUi.some((u) => u.id === ev.id)) return state;
        const d = open(state);
        d.pendingUi.push(ev);
        return d;
      }
      if (ev.method === 'notify') {
        const text = ev.message || ev.title;
        const key = `ui:${ev.id}`;
        if (!text || state.items.some((it) => it.messageKey === key)) return state;
        const d = open(state);
        d.items.push({ kind: 'notice', id: `n:${key}`, messageKey: key, level: ev.notifyType === 'error' ? 'error' : 'info', text });
        return d;
      }
      return state;
    }
    case 'ui_resolved': {
      const ev = event as Ev<'ui_resolved'>;
      if (!state.pendingUi.some((u) => u.id === ev.id)) return state;
      const d = open(state);
      d.pendingUi = d.pendingUi.filter((u) => u.id !== ev.id);
      return d;
    }
    case 'command_output': {
      const ev = event as Ev<'command_output'>;
      const d = open(state);
      const i = d.items.findIndex((it) => it.kind === 'user' && it.pending && it.text.trim().startsWith('/'));
      const typed = i >= 0 ? (d.items[i] as UserItem) : undefined;
      const item: CommandItem = {
        kind: 'command',
        id: typed ? typed.id : nextId(d, 'c'),
        command: typed?.text.trim(),
        text: ev.text ?? '',
        raw: ev,
      };
      if (i >= 0) d.items[i] = item;
      else d.items.push(item);
      return d;
    }
    case 'auto_compaction_start': {
      const d = open(state);
      d.items.push({ kind: 'notice', id: nextId(d, 'n'), level: 'info', tag: 'compaction', active: true, text: 'Compacting context' });
      return d;
    }
    case 'auto_compaction_end': {
      const ev = event as Ev<'auto_compaction_end'>;
      const text = ev.errorMessage ? `Compaction failed: ${ev.errorMessage}` : ev.aborted ? 'Compaction stopped' : 'Context compacted';
      return closeNotice(state, 'compaction', ev.errorMessage ? 'error' : 'info', text);
    }
    case 'auto_retry_start': {
      const ev = event as Ev<'auto_retry_start'>;
      const of = ev.maxAttempts ? ` of ${ev.maxAttempts}` : '';
      const why = ev.errorMessage ? `: ${ev.errorMessage}` : '';
      const d = open(state);
      d.items.push({
        kind: 'notice', id: nextId(d, 'n'), level: 'info', tag: 'retry', active: true,
        text: `Retrying, attempt ${ev.attempt ?? 1}${of}${why}`,
      });
      return d;
    }
    case 'auto_retry_end': {
      const ev = event as Ev<'auto_retry_end'>;
      return ev.success
        ? closeNotice(state, 'retry', 'info', 'Recovered after retry')
        : closeNotice(state, 'retry', 'error', ev.finalError ? `Gave up retrying: ${ev.finalError}` : 'Gave up retrying');
    }
    case 'model_changed': {
      const ev = event as Ev<'model_changed'>;
      const name = modelName(ev.model);
      return name ? pushNotice(state, 'info', `Model: ${name}`) : state;
    }
    case 'thinking_level_changed': {
      const ev = event as Ev<'thinking_level_changed'>;
      const level = ev.level ?? ev.thinkingLevel;
      return level ? pushNotice(state, 'info', `Thinking: ${level}`) : state;
    }
    case 'notice': {
      const ev = event as Ev<'notice'>;
      const text = ev.message ?? ev.text;
      return text ? pushNotice(state, ev.level === 'error' ? 'error' : 'info', text) : state;
    }
    case 'extension_error': {
      const ev = event as Ev<'extension_error'>;
      return pushNotice(state, 'error', `Extension error: ${ev.error ?? 'unknown'}`);
    }
    default:
      return state;
  }
}

function modelName(m: ModelRef | string | undefined): string | undefined {
  if (!m) return undefined;
  return typeof m === 'string' ? m : m.name || m.id;
}

function pushNotice(state: TranscriptState, level: NoticeItem['level'], text: string): TranscriptState {
  const d = open(state);
  d.items.push({ kind: 'notice', id: nextId(d, 'n'), level, text });
  return d;
}

function closeNotice(state: TranscriptState, tag: NoticeItem['tag'], level: NoticeItem['level'], text: string): TranscriptState {
  const d = open(state);
  for (let i = d.items.length - 1; i >= 0; i--) {
    const it = d.items[i]!;
    if (it.kind === 'notice' && it.tag === tag && it.active) {
      d.items[i] = { ...it, level, text, active: false };
      return d;
    }
  }
  d.items.push({ kind: 'notice', id: nextId(d, 'n'), level, text, tag });
  return d;
}
