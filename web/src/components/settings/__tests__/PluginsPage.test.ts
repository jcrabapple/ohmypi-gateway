import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { plugins } from '../../../lib/api/endpoints';
import { ui } from '../../../lib/state/ui.svelte';
import PluginsPage from '../PluginsPage.svelte';
import { buttonNamed, cleanup, render, settle } from '../../__tests__/mount';

const empty = { installed: [], npm: [], marketplace: [], raw: '{\n  "npm": [],\n  "marketplace": []\n}' };

beforeEach(() => {
  vi.spyOn(plugins, 'list').mockResolvedValue(empty);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  ui.confirmRequest = null;
});

describe('PluginsPage', () => {
  it('explains the empty state', async () => {
    const { target } = render(PluginsPage, {});
    await settle();
    expect(target.textContent).toContain('No plugins are installed');
  });

  it('lists an installed plugin with its version and description', async () => {
    vi.spyOn(plugins, 'list').mockResolvedValue({
      installed: [{ name: '@acme/omp-notes', version: '1.2.0', description: 'Note tools' }],
      npm: [{ name: '@acme/omp-notes' }], marketplace: [], raw: '',
    });
    const { target } = render(PluginsPage, {});
    await settle();
    const text = target.textContent!;
    expect(text).toContain('@acme/omp-notes');
    expect(text).toContain('v1.2.0 · Note tools');
  });

  it('installs the package typed into the field', async () => {
    const action = vi.spyOn(plugins, 'action').mockResolvedValue({
      ok: true, action: 'install', target: '@acme/omp-notes', output: 'installed @acme/omp-notes',
    });
    const { target } = render(PluginsPage, {});
    await settle();
    const field = target.querySelector<HTMLInputElement>('form input')!;
    field.value = '@acme/omp-notes';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    buttonNamed(target, 'Install')!.click();
    await settle();
    expect(action).toHaveBeenCalledWith('install', '@acme/omp-notes');
    expect(target.querySelector('pre')?.textContent).toContain('installed @acme/omp-notes');
  });

  it('shows the health check output', async () => {
    vi.spyOn(plugins, 'action').mockResolvedValue({
      ok: true, action: 'doctor', target: '', output: 'Summary: 0 ok, 3 warnings, 0 errors',
    });
    const { target } = render(PluginsPage, {});
    await settle();
    buttonNamed(target, 'Health check')!.click();
    await settle();
    expect(target.querySelector('pre')?.textContent).toContain('0 ok, 3 warnings');
  });

  it('asks before removing a plugin and reports a refused action', async () => {
    vi.spyOn(plugins, 'list').mockResolvedValue({
      installed: [{ name: 'omp-thing' }], npm: [], marketplace: [], raw: '',
    });
    const action = vi.spyOn(plugins, 'action').mockResolvedValue({
      ok: false, action: 'uninstall', target: 'omp-thing', output: 'not installed', error: 'not installed',
    });
    const { target } = render(PluginsPage, {});
    await settle();
    buttonNamed(target, 'Remove')!.click();
    await settle();
    expect(action).not.toHaveBeenCalled();
    expect(ui.confirmRequest?.title).toContain('omp-thing');
    ui.confirmRequest!.resolve(true);
    await settle();
    expect(action).toHaveBeenCalledWith('uninstall', 'omp-thing');
    expect(target.textContent).toContain('not installed');
  });
});
