import { describe, expect, it } from 'vitest';
import type { MessagesResponse, OmpEvent, UnknownEvent, UiRequest } from '../../api/types';
import { emptyTranscript, reduce, resultText, splitContent, summarize } from '../reducer';
import type { Item, ToolItem, TranscriptInput, TranscriptState } from '../types';
import historyFixture from '../__fixtures__/messages.json';
import turnFixture from '../__fixtures__/turn-tools-markdown.json';
import slashFixture from '../__fixtures__/slash.json';

type Frame = { seq: number; event: unknown };
const history = historyFixture as unknown as MessagesResponse;
const turn = turnFixture as unknown as Frame[];
const slash = (slashFixture as unknown as { events: Frame[] }).events;

const ev = (event: unknown, at?: number): TranscriptInput => ({
  kind: 'event',
  event: event as OmpEvent | UnknownEvent,
  at,
});

function play(frames: Frame[], from: TranscriptState = emptyTranscript()): TranscriptState {
  return frames.reduce((s, f) => reduce(s, ev(f.event)), from);
}

/** Drop what legitimately differs between history and live (timing, source objects, other-client note). */
function normalize(items: readonly Item[]) {
  return items.map((it) => {
    const { raw: _raw, startedAt: _s, endedAt: _e, note: _n, details: _d, ...rest } = it as Item & {
      startedAt?: number; endedAt?: number; note?: string; details?: unknown;
    };
    return rest;
  });
}

const fromUser = (items: readonly Item[], prefix: string) => {
  const i = items.findIndex((it) => it.kind === 'user' && it.text.startsWith(prefix));
  expect(i).toBeGreaterThanOrEqual(0);
  return items.slice(i);
};

describe('history', () => {
  const s = reduce(emptyTranscript(), { kind: 'history', messages: history.messages });

  it('builds items in reading order', () => {
    expect(s.items.map((i) => i.kind)).toEqual([
      'skill', 'thinking', 'assistant', 'user', 'thinking', 'tool', 'tool', 'assistant',
    ]);
  });

  it('parses the skill name and keeps the injected prompt', () => {
    const skill = s.items[0]!;
    if (skill.kind !== 'skill') throw new Error('expected skill');
    expect(skill.name).toBe('humanizer');
    expect(skill.prompt).toBe('/skill:humanizer');
    expect(skill.content.length).toBeGreaterThan(0);
  });

  it('pairs tool calls with their results and uses the intent as summary', () => {
    const tools = s.items.filter((i): i is ToolItem => i.kind === 'tool');
    expect(tools.map((t) => [t.toolName, t.status, t.summary])).toEqual([
      ['bash', 'done', 'Listing gateway directory'],
      ['read', 'done', 'Reading README.md first lines'],
    ]);
    expect(tools[0]!.args).toEqual({ command: 'ls gateway' });
    expect(tools[0]!.output).toContain('bridge.py');
  });

  it('is not running and has no interrupted tools', () => {
    expect(s.running).toBe(false);
    expect(s.items.some((i) => i.kind === 'tool' && i.status === 'interrupted')).toBe(false);
  });

  it('marks tools without a result interrupted when the session is idle, running when streaming', () => {
    const open = history.messages.slice(0, 4);
    const idle = reduce(emptyTranscript(), { kind: 'history', messages: open });
    expect(idle.items.filter((i) => i.kind === 'tool').map((t) => (t as ToolItem).status)).toEqual([
      'interrupted', 'interrupted',
    ]);
    const busy = reduce(emptyTranscript(), { kind: 'history', messages: open, streaming: true });
    expect(busy.running).toBe(true);
    expect(busy.items.filter((i) => i.kind === 'tool').map((t) => (t as ToolItem).status)).toEqual([
      'running', 'running',
    ]);
  });
});

