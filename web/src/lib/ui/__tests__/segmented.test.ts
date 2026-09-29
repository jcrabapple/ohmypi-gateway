import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '../../../components/__tests__/mount';
import Segmented from '../Segmented.svelte';

afterEach(cleanup);

const options = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' },
] as const;

function mountIt(value: 'a' | 'b' | 'c' = 'a') {
  const onchange = vi.fn();
  const r = render(Segmented<'a' | 'b' | 'c'>, { label: 'Letters', value, options, onchange });
  const radios = [...r.target.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  return { ...r, onchange, radios };
}

const press = (el: Element, key: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('Segmented', () => {
  it('is a labelled radio group with the current option checked and the only tab stop', () => {
    const { target, radios } = mountIt('b');
    expect(target.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Letters');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('clicking chooses', () => {
    const { radios, onchange } = mountIt();
    radios[2]!.click();
    expect(onchange).toHaveBeenCalledWith('c');
  });

  it('arrow keys move and wrap, Home and End jump', () => {
    const a = mountIt('a');
    press(a.radios[0]!, 'ArrowRight');
    expect(a.onchange).toHaveBeenLastCalledWith('b');
    press(a.radios[0]!, 'ArrowLeft');
    expect(a.onchange).toHaveBeenLastCalledWith('c');
    press(a.radios[0]!, 'End');
    expect(a.onchange).toHaveBeenLastCalledWith('c');
    press(a.radios[0]!, 'Home');
    expect(a.onchange).toHaveBeenLastCalledWith('a');
  });

  it('ignores other keys', () => {
    const { radios, onchange } = mountIt();
    press(radios[0]!, 'x');
    expect(onchange).not.toHaveBeenCalled();
  });
});
