import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessagesResponse } from '../../lib/api/types';
import { nav } from '../../lib/state/nav.svelte';
import { emptyTranscript, reduce } from '../../lib/transcript/reducer';
import editsFixture from '../../lib/transcript/__fixtures__/edits.json';
import ChangesView from '../ChangesView.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';

const edits = editsFixture as unknown as { messages: MessagesResponse['messages'] };
const items = reduce(emptyTranscript(), { kind: 'history', messages: edits.messages }).items;

afterEach(cleanup);

describe('ChangesView', () => {
  it('rolls up every file with counts and a diff block per path', () => {
    const { target } = render(ChangesView, { gwId: 'gw1', items });
    expect(target.querySelectorAll('.block').length).toBe(4);
    const counts = target.querySelector('.counts')!.textContent!.replace(/\s+/g, ' ');
    expect(counts).toContain('4 files');
    expect(counts).toContain('4 edits');
    expect(counts).toContain('+9');
    expect(counts).toContain('-2');
  });

  it('offers an empty state and hides the mode toggle without changes', () => {
    const { target } = render(ChangesView, { gwId: 'gw1', items: [] });
    expect(target.textContent).toContain('No file changes');
    expect(target.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it('forces unified on created files even with the global split toggle', async () => {
    const { target } = render(ChangesView, { gwId: 'gw1', items });
    buttonNamed(target, 'Split')!.click();
    await settle();
    const rows = [...target.querySelectorAll('.rows')];
    expect(rows.some((r) => r.classList.contains('cols2'))).toBe(true);
    // the synthesized write diff is a created file: no split table
    const blocks = [...target.querySelectorAll('.block')];
    const changelog = blocks.find((b) => b.querySelector('.path')?.textContent?.includes('CHANGELOG'));
    expect(changelog!.querySelector('.rows.unified')).not.toBeNull();
    expect(changelog!.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it('goes back to the session', async () => {
    const open = vi.spyOn(nav, 'open').mockImplementation(() => {});
    const { target } = render(ChangesView, { gwId: 'gw1', items });
    buttonNamed(target, 'Back to session')!.click();
    await settle();
    expect(open).toHaveBeenCalledWith('gw1');
  });
});
