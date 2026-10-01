import { afterEach, describe, expect, it } from 'vitest';
import RailRow from '../RailRow.svelte';
import { cleanup, render, settle } from './mount';

afterEach(cleanup);

describe('RailRow', () => {
  it('shows the kebab only when menu items are passed', () => {
    const plain = render(RailRow, { title: 't', sub: 's', onclick: () => {} });
    expect(plain.target.querySelector('button[aria-label^="Session options for"]')).toBeNull();
    cleanup();

    const withMenu = render(RailRow, {
      title: 't', sub: 's', menu: [{ id: 'a', label: 'Action', onselect: () => {} }], onclick: () => {},
    });
    expect(withMenu.target.querySelector('button[aria-label^="Session options for"]')).not.toBeNull();
  });

  it('renders the amber review glyph instead of the status dot', () => {
    const { target } = render(RailRow, { title: 't', sub: 's', status: 'review', onclick: () => {} });
    const glyph = target.querySelector<HTMLElement>('.glyph.review');
    expect(glyph).not.toBeNull();
    expect(glyph!.getAttribute('aria-label')).toBe('Ready for review');
    expect(glyph!.querySelector('svg')).not.toBeNull();
  });

  it('marks forked sessions with a branch badge in the title', () => {
    const plain = render(RailRow, { title: 't', sub: 's', onclick: () => {} });
    expect(plain.target.querySelector('.title .fork')).toBeNull();
    cleanup();

    const forked = render(RailRow, { title: 't', sub: 's', forked: true, onclick: () => {} });
    expect(forked.target.querySelector('.title .fork svg')).not.toBeNull();
  });

  it('opens the menu and runs the chosen action', async () => {
    const picks: string[] = [];
    const { target } = render(RailRow, {
      title: 't', sub: 's',
      menu: [{ id: 'review', label: 'Mark ready for review', icon: 'flag', onselect: () => picks.push('review') }],
      onclick: () => {},
    });
    target.querySelector<HTMLButtonElement>('button[aria-label^="Session options for"]')!.click();
    await settle();
    const item = [...target.querySelectorAll('button')].find((b) => b.textContent?.includes('Mark ready for review'));
    expect(item).toBeDefined();
    item!.click();
    await settle();
    expect(picks).toEqual(['review']);
  });
});
