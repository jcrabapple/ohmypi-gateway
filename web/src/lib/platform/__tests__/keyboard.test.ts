import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyboardInset, watchKeyboard } from '../keyboard';

class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  scale = 1;
}

let vv: FakeViewport;
let win: Window;
let rafs: (() => void)[];

function fakeWindow(innerHeight: number): Window {
  return {
    innerHeight,
    visualViewport: vv,
    document,
    requestAnimationFrame: (cb: () => void) => {
      rafs.push(cb);
      return rafs.length;
    },
    cancelAnimationFrame: () => {
      rafs = [];
    },
  } as unknown as Window;
}

const flush = () => {
  const run = rafs;
  rafs = [];
  run.forEach((f) => f());
};
const kb = () => document.documentElement.style.getPropertyValue('--kb');

beforeEach(() => {
  vv = new FakeViewport();
  rafs = [];
  win = fakeWindow(800);
  document.documentElement.style.removeProperty('--kb');
});
afterEach(() => vi.restoreAllMocks());

describe('keyboardInset', () => {
  it('is zero when the viewport fills the window', () => {
    expect(keyboardInset(win)).toBe(0);
  });

  it('is innerHeight - height - offsetTop', () => {
    vv.height = 500;
    expect(keyboardInset(win)).toBe(300);
    vv.height = 450;
    vv.offsetTop = 50;
    expect(keyboardInset(win)).toBe(300);
  });

  it('ignores anything under 120px (browser chrome, not a keyboard)', () => {
    vv.height = 700;
    expect(keyboardInset(win)).toBe(0);
    vv.height = 681;
    expect(keyboardInset(win)).toBe(0);
    vv.height = 680;
    expect(keyboardInset(win)).toBe(120);
  });

  it('ignores a pinch-zoomed page', () => {
    vv.height = 400;
    vv.scale = 1.5;
    expect(keyboardInset(win)).toBe(0);
  });

  it('is zero without visualViewport', () => {
    expect(keyboardInset({ innerHeight: 800, visualViewport: null })).toBe(0);
  });
});

describe('watchKeyboard', () => {
  it('starts at 0px and publishes on resize', () => {
    const stop = watchKeyboard({ win });
    flush();
    expect(kb()).toBe('0px');
    vv.height = 480;
    vv.dispatchEvent(new Event('resize'));
    flush();
    expect(kb()).toBe('320px');
    vv.height = 800;
    vv.dispatchEvent(new Event('resize'));
    flush();
    expect(kb()).toBe('0px');
    stop();
  });

  it('coalesces bursts into one frame', () => {
    watchKeyboard({ win });
    flush();
    vv.height = 500;
    for (let i = 0; i < 10; i++) vv.dispatchEvent(new Event('resize'));
    vv.dispatchEvent(new Event('scroll'));
    expect(rafs).toHaveLength(1);
    flush();
    expect(kb()).toBe('300px');
  });

  it('follows viewport scroll (iOS moves offsetTop when the keyboard opens)', () => {
    watchKeyboard({ win });
    flush();
    vv.height = 450;
    vv.offsetTop = 50;
    vv.dispatchEvent(new Event('scroll'));
    flush();
    expect(kb()).toBe('300px');
  });

  it('stop removes listeners and the property', () => {
    const stop = watchKeyboard({ win });
    flush();
    stop();
    expect(kb()).toBe('');
    vv.height = 400;
    vv.dispatchEvent(new Event('resize'));
    expect(rafs).toHaveLength(0);
  });

  it('is a safe no-op without visualViewport', () => {
    const bare = { ...fakeWindow(800), visualViewport: null } as unknown as Window;
    const stop = watchKeyboard({ win: bare });
    expect(kb()).toBe('0px');
    expect(() => stop()).not.toThrow();
  });
});