describe('live events', () => {
  it('yields the same items as history for the same turn', () => {
    const live = play(turn);
    const hist = reduce(emptyTranscript(), { kind: 'history', messages: history.messages });
    const prefix = 'Run `ls gateway`';
    expect(normalize(fromUser(live.items, prefix))).toEqual(normalize(fromUser(hist.items, prefix)));
  });

  it('handles a capture that starts in the middle of a message', () => {
    const live = play(turn);
    const first = live.items.find((i) => i.kind === 'assistant');
    expect(first?.kind === 'assistant' && first.text).toContain('Skill');
    expect(live.items.filter((i) => i.kind === 'assistant' && i.streaming)).toHaveLength(0);
  });

  it('tracks the run state and finishes streaming flags', () => {
    const start = turn.findIndex((f) => (f.event as { type: string }).type === 'agent_start');
    const mid = play(turn.slice(start, start + 1));
    expect(mid.running).toBe(true);
    expect(play(turn).running).toBe(false);
  });

  it('shows streaming text as it grows and closes it on message_end', () => {
    const updates = turn.filter((f) => {
      const e = f.event as { type: string; messageId?: string };
      return e.type === 'message_update' && e.messageId === 'msg-7';
    });
    const start = turn.find((f) => (f.event as { type: string; messageId?: string }).messageId === 'msg-7')!;
    let s = reduce(emptyTranscript(), ev(start.event));
    s = reduce(s, ev(updates[0]!.event));
    const streaming = s.items.find((i) => i.kind === 'assistant');
    expect(streaming?.kind === 'assistant' && streaming.streaming).toBe(true);
    const end = turn.find((f) => (f.event as { type: string; messageId?: string }).type === 'message_end' && (f.event as { messageId?: string }).messageId === 'msg-7')!;
    s = reduce(s, ev(end.event));
    const done = s.items.find((i) => i.kind === 'assistant');
    expect(done?.kind === 'assistant' && done.streaming).toBe(false);
    expect(s.items.filter((i) => i.kind === 'assistant')).toHaveLength(1);
  });

  it('is idempotent when live events replay on top of history', () => {
    const hist = reduce(emptyTranscript(), { kind: 'history', messages: history.messages });
    const after = play(turn, hist);
    expect(after.items.map((i) => i.id)).toEqual(hist.items.map((i) => i.id));
    expect(normalize(after.items)).toEqual(normalize(hist.items));
  });

  it('ignores unknown event types and returns the same state', () => {
    const s = emptyTranscript();
    expect(reduce(s, ev({ type: 'advisor_cost_changed' }))).toBe(s);
    expect(reduce(s, ev({ type: 'something_new', x: 1 }))).toBe(s);
    expect(reduce(s, ev({ type: 'message_update' }))).toBe(s);
  });

  it('never reopens a finished tool when a start or update is replayed', () => {
    let s = reduce(emptyTranscript(), ev({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } }, 10));
    s = reduce(s, ev({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false }, 20));
    s = reduce(s, ev({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } }, 30));
    s = reduce(s, ev({ type: 'tool_execution_update', toolCallId: 't1', partialResult: { content: [] } }, 31));
    const t = s.items[0] as ToolItem;
    expect(t.status).toBe('done');
    expect(t.output).toBe('ok');
    expect(t.startedAt).toBe(10);
    expect(t.endedAt).toBe(20);
    expect(t.summary).toBe('ls');
  });

  it('marks errored tools and interrupts leftovers on agent_end', () => {
    let s = reduce(emptyTranscript(), ev({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash', args: {} }));
    s = reduce(s, ev({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash', args: {} }));
    s = reduce(s, ev({ type: 'tool_execution_end', toolCallId: 'a', result: 'boom', isError: true }));
    s = reduce(s, ev({ type: 'agent_end' }));
    expect(s.items.map((i) => (i as ToolItem).status)).toEqual(['error', 'interrupted']);
  });

  it('keeps items of one message together even when other items arrive in between', () => {
    const msg = (content: unknown[]) => ({ role: 'assistant', timestamp: 5, content });
    let s = reduce(emptyTranscript(), ev({ type: 'message_update', message: msg([{ type: 'text', text: 'hi' }]), assistantMessageEvent: { type: 'text_delta' } }));
    s = reduce(s, { kind: 'local-send', localId: 'x', text: 'steer me', mode: 'steer' });
    s = reduce(s, ev({ type: 'message_update', message: msg([{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'hi' }]), assistantMessageEvent: { type: 'thinking_delta' } }));
    s = reduce(s, ev({ type: 'message_update', message: msg([{ type: 'text', text: 'hi' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }]), assistantMessageEvent: { type: 'toolcall_end' } }));
    expect(s.items.map((i) => i.kind)).toEqual(['thinking', 'assistant', 'tool', 'user']);
  });
});

describe('echo dedupe and local sends', () => {
  const userMsg = (text: string, timestamp: number) => ({ role: 'user', content: [{ type: 'text', text }], timestamp });

  it('shows a local send as pending, then confirms it on echo without a duplicate', () => {
    let s = reduce(emptyTranscript(), { kind: 'local-send', localId: '1', text: 'hello', mode: 'prompt' });
    expect(s.items).toHaveLength(1);
    expect((s.items[0] as { pending: boolean }).pending).toBe(true);
    s = reduce(s, ev({ type: 'message_start', message: userMsg('hello', 100), messageId: 'msg-1' }));
    s = reduce(s, ev({ type: 'message_end', message: userMsg('hello', 100), messageId: 'msg-1' }));
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: 'user', pending: false, id: 'local:1', messageKey: 'user:100' });
    expect((s.items[0] as { note?: string }).note).toBeUndefined();
  });

  it('matches the echo on trimmed text and only once per pending item', () => {
    let s = reduce(emptyTranscript(), { kind: 'local-send', localId: '1', text: 'same ', mode: 'prompt' });
    s = reduce(s, { kind: 'local-send', localId: '2', text: 'same', mode: 'follow_up' });
    s = reduce(s, ev({ type: 'message_start', message: userMsg('same', 1) }));
    expect(s.items.map((i) => (i as { pending: boolean }).pending)).toEqual([false, true]);
    s = reduce(s, ev({ type: 'message_start', message: userMsg('same', 2) }));
    expect(s.items.map((i) => (i as { pending: boolean }).pending)).toEqual([false, false]);
    expect(s.items).toHaveLength(2);
  });

  it('adds a user message from another client with a note', () => {
    const s = reduce(emptyTranscript(), ev({ type: 'message_start', message: userMsg('from phone', 7) }));
    expect(s.items[0]).toMatchObject({ kind: 'user', text: 'from phone', note: 'other-client', pending: false });
  });

  it('notes steer and queued sends', () => {
    let s = reduce(emptyTranscript(), { kind: 'local-send', localId: '1', text: 'a', mode: 'steer' });
    s = reduce(s, { kind: 'local-send', localId: '2', text: 'b', mode: 'follow_up' });
    s = reduce(s, { kind: 'local-send', localId: '3', text: 'c', mode: 'prompt', images: [{ type: 'image', data: 'x', mimeType: 'image/png' }] });
    expect(s.items.map((i) => (i as { note?: string }).note)).toEqual(['steer', 'queued', undefined]);
    expect((s.items[2] as { images: number }).images).toBe(1);
  });

  it('ignores a repeated local send id', () => {
    const s = reduce(emptyTranscript(), { kind: 'local-send', localId: '1', text: 'a', mode: 'prompt' });
    expect(reduce(s, { kind: 'local-send', localId: '1', text: 'a', mode: 'prompt' })).toBe(s);
  });

  it('marks a failed send', () => {
    let s = reduce(emptyTranscript(), { kind: 'local-send', localId: '1', text: 'a', mode: 'prompt' });
    s = reduce(s, { kind: 'local-send-failed', localId: '1', error: 'Could not reach the gateway' });
    expect(s.items[0]).toMatchObject({ pending: false, failed: true, error: 'Could not reach the gateway' });
  });

  it('settles leftover pending sends on session_settled', () => {
    let s = reduce(emptyTranscript(), { kind: 'local-send', localId: '1', text: 'expanded later', mode: 'prompt' });
    s = reduce(s, ev({ type: 'session_settled' }));
    expect((s.items[0] as { pending: boolean }).pending).toBe(false);
  });

  it('keeps an unechoed local send across a history reload, and drops it once history has it', () => {
    const base = reduce(emptyTranscript(), { kind: 'history', messages: history.messages });
    let s = reduce(base, { kind: 'local-send', localId: '1', text: 'brand new', mode: 'prompt' });
    s = reduce(s, { kind: 'history', messages: history.messages });
    expect(s.items.at(-1)).toMatchObject({ kind: 'user', text: 'brand new', pending: true });
    const withEcho = [...history.messages, { role: 'user', content: 'brand new', timestamp: 9e12 } as const];
    s = reduce(s, { kind: 'history', messages: withEcho });
    expect(s.items.filter((i) => i.kind === 'user' && i.text === 'brand new')).toHaveLength(1);
    expect(s.items.at(-1)).toMatchObject({ pending: false });
  });
});

describe('slash commands', () => {
  it('turns command output into command items with ANSI intact', () => {
    const s = play(slash);
    const cmds = s.items.filter((i) => i.kind === 'command');
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toMatchObject({ kind: 'command', command: undefined });
    expect((cmds[0] as { text: string }).text).toContain('Context window');
    expect((cmds[0] as { text: string }).text).toContain('\x1b[');
    expect((cmds[1] as { text: string }).text).toMatch(/^Usage/);
  });

  it('renders the skill prompt without a user echo, before the assistant reply', () => {
    const s = play(slash);
    expect(s.items.map((i) => i.kind)).toEqual(['command', 'command', 'skill', 'thinking', 'assistant']);
    expect(s.items[2]).toMatchObject({ kind: 'skill', name: 'humanizer' });
    expect(s.items.some((i) => i.kind === 'user')).toBe(false);
  });

  it('gives the same skill item from history', () => {
    const live = play(slash).items.find((i) => i.kind === 'skill');
    const hist = reduce(emptyTranscript(), { kind: 'history', messages: history.messages }).items.find((i) => i.kind === 'skill');
    expect(normalize([live!])).toEqual(normalize([hist!]));
  });

  it('replaces the pending slash bubble with the command output in place', () => {
    let s = reduce(emptyTranscript(), { kind: 'local-send', localId: '1', text: '/context', mode: 'prompt' });
    s = reduce(s, ev({ type: 'command_output', text: 'Context window: 10' }));
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: 'command', command: '/context', text: 'Context window: 10', id: 'local:1' });
  });

  it('replaces the pending /skill bubble with the skill item', () => {
    let s = reduce(emptyTranscript(), { kind: 'local-send', localId: '1', text: '/skill:humanizer', mode: 'prompt' });
    s = play(slash.filter((f) => (f.event as { type: string }).type === 'message_start').slice(0, 1), s);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: 'skill', name: 'humanizer' });
  });

  it('settles a silent slash command on prompt_result', () => {
    let s = reduce(emptyTranscript(), { kind: 'local-send', localId: '1', text: '/name foo', mode: 'prompt' });
    s = reduce(s, ev({ type: 'prompt_result', agentInvoked: false, status: 'completed' }));
    expect(s.items[0]).toMatchObject({ kind: 'user', pending: false });
  });
});

