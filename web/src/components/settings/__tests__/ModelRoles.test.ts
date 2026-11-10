import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { host } from '../../../lib/api/endpoints';
import { ApiError } from '../../../lib/api/client';
import type { CatalogModel, ModelRolesState } from '../../../lib/api/types';
import { modelCatalog } from '../../../lib/state/models.svelte';
import { modelRolesDraft } from '../../../lib/state/model-roles-draft.svelte';
import ModelsPage from '../ModelsPage.svelte';
import { buttonNamed, cleanup, render, settle } from '../../__tests__/mount';

const model = (provider: string, id: string, name: string, thinking: string[] | null = ['low', 'high', 'max']): CatalogModel => ({
  provider, kind: 'chat', id, selector: `${provider}/${id}`, name, contextWindow: 200000,
  maxTokens: 8192, reasoning: true, thinking, input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
});

const catalog: CatalogModel[] = [model('a', 'b', 'A B'), model('c', 'd', 'C D', null)];

const state: ModelRolesState = {
  roles: { default: 'a/b:max', smol: '', web: 'web/exa' },
  fallbacks: { default: ['c/d'], web: ['web/kagi'] },
};

const saved: ModelRolesState = {
  roles: { default: 'a/b', smol: 'c/d', web: 'web/exa' },
  fallbacks: { default: ['a/b', 'c/d'], slow: ['c/d', 'a/b'] },
};

const inputFor = (root: ParentNode, role: string) =>
  root.querySelector<HTMLInputElement>(`input[aria-label="${role} model selector"]`);

const chipFor = (root: ParentNode, role: string) =>
  root.querySelector<HTMLButtonElement>(`button.model[data-role="${role}"]`);

/** Raw-selector mode: the escape hatch for aliases and candidate lists. */
async function editSelectors(root: ParentNode): Promise<void> {
  const toggle = [...root.querySelectorAll('button')].find((b) => /Edit selectors/.test(b.textContent ?? ''));
  if (toggle) {
    toggle.click();
    await settle();
  }
}

beforeEach(() => {
  vi.spyOn(host, 'catalogModels').mockResolvedValue({ models: catalog });
  vi.spyOn(host, 'modelRoles').mockResolvedValue(state);
  // The catalog store is a page-lifetime singleton; seed it so labels resolve.
  modelCatalog.models = catalog;
  modelCatalog.ready = true;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  modelRolesDraft.discard();
  modelCatalog.models = [];
});

/** Mount and let the roles draft and the catalog settle (both fetch on mount). */
async function mountPage() {
  const page = render(ModelsPage, {});
  await settle();
  await new Promise((r) => setTimeout(r, 0));
  await settle();
  return page;
}

