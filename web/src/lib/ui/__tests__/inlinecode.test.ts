import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '../../../components/__tests__/mount';
import InlineCode from '../InlineCode.svelte';

afterEach(cleanup);

describe('InlineCode', () => {
  it('renders backtick spans as code elements', () => {
    const { target } = render(InlineCode, { text: 'Run `ls gateway` with bash' });
    expect(target.querySelectorAll('code')).toHaveLength(1);
    expect(target.querySelector('code')!.textContent).toBe('ls gateway');
    expect(target.textContent).toBe('Run ls gateway with bash');
  });
  it('never turns text into markup', () => {
    const { target } = render(InlineCode, { text: '<img src=x onerror=alert(1)> `<b>hi</b>`' });
    expect(target.querySelector('img')).toBeNull();
    expect(target.querySelector('b')).toBeNull();
    expect(target.querySelector('code')!.textContent).toBe('<b>hi</b>');
  });
});