describe('pending UI', () => {
  const ask = (id: string, method = 'confirm'): UiRequest => ({ id, method, title: 'Run it?' });

  it('collects blocking requests once and resolves them', () => {
    let s = reduce(emptyTranscript(), ev({ type: 'extension_ui_request', ...ask('a') }));
    s = reduce(s, ev({ type: 'extension_ui_request', ...ask('a') }));
    s = reduce(s, ev({ type: 'extension_ui_request', ...ask('b', 'select') }));
    expect(s.pendingUi.map((u) => u.id)).toEqual(['a', 'b']);
    s = reduce(s, ev({ type: 'ui_resolved', id: 'a', reason: 'answered' }));
    expect(s.pendingUi.map((u) => u.id)).toEqual(['b']);
    const same = reduce(s, ev({ type: 'ui_resolved', id: 'zzz' }));
    expect(same).toBe(s);
  });

  it('never queues fire-and-forget methods', () => {
    const start = emptyTranscript();
    for (const method of ['setWidget', 'setStatus', 'setTitle', 'set_editor_text', 'open_url']) {
      expect(reduce(start, ev({ type: 'extension_ui_request', id: method, method }))).toBe(start);
    }
    expect(turn.some((f) => (f.event as { type: string }).type === 'extension_ui_request')).toBe(true);
    expect(play(turn).pendingUi).toEqual([]);
  });

  it('turns notify into one notice', () => {
    let s = reduce(emptyTranscript(), ev({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'Build done', notifyType: 'info' }));
    s = reduce(s, ev({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'Build done' }));
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: 'notice', text: 'Build done', level: 'info' });
  });

  it('replaces the list from a session snapshot and drops non-blocking entries', () => {
    let s = reduce(emptyTranscript(), ev({ type: 'extension_ui_request', ...ask('old') }));
    s = reduce(s, { kind: 'pending-ui', requests: [ask('new'), { id: 'w', method: 'setWidget' }] });
    expect(s.pendingUi.map((u) => u.id)).toEqual(['new']);
  });

  it('survives a history reload', () => {
    let s = reduce(emptyTranscript(), ev({ type: 'extension_ui_request', ...ask('keep') }));
    s = reduce(s, { kind: 'history', messages: history.messages });
    expect(s.pendingUi.map((u) => u.id)).toEqual(['keep']);
  });
});

