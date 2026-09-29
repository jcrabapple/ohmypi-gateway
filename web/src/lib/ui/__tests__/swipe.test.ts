import { describe, expect, it } from 'vitest';
import { EDGE_PX, SWIPE_PX, startsAtEdge, swipeIntent } from '../swipe';

describe('swipeIntent', () => {
  it('opens on a rightward drag that began at the left edge', () => {
    expect(startsAtEdge({ x: EDGE_PX - 1, y: 200 })).toBe(true);
    expect(startsAtEdge({ x: EDGE_PX + 40, y: 200 })).toBe(false);
    expect(swipeIntent({ x: 5, y: 200 }, { x: 5 + SWIPE_PX + 4, y: 205 }, false)).toBe('open');
  });
  it('closes on a leftward drag while open', () => {
    expect(swipeIntent({ x: 200, y: 200 }, { x: 200 - SWIPE_PX - 4, y: 205 }, true)).toBe('close');
  });
  it('ignores mostly vertical drags and short ones', () => {
    expect(swipeIntent({ x: 5, y: 200 }, { x: 5 + SWIPE_PX + 4, y: 400 }, false)).toBeNull();
    expect(swipeIntent({ x: 5, y: 200 }, { x: 20, y: 200 }, false)).toBeNull();
  });
});
