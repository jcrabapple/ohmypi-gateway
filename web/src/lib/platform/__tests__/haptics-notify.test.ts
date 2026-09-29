import { afterEach, describe, expect, it, vi } from 'vitest';
import { tap } from '../haptics';
import { notify, permission, requestPermission } from '../notify';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('haptics', () => {
  it('vibrates 10ms on coarse pointers only', () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    tap();
    expect(vibrate).not.toHaveBeenCalled();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    tap();
    expect(vibrate).toHaveBeenCalledWith(10);
  });

  it('does nothing without navigator.vibrate', () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(() => tap()).not.toThrow();
  });
});

describe('notify', () => {
  function stubNotification(perm: NotificationPermission) {
    const made: { title: string; opts?: NotificationOptions }[] = [];
    const request = vi.fn(async () => 'granted' as NotificationPermission);
    class N {
      static permission = perm;
      static requestPermission = request;
      onclick: (() => void) | null = null;
      constructor(title: string, opts?: NotificationOptions) {
        made.push({ title, opts });
      }
      close() {}
    }
    vi.stubGlobal('Notification', N);
    return { made, request };
  }
  const hidden = (v: boolean) => vi.spyOn(document, 'hidden', 'get').mockReturnValue(v);

  it('only shows when granted and the tab is hidden', () => {
    const { made } = stubNotification('granted');
    hidden(false);
    expect(notify({ title: 'a' })).toBe(false);
    hidden(true);
    expect(notify({ title: 'b', body: 'x', tag: 't' })).toBe(true);
    expect(made).toEqual([{ title: 'b', opts: { body: 'x', tag: 't' } }]);
  });

  it('never prompts by itself', () => {
    const { made, request } = stubNotification('default');
    hidden(true);
    expect(notify({ title: 'a' })).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(made).toHaveLength(0);
  });

  it('requestPermission asks once, and not when already decided', async () => {
    const { request } = stubNotification('default');
    expect(await requestPermission()).toBe('granted');
    expect(request).toHaveBeenCalledTimes(1);
    const denied = stubNotification('denied');
    expect(await requestPermission()).toBe('denied');
    expect(denied.request).not.toHaveBeenCalled();
  });

  it('reports unsupported environments', async () => {
    vi.stubGlobal('Notification', undefined);
    expect(permission()).toBe('unsupported');
    expect(await requestPermission()).toBe('unsupported');
    expect(notify({ title: 'a' })).toBe(false);
  });
});