describe('notices', () => {
  it('updates the compaction notice in place', () => {
    let s = reduce(emptyTranscript(), ev({ type: 'auto_compaction_start', reason: 'threshold' }));
    expect(s.items[0]).toMatchObject({ kind: 'notice', active: true, text: 'Compacting context' });
    s = reduce(s, ev({ type: 'auto_compaction_end', aborted: false }));
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ active: false, text: 'Context compacted', level: 'info' });
  });

  it('reports a failed compaction and a retry that gave up as errors', () => {
    let s = reduce(emptyTranscript(), ev({ type: 'auto_compaction_end', errorMessage: 'no room' }));
    expect(s.items[0]).toMatchObject({ level: 'error', text: 'Compaction failed: no room' });
    s = reduce(s, ev({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: '529' }));
    s = reduce(s, ev({ type: 'auto_retry_end', success: false, finalError: 'overloaded' }));
    expect(s.items.at(-1)).toMatchObject({ level: 'error', text: 'Gave up retrying: overloaded', active: false });
  });

  it('notes model and thinking changes and extension errors', () => {
    let s = reduce(emptyTranscript(), ev({ type: 'model_changed', model: { id: 'm', name: 'Model M', provider: 'p' } }));
    s = reduce(s, ev({ type: 'thinking_level_changed', level: 'high' }));
    s = reduce(s, ev({ type: 'extension_error', error: 'bad hook' }));
    expect(s.items.map((i) => (i as { text: string }).text)).toEqual(['Model: Model M', 'Thinking: high', 'Extension error: bad hook']);
    expect(new Set(s.items.map((i) => i.id)).size).toBe(3);
  });
});

