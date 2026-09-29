import { afterEach, describe, expect, it } from 'vitest';
import type { UserItem } from '../../lib/transcript/types';
import UserBubble from '../items/UserBubble.svelte';
import { cleanup, render } from './mount';

const base: UserItem = { kind: 'user', id: 'u1', text: 'hello', images: 0, pending: false };

afterEach(cleanup);

const note = (target: HTMLElement) => target.querySelector('p.note')?.textContent?.replace(/\s+/g, ' ').trim();

describe('UserBubble steer badges', () => {
  it('shows a pending badge with a spinner while the steer waits for its echo', () => {
    const { target } = render(UserBubble, { item: { ...base, pending: true, note: 'steer-pending' } });
    expect(note(target)).toBe('pending');
    expect(target.querySelector('.spinner')).not.toBeNull();
    expect(target.querySelector('.bubble')?.className).toContain('pending');
  });

  it('shows the steered badge once the echo arrived', () => {
    const { target } = render(UserBubble, { item: { ...base, note: 'steer' } });
    expect(note(target)).toBe('Steered');
  });

  it('shows sent while streaming for a steer the turn ended without echoing', () => {
    const { target } = render(UserBubble, { item: { ...base, note: 'steer-pending', stale: true } });
    expect(note(target)).toBe('Sent while streaming');
    expect(target.querySelector('.spinner')).toBeNull();
    expect(target.querySelector('p.note')?.className).toContain('stale');
  });

  it('shows queued while a queued send waits for the running turn to end', () => {
    const { target } = render(UserBubble, { item: { ...base, pending: true, note: 'queued' } });
    expect(note(target)).toBe('Queued');
    expect(target.querySelector('p.note')?.textContent).not.toContain('Sending');
  });

  it('shows queued once the send settles and nothing once it reads as a plain message', () => {
    const queued = render(UserBubble, { item: { ...base, note: 'queued' } });
    expect(note(queued.target)).toBe('Queued');
    const plain = render(UserBubble, { item: { ...base } });
    expect(plain.target.querySelector('p.note')).toBeNull();
  });

  it('keeps the other-device note', () => {
    const { target } = render(UserBubble, { item: { ...base, note: 'other-client' } });
    expect(note(target)).toBe('From another device');
  });
});
