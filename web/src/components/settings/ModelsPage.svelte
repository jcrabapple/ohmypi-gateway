<script lang="ts">
  import { onMount } from 'svelte';
  import type { CatalogModel } from '../../lib/api/types';
  import { compactNumber, priceLabel } from '../../lib/format';
  import { active, modelCatalog } from '../../lib/state';
  import { groupModels } from '../../lib/state/models.svelte';
  import { Icon, toast } from '../../lib/ui';
  import LoadState from './LoadState.svelte';
  import Section from './Section.svelte';

  let query = $state('');
  let busy = $state<string | null>(null);
  const uid = $props.id();

  onMount(() => modelCatalog.ensure());

  const groups = $derived(groupModels(modelCatalog.models, query));
  const count = $derived(groups.reduce((n, g) => n + g.models.length, 0));
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

<Section id="catalog" title="Model catalog" hint={open ? 'Switch the open session to any model below.' : 'Open a session to switch its model from here.'}>
  <label class="sr-only" for="{uid}-q">Search models</label>
  <input id="{uid}-q" class="field" type="search" placeholder="Search by name, provider or id" autocomplete="off" spellcheck="false" bind:value={query} />

  <LoadState ready={modelCatalog.ready} error={modelCatalog.error} refreshing={modelCatalog.refreshing} rows={6} onretry={() => modelCatalog.retry()}>
    <p class="sr-only" role="status">{count} {count === 1 ? 'model' : 'models'}</p>
    {#each groups as g (g.provider)}
      <div class="group">
        <h4 class="eyebrow">{g.provider}</h4>
        <ul>
          {#each g.models as m (m.selector)}
            <li>
              <div class="info">
                <span class="name truncate">{m.name}</span>
                <span class="meta">
                  {compactNumber(m.contextWindow)} context · {priceLabel(m.cost)}{m.reasoning ? ' · reasoning' : ''}
                </span>
              </div>
              {#if isCurrent(m)}
                <span class="now"><Icon name="check" size={14} /> In use</span>
              {:else if open}
                <button type="button" class="btn btn-sm" disabled={busy !== null} onclick={() => use(m)} aria-label="Use {m.name} in this session">
                  Use in this session
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {:else}
      <p class="empty">No models match "{query.trim()}"</p>
    {/each}
  </LoadState>
</Section>

<style>
  .group ul {
    list-style: none;
    margin: var(--s-1) 0 var(--s-3);
    padding: 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    min-height: 48px;
    padding: var(--s-1) var(--s-1);
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
    font-size: var(--fs-sm);
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
</style>
