// The model catalog from `omp models --json`. The first fetch can take about a minute,
// so a cached copy paints immediately and the fresh one replaces it.
import { host } from '../api/endpoints';
import type { CatalogModel } from '../api/types';
import { cacheKey, idbGet, idbSet } from '../platform/idb';

const KEY = cacheKey('catalog-models');

export interface ModelGroup {
  provider: string;
  models: CatalogModel[];
}

export function matchesModel(m: CatalogModel, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).every((word) => `${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(word));
}

export function groupModels(models: readonly CatalogModel[], query = ''): ModelGroup[] {
  const by = new Map<string, CatalogModel[]>();
  for (const m of models) {
    if (m.kind && m.kind !== 'chat') continue;
    if (!matchesModel(m, query)) continue;
    const list = by.get(m.provider) ?? [];
    list.push(m);
    by.set(m.provider, list);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, list]) => ({ provider, models: list.sort((a, b) => a.name.localeCompare(b.name)) }));
}

class ModelCatalog {
  models = $state.raw<CatalogModel[]>([]);
  /** True once any copy (cached or fresh) is on screen. */
  ready = $state(false);
  refreshing = $state(false);
  error = $state<string | null>(null);

  private started = false;

  /** Load once per page. Safe to call every time a picker opens. */
  ensure(): void {
    if (this.started) return;
    this.started = true;
    void this.load();
  }

  retry(): void {
    void this.load();
  }

  find(provider: string | undefined, id: string | undefined): CatalogModel | undefined {
    return this.models.find((m) => m.provider === provider && m.id === id);
  }

  private async load(): Promise<void> {
    this.error = null;
    this.refreshing = true;
    const cached = await idbGet<CatalogModel[]>(KEY);
    if (cached?.length && !this.ready) {
      this.models = cached;
      this.ready = true;
    }
    try {
      const r = await host.catalogModels();
      this.models = r.models;
      this.ready = true;
      void idbSet(KEY, r.models);
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Could not load models';
    } finally {
      this.refreshing = false;
    }
  }
}

export const modelCatalog = new ModelCatalog();