describe('ModelsPage roles editor', () => {
  it('shows every chat role plus the model-kind roles the config sets, by name', async () => {
    const { target } = await mountPage();
    await settle();
    expect(chipFor(target, 'default')!.textContent).toContain('A B');
    expect(chipFor(target, 'smol')!.textContent).toContain('Not set');
    // Model-kind roles keep raw selectors: their values are not chat models.
    expect(inputFor(target, 'web')!.value).toBe('web/exa');
    expect(inputFor(target, 'judge')).toBeNull();
    // The web role's chain is visible and editable, not hidden.
    expect(target.querySelector<HTMLInputElement>('input[aria-label="Fallback 1 for web"]')!.value).toBe('web/kagi');
  });

  it('sends only the roles that changed', async () => {
    const save = vi.spyOn(host, 'saveModelRoles').mockResolvedValue({ ...saved, ok: true, note: 'Saved' });
    const { target } = await mountPage();
    await settle();
    await editSelectors(target);
    const smol = inputFor(target, 'smol')!;
    smol.value = 'c/d';
    smol.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await settle();
    await buttonNamed(target, 'Save')!.click();
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ roles: { smol: 'c/d' } });
    expect(target.querySelector('[role="alert"]')).toBeNull();
  });

  it('unsets a role from its model chip', async () => {
    const save = vi.spyOn(host, 'saveModelRoles').mockResolvedValue({ ...state, ok: true, note: 'Saved' });
    const { target } = await mountPage();
    await settle();
    await buttonNamed(target, 'Unset default')!.click();
    await settle();
    expect(chipFor(target, 'default')!.textContent).toContain('Not set');
    await buttonNamed(target, 'Save')!.click();
    await settle();
    expect(save).toHaveBeenCalledWith({ roles: { default: null } });
  });

  it('edits fallback chains by add, move and remove', async () => {
    const save = vi.spyOn(host, 'saveModelRoles').mockResolvedValue({ ...state, ok: true, note: 'Saved' });
    const { target } = await mountPage();
    await settle();
    await editSelectors(target);
    await buttonNamed(target, 'Add fallback for default')!.click();
    await settle();
    const second = target.querySelector<HTMLInputElement>('input[aria-label="Fallback 2 for default"]')!;
    second.value = 'a/b';
    second.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await settle();
    await buttonNamed(target, 'Move fallback 2 up for default')!.click();
    await settle();
    await buttonNamed(target, 'Save')!.click();
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ fallbacks: { default: ['a/b', 'c/d'] } });
  });

  it('unsets a whole chain when the last fallback goes', async () => {
    vi.spyOn(host, 'modelRoles').mockResolvedValue(saved);
    const save = vi.spyOn(host, 'saveModelRoles').mockResolvedValue({ roles: saved.roles, fallbacks: {}, ok: true, note: 'Saved' });
    const { target } = await mountPage();
    await settle();
    await buttonNamed(target, 'Remove fallback 1 for default')!.click();
    await settle();
    await buttonNamed(target, 'Remove fallback 1 for default')!.click();
    await settle();
    expect(target.querySelector('button[aria-label="Remove fallback 1 for default"]')).toBeNull();
    // The slow chain is untouched.
    expect(target.querySelector('button[aria-label="Remove fallback 1 for slow"]')).not.toBeNull();
    await buttonNamed(target, 'Save')!.click();
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ fallbacks: { default: null } });
  });

  it('says the gateway predates model roles instead of offering retry', async () => {
    vi.spyOn(host, 'modelRoles').mockRejectedValue(new ApiError(404, 'Not Found'));
    const { target } = await mountPage();
    await settle();
    expect(target.textContent).toContain('does not serve model roles yet');
    expect(buttonNamed(target, 'Try again')).toBeUndefined();
    // The catalog section is unaffected by the version skew.
    expect(target.querySelector('input[type="search"]')).not.toBeNull();
  });

  it('shows the gateway message verbatim when a save is rejected', async () => {
    vi.spyOn(host, 'saveModelRoles').mockRejectedValue(new Error('omp rejected the change, reverted: bad selector'));
    const { target } = await mountPage();
    await settle();
    await editSelectors(target);
    const smol = inputFor(target, 'smol')!;
    smol.value = 'c/d';
    smol.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await settle();
    await buttonNamed(target, 'Save')!.click();
    await settle();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('omp rejected the change, reverted: bad selector');
    // The edit survives a failed save so it can be fixed and retried.
    expect(inputFor(target, 'smol')!.value).toBe('c/d');
  });

  it('offers a thinking-level select for models that support it', async () => {
    const { target } = await mountPage();
    await settle();
    const sel = target.querySelector<HTMLSelectElement>('select[aria-label="Thinking level for default"]')!;
    expect(sel).not.toBeNull();
    expect(sel.selectedOptions[0]!.value).toBe('max');
    expect(sel.textContent).toContain('high');
    // A model without thinking levels gets no select.
    expect(target.querySelector('select[aria-label="Thinking level for smol"]')).toBeNull();
  });
});

describe('ModelsPage catalog', () => {
  it('caps the list and grows on demand', async () => {
    modelCatalog.models = Array.from({ length: 45 }, (_, i) => model('a', `m${i}`, `Model ${i}`, null));
    modelCatalog.ready = true;
    const { target } = await mountPage();
    await settle();
    expect(target.querySelectorAll('[id="setting-catalog"] li').length).toBe(40);
    expect(target.textContent).toContain('45 models · showing 40');
    await buttonNamed(target, /Show 40 more/)!.click();
    await settle();
    expect(target.querySelectorAll('[id="setting-catalog"] li').length).toBe(45);
  });

  it('filters by provider chip', async () => {
    modelCatalog.models = [...catalog, model('z', 'y', 'Z Y', null)];
    modelCatalog.ready = true;
    const { target } = await mountPage();
    await settle();
    const chip = [...target.querySelectorAll<HTMLButtonElement>('.provs button')].find((b) => b.textContent?.trim() === 'z');
    expect(chip).toBeDefined();
    chip!.click();
    await settle();
    const rows = [...target.querySelectorAll('[id="setting-catalog"] li')];
    expect(rows.length).toBe(1);
    expect(rows[0]!.textContent).toContain('Z Y');
  });
});
