import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearScope, device, getItem, removeItem, sessionScope, setItem, storageKey } from '../storage';

function at(origin: string) {
  vi.stubGlobal('location', { origin });
}

beforeEach(() => {
  localStorage.clear();
  at('https://a.example');
});
afterEach(() => vi.unstubAllGlobals());

describe('storage scoping', () => {
  it('builds keys as ompgw:v1:<origin>:<scope>:<key>', () => {
    expect(storageKey('device', 'theme')).toBe('ompgw:v1:https://a.example:device:theme');
    expect(storageKey(sessionScope('abc'), 'draft')).toBe('ompgw:v1:https://a.example:session:abc:draft');
  });

  it('round-trips JSON values and honors the fallback', () => {
    expect(getItem('device', 'x', 5)).toBe(5);
    setItem('device', 'x', { a: [1, 2] });
    expect(getItem('device', 'x', null)).toEqual({ a: [1, 2] });
    removeItem('device', 'x');
    expect(getItem('device', 'x', 'gone')).toBe('gone');
  });

  it('keeps origins apart', () => {
    setItem('device', 'theme', 'paper');
    at('https://b.example');
    expect(getItem('device', 'theme', 'none')).toBe('none');
    setItem('device', 'theme', 'terminal');
    at('https://a.example');
    expect(getItem('device', 'theme', 'none')).toBe('paper');
  });

  it('keeps sessions and device apart', () => {
    setItem('device', 'draft', 'device');
    setItem(sessionScope('s1'), 'draft', 'one');
    setItem(sessionScope('s2'), 'draft', 'two');
    expect(getItem(sessionScope('s1'), 'draft', '')).toBe('one');
    expect(getItem(sessionScope('s2'), 'draft', '')).toBe('two');
    expect(getItem('device', 'draft', '')).toBe('device');
  });

  it('clearScope removes one session only', () => {
    setItem(sessionScope('s1'), 'draft', 'one');
    setItem(sessionScope('s1'), 'scroll', 10);
    setItem(sessionScope('s10'), 'draft', 'ten');
    setItem('device', 'theme', 'paper');
    clearScope(sessionScope('s1'));
    expect(getItem(sessionScope('s1'), 'draft', 'x')).toBe('x');
    expect(getItem(sessionScope('s1'), 'scroll', 'x')).toBe('x');
    expect(getItem(sessionScope('s10'), 'draft', 'x')).toBe('ten');
    expect(getItem('device', 'theme', 'x')).toBe('paper');
  });

  it('survives corrupt JSON', () => {
    localStorage.setItem(storageKey('device', 'bad'), '{nope');
    expect(getItem('device', 'bad', 'fb')).toBe('fb');
  });

  it('survives a throwing setItem (quota)', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('quota');
      },
      getItem: () => null,
    });
    expect(setItem('device', 'x', 1)).toBe(false);
    expect(getItem('device', 'x', 'fb')).toBe('fb');
  });

  it('device helper uses the device scope', () => {
    device.set('density', 'compact');
    expect(localStorage.getItem('ompgw:v1:https://a.example:device:density')).toBe('"compact"');
    expect(device.get('density', 'cozy')).toBe('compact');
    device.remove('density');
    expect(device.get('density', 'cozy')).toBe('cozy');
  });
});
