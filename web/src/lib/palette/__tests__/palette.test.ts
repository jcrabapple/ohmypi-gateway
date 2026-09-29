import { describe, expect, it, vi } from 'vitest';
import { buildPaletteItems, rankItems, type PaletteActions, type PaletteContext } from '../palette';
import { command, saved, session } from './factories';

function actions(): PaletteActions {
  return {
    newSession: vi.fn(), nextAttention: vi.fn(), openSession: vi.fn(), resume: vi.fn(), openSettings: vi.fn(),
    toggleTheme: vi.fn(), compact: vi.fn(), stop: vi.fn(), rename: vi.fn(), sessionInfo: vi.fn(),
    sessionChanges: vi.fn(), slash: vi.fn(),
  };
}

function ctx(over: Partial<PaletteContext> = {}): PaletteContext {
  return {
    live: [], saved: [], activeGwId: null, commands: [], now: 1_700_000_100_000,
    changesCount: 0, actions: actions(), ...over,
  };
}

const ids = (list: { id: string }[]) => list.map((i) => i.id);
const titles = (list: { title: string }[]) => list.map((i) => i.title);

describe('buildPaletteItems', () => {
  it('always offers new session, theme and one item per settings page', () => {
    const items = buildPaletteItems(ctx());
    expect(ids(items)).toContain('a:new');
    expect(ids(items)).toContain('a:theme');
    expect(items.filter((i) => i.kind === 'setting')).toHaveLength(7);
  });

  it('offers session actions only when the open session is live', () => {
    const none = buildPaletteItems(ctx({ live: [session('a')], activeGwId: null }));
    expect(ids(none)).not.toContain('a:compact');
    const open = buildPaletteItems(ctx({ live: [session('a')], activeGwId: 'a' }));
    expect(ids(open)).toEqual(expect.arrayContaining(['a:info', 'a:rename', 'a:compact', 'a:stop']));
    const gone = buildPaletteItems(ctx({ live: [session('a', { exited: true })], activeGwId: 'a' }));
    expect(ids(gone)).not.toContain('a:stop');
  });

  it('offers next-attention only when a session is waiting', () => {
    expect(ids(buildPaletteItems(ctx({ live: [session('a')] })))).not.toContain('a:next');
    const waiting = session('b', { pendingUi: [{ id: 'u', method: 'confirm' }] });
    const items = buildPaletteItems(ctx({ live: [session('a'), waiting] }));
    expect(items.find((i) => i.id === 'a:next')?.sub).toBe('1 waiting');
  });

  it('offers Session changes only when the open session has changed files', () => {
    const a = actions();
    const open = { live: [session('a')], activeGwId: 'a', actions: a };
    expect(ids(buildPaletteItems(ctx(open)))).not.toContain('a:changes');
    const changed = buildPaletteItems(ctx({ ...open, changesCount: 2 }));
    const item = changed.find((i) => i.id === 'a:changes')!;
    expect(item.title).toBe('Session changes');
    expect(item.sub).toBe('2 files');
    item.run();
    expect(a.sessionChanges).toHaveBeenCalled();
  });

  it('lists slash commands only with a session open', () => {
    const commands = [command('compact', 'Shrink the context')];
    expect(ids(buildPaletteItems(ctx({ commands })))).not.toContain('c:compact');
    expect(ids(buildPaletteItems(ctx({ commands, live: [session('a')], activeGwId: 'a' })))).toContain('c:compact');
  });

  it('marks live sessions with a status and the open one as current', () => {
    const items = buildPaletteItems(ctx({
      live: [session('a', { isStreaming: true }), session('b', { pendingUi: [{ id: 'u', method: 'confirm' }] }), session('c')],
      activeGwId: 'c',
    }));
    const by = (id: string) => items.find((i) => i.id === `s:${id}`)!;
    expect(by('a').status).toBe('running');
    expect(by('b').status).toBe('needs');
    expect(by('c').status).toBe('idle');
    expect(by('c').current).toBe(true);
    expect(by('a').current).toBe(false);
  });

  it('skips history that is already a live session, and exited sessions', () => {
    const items = buildPaletteItems(ctx({
      live: [session('a', { ompSessionFile: '/s/a.jsonl' }), session('dead', { exited: true })],
      saved: [saved('/s/a.jsonl', 'Live one'), saved('/s/b.jsonl', 'Old one')],
    }));
    expect(ids(items.filter((i) => i.kind === 'history'))).toEqual(['h:/s/b.jsonl']);
    expect(ids(items)).not.toContain('s:dead');
  });

  it('runs the right action for each kind', () => {
    const a = actions();
    const s = saved('/s/b.jsonl', 'Old one');
    const items = buildPaletteItems(ctx({ actions: a, live: [session('a')], saved: [s], activeGwId: 'a', commands: [command('x')] }));
    for (const id of ['a:new', 's:a', 'h:/s/b.jsonl', 'p:agent', 'c:x', 'a:stop']) items.find((i) => i.id === id)!.run();
    expect(a.newSession).toHaveBeenCalled();
    expect(a.openSession).toHaveBeenCalledWith('a');
    expect(a.resume).toHaveBeenCalledWith(s);
    expect(a.openSettings).toHaveBeenCalledWith('agent');
    expect(a.slash).toHaveBeenCalledWith(expect.objectContaining({ name: 'x' }));
    expect(a.stop).toHaveBeenCalled();
  });
});

