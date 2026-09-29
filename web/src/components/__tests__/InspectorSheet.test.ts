import { afterEach, describe, expect, it, vi } from 'vitest';
import * as clipboard from '../../lib/platform/clipboard';
import { ui } from '../../lib/state/ui.svelte';
import InspectorSheet from '../InspectorSheet.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  ui.toasts = [];
  ui.inspecting = null;
});

describe('InspectorSheet', () => {
  it('shows pretty JSON with a line count', () => {
    ui.inspecting = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
    const { target } = render(InspectorSheet, { onclose: () => {} });
    const pre = target.querySelector('pre')!;
    expect(pre.textContent).toContain('"role": "user"');
    expect(pre.textContent!.split('\n').length).toBeGreaterThan(3);
    expect(target.querySelector('.count')?.textContent).toMatch(/^\d+ lines$/);
  });

  it('copies exactly what is shown', async () => {
    const copy = vi.spyOn(clipboard, 'copyText').mockResolvedValue(true);
    ui.inspecting = { a: 1 };
    const { target } = render(InspectorSheet, { onclose: () => {} });
    buttonNamed(target, /Copy/)!.click();
    await settle();
    expect(copy).toHaveBeenCalledWith(JSON.stringify({ a: 1 }, null, 2));
    expect(ui.toasts.at(-1)?.text).toBe('JSON copied');
  });

  it('survives circular data', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    ui.inspecting = a;
    const { target } = render(InspectorSheet, { onclose: () => {} });
    expect(target.querySelector('pre')?.textContent).toContain('[circular]');
  });

  it('has an empty state when there is nothing to show', () => {
    ui.inspecting = undefined;
    const { target } = render(InspectorSheet, { onclose: () => {} });
    expect(target.querySelector('pre')).toBeNull();
    expect(target.textContent).toContain('no source');
  });
});
