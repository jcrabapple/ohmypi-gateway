import { afterEach, describe, expect, it, vi } from 'vitest';
import * as clipboard from '../../lib/platform/clipboard';
import { ui } from '../../lib/state/ui.svelte';
import DiffBlock from '../items/DiffBlock.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';

const editFile = {
  path: 'src/lib/render/greeter.py',
  op: 'update',
  diff: ' 1|def greet():\n-2|    return "old"\n+2|    return "new"\n 3|',
  adds: 1,
  dels: 1,
  created: false,
};
const createdFile = {
  path: 'CHANGELOG.md',
  op: 'write',
  diff: '+1|hello\n+2|world',
  adds: 2,
  dels: 0,
  created: true,
};

afterEach(cleanup);

describe('DiffBlock', () => {
  it('shows the op badge, short path with full title, and counts', () => {
    const { target } = render(DiffBlock, { file: editFile });
    expect(target.querySelector('.badge')?.textContent?.trim()).toBe('M');
    const path = target.querySelector<HTMLElement>('.path')!;
    expect(path.textContent).toBe('…/lib/render/greeter.py');
    expect(path.title).toBe('src/lib/render/greeter.py');
    expect(target.querySelector('.stats')?.textContent).toContain('+1');
    expect(target.querySelector('.stats')?.textContent).toContain('-1');
  });

  it('defaults to unified in a narrow container and toggles to split', async () => {
    const { target } = render(DiffBlock, { file: editFile });
    expect(target.querySelector('.rows.unified')).not.toBeNull();
    buttonNamed(target, 'Split')!.click();
    await settle();
    expect(target.querySelector('.rows.cols2')).not.toBeNull();
    expect(target.querySelector('.rows.unified')).toBeNull();
  });

  it('pairs asymmetric chunks correctly in split mode (1 del vs 3 adds)', async () => {
    const { target } = render(DiffBlock, {
      file: { ...editFile, diff: ' 1|start\n-2|old\n+2|new a\n+3|new b\n+4|new c\n 5|end' },
    });
    buttonNamed(target, 'Split')!.click();
    await settle();
    const rows = [...target.querySelectorAll('.rows.cols2 [class*=row]')];
    const texts = rows.map((r) => r.textContent!.replace(/\s+/g, ' ').trim()).filter(Boolean);
    // one del row, three add rows, context rows on both sides; the add lines
    // must never appear in a left cell and no row may be doubled
    expect(texts.join(' | ')).toContain('new c');
    const leftTexts = [...target.querySelectorAll('.rows.cols2 [class*=left]')].map((c) => c.textContent!.trim());
    expect(leftTexts.join(' ')).not.toContain('new');
  });

  it('pairs asymmetric chunks correctly in split mode (2 dels vs 1 add)', async () => {
    const { target } = render(DiffBlock, {
      file: { ...editFile, diff: ' 1|start\n-2|old a\n-3|old b\n+2|new\n 4|end' },
    });
    buttonNamed(target, 'Split')!.click();
    await settle();
    const rightTexts = [...target.querySelectorAll('.rows.cols2 [class*=right]')].map((c) => c.textContent!.trim());
    // a context line must never pair as the right side of a deletion
    expect(rightTexts.filter((t) => t === 'end').length).toBeLessThanOrEqual(1);
    const body = target.querySelector('.rows.cols2')!.textContent!;
    // 'end' appears once per side max; the old lines appear only on the left
    expect(body.split('old a').length - 1).toBe(1);
    expect(body.split('new').length - 1).toBeLessThanOrEqual(2);
  });

  it('marks the changed word in a paired line', () => {
    const { target } = render(DiffBlock, {
      file: { ...editFile, diff: ' 1|foo.bar = 1\n-2|foo.bar = 2\n+2|foo.baz = 2\n 3|done' },
    });
    const marks = [...target.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(['bar', 'baz']);
  });

  it('renders gap rows between hunks and gap notes', () => {
    const { target } = render(DiffBlock, {
      file: { ...editFile, diff: ' 1|a\n-2|b\n+2|B\n\n 9|i\n... skipped 4 lines\n 14|j' },
    });
    const gaps = [...target.querySelectorAll('.lrow.gap')].map((g) => g.textContent?.trim());
    expect(gaps).toContain('... lines 3-8');
    expect(gaps).toContain('... skipped 4 lines');
  });

  it('does not synthesize a gap row when the next hunk starts with a gap note', () => {
    const { target } = render(DiffBlock, {
      file: { ...editFile, diff: ' 1|a\n-2|b\n\n... skipped 3 lines\n 6|i' },
    });
    const gaps = [...target.querySelectorAll('.lrow.gap')].map((g) => g.textContent?.trim());
    expect(gaps).toEqual(['... skipped 3 lines']);
  });

  it('pairs word marks within a hunk only, never across hunks', () => {
    const { target } = render(DiffBlock, {
      file: {
        ...editFile,
        diff: '-1|alpha one\n\n+2|alpha two',
        adds: 1,
        dels: 1,
      },
    });
    expect(target.querySelectorAll('mark').length).toBe(0);
  });

  it('shows shifted new numbers on context rows after an insert', async () => {
    const { target } = render(DiffBlock, {
      file: { ...editFile, diff: ' 1|a\n+2|ins\n 2|b', adds: 1, dels: 0 },
    });
    buttonNamed(target, 'Split')!.click();
    await settle();
    const pairs = [...target.querySelectorAll('.cols2 .pair')];
    const last = pairs.at(-1)!;
    const nums = [...last.querySelectorAll('.half > .g')].map((g) => g.textContent);
    expect(nums).toEqual(['2', '3']);
  });

  it('keeps created files unified with an A badge and no toggle', () => {
    const { target } = render(DiffBlock, { file: createdFile });
    expect(target.querySelector('.badge')?.textContent?.trim()).toBe('A');
    expect(target.querySelector('[role="radiogroup"]')).toBeNull();
    expect(target.querySelector('.rows.unified')).not.toBeNull();
  });

  it('follows a forced mode without a per-block toggle', () => {
    const { target } = render(DiffBlock, { file: editFile, mode: 'split' });
    expect(target.querySelector('[role="radiogroup"]')).toBeNull();
    expect(target.querySelector('.rows.cols2')).not.toBeNull();
  });

  it('copies the full path', async () => {
    const copy = vi.spyOn(clipboard, 'copyText').mockResolvedValue(true);
    const { target } = render(DiffBlock, { file: editFile });
    buttonNamed(target, 'Copy path')!.click();
    await settle();
    expect(copy).toHaveBeenCalledWith('src/lib/render/greeter.py');
    expect(ui.toasts.at(-1)?.text).toBe('Copied');
  });

  it('renders the first 400 lines and expands on Show all', async () => {
    const diff = Array.from({ length: 500 }, (_, i) => `+${i + 1}|line ${i}`).join('\n');
    const { target } = render(DiffBlock, {
      file: { ...createdFile, diff, adds: 500 },
    });
    expect(target.querySelectorAll('.lrow').length).toBe(400);
    buttonNamed(target, /Show all/)!.click();
    await settle();
    expect(target.querySelectorAll('.lrow').length).toBe(500);
    expect(buttonNamed(target, /Show all/)).toBeUndefined();
  });

  it('says when a synthesized file is empty', () => {
    const { target } = render(DiffBlock, { file: { ...createdFile, diff: '', adds: 0 } });
    expect(target.textContent).toContain('Empty file');
  });
});
