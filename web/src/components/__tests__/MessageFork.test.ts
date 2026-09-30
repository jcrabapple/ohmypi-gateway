import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantItem, UserItem } from '../../lib/transcript/types';
import AssistantMessage from '../items/AssistantMessage.svelte';
import UserBubble from '../items/UserBubble.svelte';
import { active } from '../../lib/state';
import { cleanup, render } from './mount';

const user: UserItem = { kind: 'user', id: 'u1', text: 'hello', images: 0, pending: false };
const assistant: AssistantItem = { kind: 'assistant', id: 'a1', text: 'hi there', streaming: false };

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const forkItem = (target: HTMLElement) =>
  [...target.querySelectorAll('button')].find((b) => b.textContent?.includes('Fork from here'));

/** The item menu is the long-press action sheet; open it with fake timers. */
async function openSheet(target: HTMLElement): Promise<void> {
  vi.useFakeTimers();
  const frame = target.querySelector('.frame')!;
  frame.dispatchEvent(
    new PointerEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true }),
  );
  await vi.advanceTimersByTimeAsync(500);
  frame.dispatchEvent(
    new PointerEvent('pointerup', { pointerType: 'touch', isPrimary: true, bubbles: true }),
  );
  await vi.advanceTimersByTimeAsync(0);
}

describe('fork menu visibility', () => {
  it('offers Fork from here on settled user messages', async () => {
    const { target } = render(UserBubble, { item: user });
    await openSheet(target);
    expect(forkItem(target)).toBeDefined();
  });

  it('hides fork while the message is pending or failed', async () => {
    const pending = render(UserBubble, { item: { ...user, pending: true } });
    await openSheet(pending.target);
    expect(forkItem(pending.target)).toBeUndefined();
    cleanup();

    const failed = render(UserBubble, { item: { ...user, failed: true } });
    await openSheet(failed.target);
    expect(forkItem(failed.target)).toBeUndefined();
  });

  it('disables fork while a turn is running, like the header menu', async () => {
    active.running = true;
    try {
      const { target } = render(UserBubble, { item: user });
      await openSheet(target);
      const btn = forkItem(target);
      expect(btn).toBeDefined();
      expect(btn!.disabled).toBe(true);
    } finally {
      active.running = false;
    }
  });

  it('never offers fork on assistant messages', async () => {
    const { target } = render(AssistantMessage, { item: assistant });
    await openSheet(target);
    expect(forkItem(target)).toBeUndefined();
  });
});
