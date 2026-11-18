import { describe, expect, it } from 'vitest';
import { nav, parseHash, parseKanbanHash } from '../nav.svelte';

describe('parseHash', () => {
  it('reads the session id and the changes suffix', () => {
    expect(parseHash('#/s/abc')).toEqual({ gwId: 'abc', changes: false });
    expect(parseHash('#/s/abc/changes')).toEqual({ gwId: 'abc', changes: true });
    expect(parseHash('#/s/')).toBeNull();
    expect(parseHash('#')).toBeNull();
    expect(parseHash('')).toBeNull();
  });
});

describe('nav view', () => {
  it('starts on the changes view when the hash carries the suffix', () => {
    location.hash = '#/s/route1/changes';
    const stop = nav.start();
    expect(nav.gwId).toBe('route1');
    expect(nav.view).toBe('changes');
    stop();
  });

  it('starts on the transcript view for a plain session hash', () => {
    location.hash = '#/s/route2';
    const stop = nav.start();
    expect(nav.gwId).toBe('route2');
    expect(nav.view).toBe('transcript');
    stop();
  });

  it('openChanges sets the view in place when already on the route', () => {
    location.hash = '#/s/route3/changes';
    const stop = nav.start();
    nav.openChanges('route3');
    expect(nav.view).toBe('changes');
    stop();
  });
});

describe('kanban routing', () => {
  it('parses #/kanban and #/kanban?cwd=...', () => {
    expect(parseKanbanHash('#/kanban')).toEqual({ active: true, cwd: null });
    expect(parseKanbanHash('#/kanban?cwd=%2Fwork%2Fapp')).toEqual({ active: true, cwd: '/work/app' });
    expect(parseKanbanHash('#/s/abc')).toEqual({ active: false, cwd: null });
  });

  it('openKanban navigates between index and project board', () => {
    location.hash = '#/s/route1';
    const stop = nav.start();
    nav.openKanban('/work/proj');
    expect(location.hash).toBe('#/kanban?cwd=%2Fwork%2Fproj');
    nav.openKanban(null);
    expect(location.hash).toBe('#/kanban');
    stop();
  });
});