describe('rankItems', () => {
  const live = [
    session('a', { ompSessionName: 'Fix login bug' }),
    session('b', { ompSessionName: 'Refactor parser', pendingUi: [{ id: 'u', method: 'confirm' }] }),
    session('c', { ompSessionName: 'Write docs' }),
  ];
  const savedList = Array.from({ length: 9 }, (_, i) => saved(`/s/${i}.jsonl`, `Old chat ${i}`));
  const base = ctx({ live, saved: savedList, activeGwId: 'c', commands: [command('compact', 'Shrink context'), command('model', 'Switch model')] });
  const items = buildPaletteItems(base);

  it('with no query shows actions, sessions (needs-you first, current last) and five history rows', () => {
    const out = rankItems(items, '');
    const kinds = out.map((i) => i.kind);
    expect(kinds.indexOf('action')).toBe(0);
    expect(kinds).not.toContain('slash');
    expect(kinds).not.toContain('setting');
    expect(out.filter((i) => i.kind === 'history')).toHaveLength(5);
    const sessions = out.filter((i) => i.kind === 'session');
    expect(titles(sessions)).toEqual(['Refactor parser', 'Fix login bug', 'Write docs']);
    expect(sessions.at(-1)!.current).toBe(true);
    const order = [...new Set(kinds)];
    expect(order).toEqual(['action', 'session', 'history']);
  });

  it('filters by fuzzy title and puts the best match first', () => {
    expect(titles(rankItems(items, 'parser'))[0]).toBe('Refactor parser');
    expect(titles(rankItems(items, 'login'))[0]).toBe('Fix login bug');
  });

  it('matches history sessions too', () => {
    const out = rankItems(items, 'old chat 7');
    expect(out[0]).toMatchObject({ kind: 'history', title: 'Old chat 7' });
  });

  it('matches keywords, so "kill" finds Stop session', () => {
    expect(titles(rankItems(items, 'kill'))).toContain('Stop session');
  });

  it('breaks ties by kind, then by original order', () => {
    const tie = [
      { id: '1', kind: 'history', title: 'alpha', icon: 'clock', run() {} },
      { id: '2', kind: 'action', title: 'alpha', icon: 'plus', run() {} },
      { id: '3', kind: 'action', title: 'alpha', icon: 'plus', run() {} },
    ] as const;
    expect(ids(rankItems(tie, 'alpha'))).toEqual(['2', '3', '1']);
  });

  it('the > prefix narrows to actions and settings', () => {
    const out = rankItems(items, '>');
    expect(new Set(out.map((i) => i.kind))).toEqual(new Set(['action', 'setting']));
    const themed = rankItems(items, '> theme');
    expect(themed.length).toBeGreaterThan(0);
    expect(themed.every((i) => i.kind === 'action' || i.kind === 'setting')).toBe(true);
    expect(themed.find((i) => i.kind === 'session')).toBeUndefined();
  });

  it('the / prefix narrows to slash commands', () => {
    expect(titles(rankItems(items, '/'))).toEqual(['/compact', '/model']);
    expect(titles(rankItems(items, '/mod'))).toEqual(['/model']);
  });

  it('finds settings pages by the settings inside them', () => {
    expect(rankItems(items, 'accent')[0]).toMatchObject({ kind: 'setting', title: 'Appearance' });
    expect(rankItems(items, 'yaml')[0]).toMatchObject({ kind: 'setting', title: 'Agent config' });
  });

  it('returns nothing when nothing matches, and honours the limit', () => {
    expect(rankItems(items, 'qqqqzzzz')).toEqual([]);
    expect(rankItems(items, 'o', { limit: 3 })).toHaveLength(3);
  });
});