describe('helpers', () => {
  it('summarizes tool arguments in the documented order', () => {
    expect(summarize({ command: 'ls', path: 'x' }, undefined)).toBe('ls');
    expect(summarize({ path: 'a.ts' }, undefined)).toBe('a.ts');
    expect(summarize({ file_path: 'b.ts' }, undefined)).toBe('b.ts');
    expect(summarize({ pattern: 'foo' }, undefined)).toBe('foo');
    expect(summarize({ query: 'q' }, undefined)).toBe('q');
    expect(summarize({ url: 'https://x' }, undefined)).toBe('https://x');
    expect(summarize({ n: 1 }, undefined)).toBe('{"n":1}');
    expect(summarize({ command: 'ls' }, 'Listing')).toBe('Listing');
    expect(summarize(undefined, undefined)).toBe('');
  });

  it('extracts result text from the shapes omp uses', () => {
    expect(resultText(null)).toBe('');
    expect(resultText('plain')).toBe('plain');
    expect(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
    expect(resultText({ content: 'str' })).toBe('str');
    expect(resultText({ other: 1 })).toBe('{\n  "other": 1\n}');
  });

  it('splits content blocks', () => {
    const b = splitContent([
      { type: 'thinking', thinking: 'a' }, { type: 'text', text: 'b' }, { type: 'image' },
      { type: 'toolCall', id: '1', name: 'x' }, { type: 'text', text: 'c' },
    ]);
    expect(b).toMatchObject({ thinking: 'a', text: 'bc', images: 1 });
    expect(b.calls).toHaveLength(1);
    expect(splitContent('s').text).toBe('s');
    expect(splitContent(undefined).text).toBe('');
  });
});
