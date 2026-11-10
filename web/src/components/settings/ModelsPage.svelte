<script lang="ts">
  // The Models page: which model sits behind each omp role, plus the catalog to
  // pick from. Rows show the model by name (the raw selector is one click away
  // for aliases, wildcards and comma-separated candidate lists), fallback
  // chains are first-class chips instead of a hidden textarea, and the catalog
  // is search-first so 1,800 models do not land in the DOM at once.
  import { onMount } from 'svelte';
  import type { CatalogModel } from '../../lib/api/types';
  import { compactNumber, priceLabel } from '../../lib/format';
  import { active, modelCatalog } from '../../lib/state';
  import { modelRolesDraft as draft } from '../../lib/state/model-roles-draft.svelte';
  import { groupModels, type ModelGroup } from '../../lib/state/models.svelte';
  import { Icon, Spinner, toast } from '../../lib/ui';
  import ModelPicker from '../ModelPicker.svelte';
  import LoadState from './LoadState.svelte';
  import Section from './Section.svelte';

  const uid = $props.id();

  let query = $state('');
  let provider = $state('all');
  let limit = $state(40);
  /** Power-user switch: edit raw selectors instead of picking models. */
  let showSelectors = $state(false);
  let busy = $state<string | null>(null);

  // omp's own roles (docs/models.md). Chat roles always show; model-kind and
  // custom roles show when the config sets them.
  interface RoleDef { id: string; kind: 'chat' | 'model'; hint: string }
  const CHAT_ROLES: RoleDef[] = [
    { id: 'default', kind: 'chat', hint: 'Main model for new sessions and chat turns' },
    { id: 'smol', kind: 'chat', hint: 'Lightweight background work: titles, summaries, small edits' },
    { id: 'slow', kind: 'chat', hint: 'Deep reasoning and long-thinking tasks' },
    { id: 'plan', kind: 'chat', hint: 'Plan mode' },
    { id: 'vision', kind: 'chat', hint: 'Reading screenshots and images' },
    { id: 'commit', kind: 'chat', hint: 'Commit message generation' },
    { id: 'tiny', kind: 'chat', hint: 'Tiny background jobs; inherits the auxiliary model' },
    { id: 'memory', kind: 'chat', hint: 'Memory operations; inherits the tiny model' },
    { id: 'task', kind: 'chat', hint: 'Task agents' },
    { id: 'advisor', kind: 'chat', hint: 'The advisor runtime, when advisor is enabled' },
  ];
  const KIND_ROLES: RoleDef[] = [
    { id: 'image', kind: 'model', hint: 'Image generation' },
    { id: 'web', kind: 'model', hint: 'Web search provider' },
    { id: 'speech', kind: 'model', hint: 'Speech' },
    { id: 'dictation', kind: 'model', hint: 'Dictation' },
    { id: 'judge', kind: 'model', hint: 'Judgment runners' },
  ];

  onMount(() => {
    modelCatalog.ensure();
    void draft.load();
  });

  function key(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    }
  }

  // ---------------------------------------------------------------- selectors

  interface Parsed { provider: string | null; id: string | null; level: string; alias: string | null; raw: string }

  /** First comma segment of a value, split into catalog model, thinking
   *  suffix and role alias. `web/exa` and `@smol` have no chat-model match. */
  function parse(value: string): Parsed {
    const raw = value.split(',')[0]!.trim();
    if (raw.startsWith('@')) return { provider: null, id: null, level: '', alias: raw.slice(1), raw };
    const colon = raw.lastIndexOf(':');
    const base = colon > 0 ? raw.slice(0, colon) : raw;
    const level = colon > 0 ? raw.slice(colon + 1) : '';
    const slash = base.indexOf('/');
    if (slash <= 0) return { provider: null, id: null, level: '', alias: null, raw };
    return { provider: base.slice(0, slash), id: base.slice(slash + 1), level, alias: null, raw };
  }

  const candidates = (value: string) => value.split(',').map((s) => s.trim()).filter(Boolean);

  function catalogFor(value: string): CatalogModel | null {
    const p = parse(value);
    return p.provider && p.id ? (modelCatalog.find(p.provider, p.id) ?? null) : null;
  }

  /** Human label for one selector: the catalog name when known, else the raw
   *  selector (`web/kagi`, `provider/model:level`) so nothing is ambiguous. */
  function label(value: string): string {
    if (!value.trim()) return 'Empty';
    const p = parse(value);
    if (p.alias) return `@${p.alias}`;
    const m = catalogFor(value);
    return m ? m.name : p.raw;
  }

  /** The provider, only when the catalog knows the model (a raw selector
   *  already carries its provider). */
  function providerLabel(value: string): string {
    return catalogFor(value)?.provider ?? '';
  }

  /** A selector the catalog does not know about: worth a nudge, never a block. */
  function unknown(value: string): boolean {
    const p = parse(value);
    if (!value.trim() || p.alias || !p.provider) return false;
    return catalogFor(value) === null;
  }

  /** Rewrite the first segment's thinking suffix, keeping the rest untouched. */
  function applyLevel(value: string, level: string): string {
    const segs = value.split(',').map((s) => s.trim());
    const colon = segs[0]!.lastIndexOf(':');
    segs[0] = (colon > 0 ? segs[0]!.slice(0, colon) : segs[0]!) + (level ? ':' + level : '');
    return segs.join(', ');
  }

  function setLevel(role: string, value: string, level: string): void {
    draft.setRole(role, applyLevel(value, level));
  }

  // -------------------------------------------------------------------- rows

  const rows = $derived.by(() => {
    const chat = CHAT_ROLES.map((def) => ({ def, value: draft.roles[def.id] ?? '' }));
    const known = new Set(CHAT_ROLES.map((c) => c.id));
    const rest = [...Object.keys(draft.roles)]
      .filter((id) => !known.has(id))
      .sort()
      .map((id) => ({
        def: KIND_ROLES.find((k) => k.id === id) ?? { id, kind: 'model' as const, hint: 'Custom role; model picker does not apply' },
        value: draft.roles[id] ?? '',
      }));
    return [...chat, ...rest];
  });

  const setRoles = $derived(rows.filter((r) => r.def.kind === 'chat' && r.value.trim()).length);
  const chainCount = $derived(Object.keys(draft.fallbacks).length);

  const chain = (role: string): string[] => draft.fallbacks[role] ?? [];

  function roleChanged(id: string): boolean {
    return (draft.roles[id] ?? '') !== (draft.saved?.roles[id] ?? '');
  }

  function chainChanged(id: string): boolean {
    const a = chain(id);
    const b = draft.saved?.fallbacks[id] ?? [];
    return a.length !== b.length || a.some((s, i) => s !== b[i]);
  }

  function editChain(role: string, next: string[]): void {
    draft.setFallbacks(role, next);
  }

  function moveChainEntry(list: string[], i: number, delta: number): string[] {
    const next = [...list];
    const moved = next.splice(i, 1)[0];
    if (moved === undefined) return next;
    next.splice(i + delta, 0, moved);
    return next;
  }

  function replaceChainEntry(role: string, i: number, value: string): void {
    const next = [...chain(role)];
    next[i] = value;
    editChain(role, next);
  }

  /** True when the chain holds two entries with the same display name (the
   *  same model from two providers): those chips show the provider too. */
  function ambiguous(role: string, i: number): boolean {
    const names = chain(role).map((s) => label(s));
    return names.filter((n) => n === names[i]).length > 1;
  }

  async function save(): Promise<void> {
    if (!draft.dirty || draft.saving) return;
    const ok = await draft.save();
    if (ok) toast('Model roles saved');
  }

  // ------------------------------------------------------------------ picker

  // Which selector is being picked: null = the role's own value, a number =
  // that fallback slot (chain.length = "add a fallback").
  let pick = $state<{ role: string; entry: number | null; anchor: HTMLElement } | null>(null);
  const pickerOpen = $derived(pick !== null);
  const pickerCurrent = $derived.by(() => {
    if (!pick) return null;
    const v = pick.entry === null ? (draft.roles[pick.role] ?? '') : chain(pick.role)[pick.entry] ?? '';
    const p = parse(v);
    return p.provider && p.id ? { provider: p.provider, id: p.id } : null;
  });

  function openPicker(role: string, entry: number | null, anchor: HTMLElement): void {
    pick = { role, entry, anchor };
  }

  function addFallback(row: RoleDef, anchor: HTMLElement): void {
    if (row.kind === 'model' || showSelectors) editChain(row.id, [...chain(row.id), '']);
    else openPicker(row.id, chain(row.id).length, anchor);
  }

  function pickModel(m: CatalogModel | null): void {
    if (!m || !pick) return;
    const { role, entry } = pick;
    if (entry === null) {
      // Keep the role's thinking level when the new model supports it.
      const prev = parse(draft.roles[role] ?? '');
      const keep = prev.level && (m.thinking ?? []).includes(prev.level) ? prev.level : '';
      draft.setRole(role, m.selector + (keep ? ':' + keep : ''));
    } else {
      const next = [...chain(role)];
      if (entry >= next.length) next.push(m.selector);
      else next[entry] = m.selector;
      editChain(role, next);
    }
    pick = null;
  }

  // ----------------------------------------------------------------- catalog

  const chatModels = $derived(modelCatalog.models.filter((m) => !m.kind || m.kind === 'chat'));
  const providers = $derived([...new Set(chatModels.map((m) => m.provider))].sort());
  const matchedGroups = $derived(groupModels(modelCatalog.models, query).filter((g) => provider === 'all' || g.provider === provider));
  const matched = $derived(matchedGroups.reduce((n, g) => n + g.models.length, 0));
  const groups = $derived.by(() => {
    let left = limit;
    const out: ModelGroup[] = [];
    for (const g of matchedGroups) {
      if (left <= 0) break;
      const models = g.models.slice(0, left);
      left -= models.length;
      if (models.length) out.push({ provider: g.provider, models });
    }
    return out;
  });
  const shown = $derived(groups.reduce((n, g) => n + g.models.length, 0));

  $effect(() => {
    void query;
    void provider;
    limit = 40;
  });

  /** selector -> roles that use it, so the catalog says where a model is wired. */
  const usedBy = $derived.by(() => {
    const map = new Map<string, string[]>();
    const add = (value: string, role: string) => {
      for (const seg of candidates(value)) {
        const p = parse(seg);
        if (!p.provider || !p.id) continue;
        const k = `${p.provider}/${p.id}`;
        const list = map.get(k) ?? [];
        if (!list.includes(role)) list.push(role);
        map.set(k, list);
      }
    };
    for (const [role, value] of Object.entries(draft.roles)) add(value, role);
    for (const [role, list] of Object.entries(draft.fallbacks)) list.forEach((v) => add(v, role));
    return map;
  });

  const rolesFor = (m: CatalogModel): string[] => usedBy.get(`${m.provider}/${m.id}`) ?? [];

  const open = $derived(active.gwId !== null && active.phase === 'ready' && !active.info?.exited);
  const current = $derived(active.info?.model);
  const isCurrent = (m: CatalogModel) => current?.provider === m.provider && current?.id === m.id;

  async function use(m: CatalogModel) {
    busy = m.selector;
    try {
      await active.setModel(m.provider, m.id);
      toast(`Now using ${m.name}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not switch model', { kind: 'error' });
    } finally {
      busy = null;
    }
  }
</script>

<svelte:window onkeydown={key} />

<div class="models">
  <Section
    id="roles"
    title="Model roles"
    hint="What omp uses for each job. Saved to the gateway's config.yml; running sessions pick a change up when they restart."
  >
    {#snippet actions()}
      <button
        type="button"
        class="btn btn-sm btn-ghost"
        aria-pressed={showSelectors}
        title="Edit the raw selector strings: aliases (@smol), wildcards (provider/*) and comma-separated candidates"
        onclick={() => (showSelectors = !showSelectors)}
      >
        <Icon name="sliders" size={14} />
        {showSelectors ? 'Hide selectors' : 'Edit selectors'}
      </button>
    {/snippet}

    {#if draft.missing}
      <p class="msg" role="status">
        This gateway does not serve model roles yet. Update the gateway on the host, then reopen settings.
      </p>
    {:else}
      <LoadState ready={draft.ready} error={draft.loadError} refreshing={draft.loading} rows={8} onretry={() => draft.load()}>
        <p class="summary">
          {setRoles} of {CHAT_ROLES.length} chat roles set · {chainCount}
          {chainCount === 1 ? 'fallback chain' : 'fallback chains'}
        </p>

        <div class="roles">
          {#each rows as row (row.def.id)}
            {@const value = row.value}
            {@const parsed = parse(value)}
            {@const cm = catalogFor(value)}
            {@const levels = cm?.thinking ?? []}
            {@const multi = candidates(value).length > 1}
            {@const raw = showSelectors || row.def.kind === 'model' || multi}
            {@const changed = roleChanged(row.def.id) || chainChanged(row.def.id)}
            <div class="role" class:changed>
              <div class="who">
                <code class="rid">{row.def.id}</code>
              </div>

              <div class="what">
                {#if raw}
                  <div class="rawline">
                    <input
                      class="field mono"
                      type="text"
                      spellcheck="false"
                      autocapitalize="off"
                      autocomplete="off"
                      placeholder={row.def.kind === 'model' ? 'provider/model' : 'not set'}
                      aria-label="{row.def.id} model selector"
                      value={value}
                      oninput={(e) => draft.setRole(row.def.id, e.currentTarget.value)}
                    />
                    {#if levels.length && !multi}
                      <label class="lvl">
                        <span class="sr-only">Thinking level for {row.def.id}</span>
                        <select
                          class="field"
                          aria-label="Thinking level for {row.def.id}"
                          value={parsed.level}
                          onchange={(e) => setLevel(row.def.id, value, e.currentTarget.value)}
                        >
                          <option value="">default</option>
                          {#each levels as lvl (lvl)}<option value={lvl}>{lvl}</option>{/each}
                        </select>
                      </label>
                    {/if}
                    {#if value.trim()}
                      <button
                        type="button"
                        class="icon-btn"
                        aria-label="Unset {row.def.id}"
                        onclick={() => draft.setRole(row.def.id, '')}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    {/if}
                  </div>
                {:else}
                  <div class="mainline">
                    <button
                      type="button"
                      class="model"
                      class:unset={!value.trim()}
                      data-role={row.def.id}
                      onclick={(e) => openPicker(row.def.id, null, e.currentTarget)}
                      aria-label={value.trim()
                        ? `Change ${row.def.id} model, currently ${label(value)}`
                        : `Choose a model for ${row.def.id}`}
                    >
                      {#if value.trim()}
                        <span class="mname truncate">{label(value)}</span>
                        {#if providerLabel(value)}<span class="mprov">{providerLabel(value)}</span>{/if}
                        {#if unknown(value)}
                          <span class="flag" title="Not in the model catalog: omp will not resolve this role.">
                            <Icon name="alert" size={13} />
                          </span>
                        {/if}
                      {:else}
                        <span class="mname unset">Not set</span>
                        <span class="mprov">choose a model</span>
                      {/if}
                      <Icon name="chevron-down" size={14} />
                    </button>
                    {#if levels.length}
                      <label class="lvl">
                        <span class="sr-only">Thinking level for {row.def.id}</span>
                        <select
                          class="field"
                          aria-label="Thinking level for {row.def.id}"
                          value={parsed.level}
                          onchange={(e) => setLevel(row.def.id, value, e.currentTarget.value)}
                        >
                          <option value="">default</option>
                          {#each levels as lvl (lvl)}<option value={lvl}>{lvl}</option>{/each}
                        </select>
                      </label>
                    {/if}
                    {#if value.trim()}
                      <button
                        type="button"
                        class="icon-btn"
                        aria-label="Unset {row.def.id}"
                        onclick={() => draft.setRole(row.def.id, '')}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    {/if}
                  </div>
                {/if}

                <p class="rhint">{row.def.hint}</p>

                <div class="chain">
                  <span class="clabel">Fallbacks</span>
                  {#each chain(row.def.id) as sel, i (i)}
                    <span class="fb">
                      <span class="idx">{i + 1}</span>
                      {#if raw}
                        <input
                          class="field mono fbinput"
                          type="text"
                          spellcheck="false"
                          autocapitalize="off"
                          autocomplete="off"
                          placeholder="provider/model"
                          aria-label="Fallback {i + 1} for {row.def.id}"
                          value={sel}
                          oninput={(e) => replaceChainEntry(row.def.id, i, e.currentTarget.value)}
                        />
                      {:else}
                        <button
                          type="button"
                          class="fbname truncate"
                          onclick={(e) => openPicker(row.def.id, i, e.currentTarget)}
                          aria-label="Change fallback {i + 1} for {row.def.id}, currently {label(sel)}"
                        >
                          <span class="truncate">{label(sel)}</span>
                          {#if ambiguous(row.def.id, i) && providerLabel(sel)}
                            <span class="fbprov">{providerLabel(sel)}</span>
                          {/if}
                          {#if unknown(sel)}<Icon name="alert" size={12} />{/if}
                        </button>
                      {/if}
                      <button
                        type="button"
                        class="icon-btn mini"
                        disabled={i === 0}
                        onclick={() => editChain(row.def.id, moveChainEntry(chain(row.def.id), i, -1))}
                        aria-label="Move fallback {i + 1} up for {row.def.id}"
                      >
                        <Icon name="arrow-up" size={12} />
                      </button>
                      <button
                        type="button"
                        class="icon-btn mini"
                        disabled={i === chain(row.def.id).length - 1}
                        onclick={() => editChain(row.def.id, moveChainEntry(chain(row.def.id), i, 1))}
                        aria-label="Move fallback {i + 1} down for {row.def.id}"
                      >
                        <Icon name="arrow-down" size={12} />
                      </button>
                      <button
                        type="button"
                        class="icon-btn mini"
                        onclick={() => editChain(row.def.id, chain(row.def.id).filter((_, j) => j !== i))}
                        aria-label="Remove fallback {i + 1} for {row.def.id}"
                      >
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  {/each}
                  <button
                    type="button"
                    class="add"
                    onclick={(e) => addFallback(row.def, e.currentTarget)}
                    aria-label="Add fallback for {row.def.id}"
                  >
                    <Icon name="plus" size={12} />
                    {chain(row.def.id).length ? 'Add' : 'Add fallback'}
                  </button>
                </div>
              </div>
            </div>
          {/each}
        </div>

        {#if draft.savedNote && !draft.dirty}
          <p class="saved" aria-live="polite">{draft.savedNote}</p>
        {/if}
      </LoadState>
    {/if}
  </Section>

  {#if draft.dirty || draft.saving || draft.saveError}
    <div class="bar">
      <p class="status" aria-live="polite">
        {#if draft.saveError}
          <span class="msg bad" role="alert">{draft.saveError}</span>
        {:else}
          Unsaved changes
        {/if}
      </p>
      <button type="button" class="btn btn-ghost" disabled={draft.saving} onclick={() => draft.revert()}>Revert</button>
      <button type="button" class="btn btn-primary" disabled={draft.saving} onclick={() => save()}>
        {#if draft.saving}<Spinner size={13} label="Saving" />{/if}
        Save
      </button>
    </div>
  {/if}

  <Section
    id="catalog"
    title="Model catalog"
    hint={open
      ? 'Every chat model omp can reach from this host. Switch the open session, or check which roles use a model.'
      : 'Every chat model omp can reach from this host. Open a session to switch its model from here.'}
  >
    <div class="tools">
      <div class="searchbox">
        <Icon name="search" size={15} />
        <label class="sr-only" for="{uid}-q">Search models</label>
        <input
          id="{uid}-q"
          type="search"
          placeholder="Search by name, provider or id"
          autocomplete="off"
          spellcheck="false"
          bind:value={query}
        />
        {#if query}
          <button type="button" class="icon-btn" aria-label="Clear search" onclick={() => (query = '')}>
            <Icon name="x" size={14} />
          </button>
        {/if}
      </div>
      <div class="provs" role="group" aria-label="Filter by provider">
        <button
          type="button"
          class="chip"
          class:on={provider === 'all'}
          aria-pressed={provider === 'all'}
          onclick={() => (provider = 'all')}
        >
          All
        </button>
        {#each providers as p (p)}
          <button
            type="button"
            class="chip"
            class:on={provider === p}
            aria-pressed={provider === p}
            onclick={() => (provider = p)}
          >
            {p}
          </button>
        {/each}
      </div>
    </div>

    <LoadState ready={modelCatalog.ready} error={modelCatalog.error} refreshing={modelCatalog.refreshing} rows={6} onretry={() => modelCatalog.retry()}>
      <p class="count" role="status">
        {#if query.trim() || provider !== 'all'}
          {matched} {matched === 1 ? 'model matches' : 'models match'}
        {:else}
          {matched} models · showing {shown}
        {/if}
      </p>

      {#each groups as g (g.provider)}
        <div class="group">
          <h4 class="eyebrow ghead">{g.provider}<span class="gn">{g.models.length}</span></h4>
          <ul>
            {#each g.models as m (m.selector)}
              {@const roles = rolesFor(m)}
              {@const dupe = g.models.some((x) => x.id !== m.id && x.name === m.name)}
              <li>
                <div class="info">
                  <span class="name truncate">{m.name}</span>
                  <span class="meta truncate">
                    {#if dupe}<span class="mid mono">{m.id} · </span>{/if}
                    {compactNumber(m.contextWindow)} context · {priceLabel(m.cost)}{m.reasoning ? ' · reasoning' : ''}
                  </span>
                </div>
                {#if roles.length}
                  <span class="uses" aria-label="Used by {roles.join(', ')}">
                    {#each roles.slice(0, 3) as r (r)}<span class="use">{r}</span>{/each}
                    {#if roles.length > 3}<span class="use">+{roles.length - 3}</span>{/if}
                  </span>
                {/if}
                {#if isCurrent(m)}
                  <span class="now"><Icon name="check" size={14} /> In use</span>
                {:else if open}
                  <button
                    type="button"
                    class="btn btn-sm"
                    disabled={busy !== null}
                    onclick={() => use(m)}
                    aria-label="Use {m.name} in this session"
                  >
                    {#if busy === m.selector}<Spinner size={12} label="Switching" />{/if}
                    Use
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {:else}
        <p class="empty">No models match "{query.trim()}"</p>
      {/each}

      {#if shown < matched}
        <button type="button" class="btn btn-sm more" onclick={() => (limit += 40)}>
          Show 40 more ({matched - shown} left)
        </button>
      {/if}
    </LoadState>
  </Section>
</div>

{#if pickerOpen}
  <ModelPicker
    open
    onclose={() => (pick = null)}
    anchor={pick?.anchor}
    current={pickerCurrent}
    onpick={pickModel}
  />
{/if}

<style>
  .models {
    container-type: inline-size;
  }

  .summary {
    color: var(--ink-3);
    font-size: var(--fs-sm);
    margin-bottom: var(--s-1);
  }

  .roles {
    display: grid;
  }
  .role {
    position: relative;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--s-1) var(--s-4);
    padding: var(--s-3) 0;
    border-bottom: 1px solid var(--line);
  }
  .role:last-child {
    border-bottom: 0;
    padding-bottom: var(--s-1);
  }
  .role.changed::before {
    content: '';
    position: absolute;
    left: calc(var(--s-2) * -1);
    top: var(--s-3);
    bottom: var(--s-3);
    width: 2px;
    border-radius: 2px;
    background: var(--accent);
  }
  .who {
    padding-top: 9px;
  }
  .rid {
    font-family: var(--mono);
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--ink);
  }
  .rhint {
    color: var(--ink-3);
    font-size: var(--fs-sm);
    line-height: 1.35;
    margin: calc(var(--s-1) * -1) 0 0;
    overflow-wrap: anywhere;
  }
  .what {
    display: grid;
    gap: var(--s-2);
    min-width: 0;
  }
  .mainline,
  .rawline {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-width: 0;
  }
  .rawline .field {
    flex: 1;
    min-width: 0;
  }

  .model {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-height: calc(var(--hit) + 6px);
    padding: 0 var(--s-3);
    background: var(--field);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-md);
    text-align: left;
    cursor: pointer;
    transition: border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
  }
  .model:hover {
    border-color: var(--ink-3);
    background: var(--inset);
  }
  .model.unset {
    border-style: dashed;
    background: transparent;
  }
  .mname {
    font-weight: 500;
  }
  .mname.unset {
    color: var(--ink-3);
    font-weight: 400;
  }
  .mprov {
    color: var(--ink-3);
    font-size: var(--fs-xs);
    flex: none;
  }
  .model :global(svg:last-child) {
    margin-left: auto;
    flex: none;
    color: var(--ink-3);
  }
  .flag {
    display: inline-flex;
    color: var(--warn);
    flex: none;
  }
  .lvl .field {
    width: auto;
    min-width: 6.5rem;
    min-height: calc(var(--hit) + 6px);
    padding: 0 var(--s-2);
    font-size: var(--fs-sm);
  }

  .chain {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-1) var(--s-2);
  }
  .clabel {
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .fb {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    max-width: 100%;
    padding-left: var(--s-2);
    border-radius: 999px;
    background: var(--inset);
  }
  .idx {
    color: var(--ink-3);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
  }
  .fbname {
    max-width: 13rem;
    min-height: 26px;
    padding: 0 var(--s-1) 0 2px;
    font-size: var(--fs-sm);
    color: var(--ink-2);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    min-width: 0;
  }
  .fbname:hover {
    color: var(--ink);
  }
  .fbinput {
    width: 11rem;
    min-height: 26px;
    padding: 0 var(--s-2);
    font-size: var(--fs-xs);
  }
  .icon-btn.mini {
    width: 22px;
    height: 22px;
    border-radius: 50%;
  }
  .add {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    min-height: 32px;
    padding: 0 var(--s-2);
    border: 1px dashed var(--line-strong);
    border-radius: 999px;
    color: var(--ink-3);
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .add:hover {
    color: var(--ink);
    border-color: var(--ink-3);
  }

  .saved {
    color: var(--ok);
    font-size: var(--fs-sm);
    margin-top: var(--s-2);
  }

  .bar {
    position: sticky;
    bottom: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: var(--s-2);
    margin: calc(var(--s-2) * -1) calc(var(--s-5) * -1) 0;
    padding: var(--s-3) var(--s-5);
    background: var(--surface);
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }
  .status {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--ink-2);
    font-size: var(--fs-sm);
    margin: 0;
  }
  .msg.bad {
    display: block;
    color: var(--err);
    overflow-wrap: anywhere;
  }

  .tools {
    display: grid;
    gap: var(--s-2);
  }
  .searchbox {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: 0 var(--s-3);
    border-radius: var(--r-md);
    background: var(--field);
    box-shadow: var(--ring);
    color: var(--ink-3);
  }
  .searchbox:focus-within {
    box-shadow: var(--focus);
    color: var(--accent);
  }
  .searchbox input {
    flex: 1;
    min-width: 0;
    min-height: var(--hit);
    padding: 0;
    border: 0;
    background: none;
    color: var(--ink);
    appearance: none;
  }
  .searchbox input:focus-visible {
    outline: none;
  }
  .searchbox input::-webkit-search-cancel-button {
    display: none;
  }
  .provs {
    display: flex;
    gap: var(--s-1);
    overflow-x: auto;
    padding-bottom: 2px;
    scrollbar-width: none;
  }
  .provs::-webkit-scrollbar {
    display: none;
  }
  .chip {
    flex: none;
    min-height: 26px;
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .chip.on {
    background: var(--accent-soft);
    color: var(--ink);
  }
  .count {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }

  .group ul {
    list-style: none;
    margin: 0 0 var(--s-3);
    padding: 0;
  }
  .ghead {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    position: sticky;
    top: 0;
    z-index: 1;
    padding: var(--s-2) 0 var(--s-1);
    background: var(--surface);
  }
  .gn {
    color: var(--ink-3);
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-height: 44px;
    padding: var(--s-1) 0;
    border-bottom: 1px solid var(--line);
  }
  .info {
    display: grid;
    min-width: 0;
    flex: 1;
  }
  .name {
    font-weight: 500;
  }
  .meta {
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .mid {
    color: var(--ink-2);
  }
  .fbprov {
    color: var(--ink-3);
    font-size: var(--fs-xs);
    flex: none;
  }
  .uses {
    display: flex;
    gap: 2px;
    flex: none;
  }
  .use {
    background: var(--inset);
    border-radius: 999px;
    padding: 0 var(--s-2);
    color: var(--ink-2);
    font-size: var(--fs-xs);
    line-height: 18px;
    font-family: var(--mono);
  }
  .now {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    color: var(--accent);
    font-size: var(--fs-sm);
    flex: none;
  }
  .empty {
    color: var(--ink-3);
    overflow-wrap: anywhere;
  }
  .more {
    justify-self: start;
  }

  @container (max-width: 520px) {
    .role {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--s-2);
    }
    .who {
      padding-top: 0;
    }
    .bar {
      margin: calc(var(--s-2) * -1) calc(var(--s-4) * -1) 0;
      padding: var(--s-2) var(--s-4);
    }
    .fbname {
      max-width: 9rem;
    }
    .uses {
      display: none;
    }
  }
</style>
