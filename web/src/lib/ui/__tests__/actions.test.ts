import { describe, expect, it } from 'vitest';
import { fadeEdges, scrollFade } from '../actions';

describe('fadeEdges', () => {
  it('has no fade when everything fits', () => {
    expect(fadeEdges(0, 250, 250)).toBe('');
    expect(fadeEdges(0, 250, 250.5)).toBe('');
  });
  it('fades the end while there is more to the right', () => {
    expect(fadeEdges(0, 250, 278)).toBe('end');
  });
  it('fades both edges in the middle and only the start at the far end', () => {
    expect(fadeEdges(10, 250, 400)).toBe('both');
    expect(fadeEdges(150, 250, 400)).toBe('start');
  });
});

describe('scrollFade action', () => {
  it('marks the row from its measured size and clears it when it fits', () => {
    const node = document.createElement('div');
    Object.defineProperty(node, 'clientWidth', { value: 250, configurable: true });
    let width = 278;
    Object.defineProperty(node, 'scrollWidth', { get: () => width, configurable: true });
    const action = scrollFade(node);
    expect(node.dataset.fade).toBe('end');
    width = 250;
    node.dispatchEvent(new Event('scroll'));
    expect(node.dataset.fade).toBeUndefined();
    action.destroy();
  });
});
