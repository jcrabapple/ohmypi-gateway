import { describe, expect, it } from 'vitest';
import { modeForKey, sendNote, sendPlan } from '../send';

describe('send plan', () => {
  it('idle: Send is the only action', () => {
    expect(sendPlan(false)).toEqual({ primary: { mode: 'prompt', label: 'Send' }, secondary: null });
  });
  it('streaming: Steer primary, Queue secondary', () => {
    const p = sendPlan(true);
    expect(p.primary).toEqual({ mode: 'steer', label: 'Steer' });
    expect(p.secondary).toEqual({ mode: 'follow_up', label: 'Queue' });
  });
  it('Ctrl/Cmd+Enter queues only while streaming', () => {
    expect(modeForKey(true, false)).toBe('steer');
    expect(modeForKey(true, true)).toBe('follow_up');
    expect(modeForKey(false, true)).toBe('prompt');
    expect(modeForKey(false, false)).toBe('prompt');
  });
  it('notes the lifecycle: steer stays pending until its echo, queued, plain', () => {
    expect(sendNote('steer')).toBe('steer-pending');
    expect(sendNote('follow_up')).toBe('queued');
    expect(sendNote('prompt')).toBeUndefined();
  });
});
