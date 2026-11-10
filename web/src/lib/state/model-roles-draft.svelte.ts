// The model-role settings (modelRoles + retry.fallbackChains of the omp
// config) being edited in Settings. Lives outside the page so switching pages
// keeps the edits, and so the overlay can ask "is there unsaved work?" before
// it closes. Same shape as config-draft.svelte.ts.
import { host } from '../api/endpoints';
import { ApiError } from '../api/client';

export interface RolesSnapshot {
  roles: Record<string, string>;
  fallbacks: Record<string, string[]>;
}

function normalize(s: RolesSnapshot): string {
  const sorted = (m: Record<string, unknown>) =>
    Object.keys(m).sort().map((k) => [k, m[k]]);
  return JSON.stringify({ roles: sorted(s.roles), fallbacks: sorted(s.fallbacks) });
}

function clone(s: RolesSnapshot): RolesSnapshot {
  return { roles: { ...s.roles }, fallbacks: { ...s.fallbacks } };
}

class ModelRolesDraft {
  /** The state the gateway last returned or accepted. */
  saved = $state.raw<RolesSnapshot | null>(null);
  roles = $state<Record<string, string>>({});
  fallbacks = $state<Record<string, string[]>>({});
  loading = $state(false);
  loadError = $state<string | null>(null);
  /** The gateway predates this endpoint (GET returned 404): the section shows
   *  a notice instead of a retry that can never succeed. */
  missing = $state(false);
  saving = $state(false);
  /** The gateway's message for the last failed save, shown verbatim. */
  saveError = $state<string | null>(null);
  /** Set after a successful save, e.g. the gateway's note. */
  savedNote = $state<string | null>(null);

  get ready(): boolean {
    return this.saved !== null;
  }

  get dirty(): boolean {
    return this.saved !== null && normalize({ roles: this.roles, fallbacks: this.fallbacks }) !== normalize(this.saved);
  }

  async load(): Promise<void> {
    if (this.dirty || this.loading) return;
    this.loading = true;
    this.loadError = null;
    this.missing = false;
    try {
      const r = await host.modelRoles();
      this.saved = { roles: r.roles, fallbacks: r.fallbacks };
      this.roles = { ...r.roles };
      this.fallbacks = Object.fromEntries(Object.entries(r.fallbacks).map(([k, v]) => [k, [...v]]));
      this.savedNote = null;
      this.saveError = null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) this.missing = true;
      else this.loadError = e instanceof Error ? e.message : 'Could not load the model roles';
    } finally {
      this.loading = false;
    }
  }

  /** '' or null for a role value means unset; an empty or null chain unsets. */
  setRole(role: string, value: string): void {
    if (value === '') delete this.roles[role];
    else this.roles[role] = value;
  }

  setFallbacks(role: string, chain: string[] | null): void {
    if (chain === null || chain.length === 0) delete this.fallbacks[role];
    else this.fallbacks[role] = chain;
  }

  /** Only the roles (or chains) that differ from the saved state are sent;
   *  keys absent from the request keep their value at the gateway. */
  private diff(): ModelRolesDiff {
    const saved = this.saved!;
    const before = saved.roles;
    const after = this.roles;
    const roles: Record<string, string | null> = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const b = before[k] ?? '';
      const a = (after[k] ?? '').trim();
      if (a === b.trim()) continue;
      roles[k] = a === '' ? null : a;
    }
    const fb: Record<string, string[] | null> = {};
    const beforeF = saved.fallbacks;
    const afterF = this.fallbacks;
    for (const k of new Set([...Object.keys(beforeF), ...Object.keys(afterF)])) {
      const chain = (afterF[k] ?? []).map((s) => s.trim()).filter((s) => s !== '');
      const b = beforeF[k] ?? [];
      if (b.length === chain.length && b.every((s, i) => s === chain[i])) continue;
      fb[k] = chain.length === 0 ? null : chain;
    }
    return { roles: Object.keys(roles).length ? roles : undefined, fallbacks: Object.keys(fb).length ? fb : undefined };
  }

  async save(): Promise<boolean> {
    if (this.saving || !this.dirty) return false;
    const change = this.diff();
    if (!change.roles && !change.fallbacks) {
      // Only whitespace changed; adopt the trimmed view as saved.
      this.saved = clone({ roles: this.roles, fallbacks: this.fallbacks });
      return true;
    }
    this.saving = true;
    this.saveError = null;
    this.savedNote = null;
    try {
      const r = await host.saveModelRoles(change);
      this.saved = { roles: r.roles, fallbacks: r.fallbacks };
      this.roles = { ...r.roles };
      this.fallbacks = Object.fromEntries(Object.entries(r.fallbacks).map(([k, v]) => [k, [...v]]));
      this.savedNote = r.note?.trim() || 'Saved';
      return true;
    } catch (e) {
      this.saveError = e instanceof Error ? e.message : 'Could not save the model roles';
      return false;
    } finally {
      this.saving = false;
    }
  }

  revert(): void {
    if (this.saved) {
      this.roles = { ...this.saved.roles };
      this.fallbacks = Object.fromEntries(Object.entries(this.saved.fallbacks).map(([k, v]) => [k, [...v]]));
    }
    this.saveError = null;
    this.savedNote = null;
  }

  /** Forget everything so the next visit loads fresh. */
  discard(): void {
    this.saved = null;
    this.roles = {};
    this.fallbacks = {};
    this.loading = false;
    this.loadError = null;
    this.missing = false;
    this.saveError = null;
    this.savedNote = null;
  }
}

interface ModelRolesDiff {
  roles?: Record<string, string | null>;
  fallbacks?: Record<string, string[] | null>;
}

export const modelRolesDraft = new ModelRolesDraft();
