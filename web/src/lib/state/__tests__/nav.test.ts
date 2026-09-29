import { describe, expect, it } from 'vitest';
import { nav, parseHash } from '../nav.svelte';

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
