<script lang="ts">
  import { onMount } from 'svelte';
  import { host } from '../../lib/api/endpoints';
  import { Loader } from '../../lib/state/loader.svelte';
  import { Icon } from '../../lib/ui';
  import LoadState from './LoadState.svelte';
  import Section from './Section.svelte';

  const skills = new Loader<Awaited<ReturnType<typeof host.skills>>>();
  const load = () => void skills.run(() => host.skills());
  onMount(load);

  const list = $derived([...(skills.data?.installed ?? [])].sort((a, b) => a.name.localeCompare(b.name)));
</script>

<Section id="skill-list" title="Installed skills" hint="Read from the gateway host. Call one with a slash command in a session.">
  <LoadState ready={skills.data !== null} error={skills.error} refreshing={skills.refreshing} onretry={load}>
    {#if list.length}
      <ul class="list">
        {#each list as s (s.name)}
          <li>
            <div class="top">
              <span class="name mono">{s.name}</span>
              {#if s.symlink}<span class="tag"><Icon name="file" size={12} /> linked</span>{/if}
            </div>
            <p class="desc">{s.description || 'No description'}</p>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty">No skills are installed on the gateway host.</p>
    {/if}
  </LoadState>
</Section>

<style>
  .list {
    display: grid;
    gap: var(--s-1);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    padding: var(--s-2) var(--s-3);
    border-radius: var(--r-md);
    background: var(--inset);
  }
  .top {
    display: flex;
    align-items: center;
    gap: var(--s-2);
  }
  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .desc {
    color: var(--ink-2);
    font-size: var(--fs-sm);
    margin-top: 2px;
    overflow-wrap: anywhere;
  }
  .empty {
    color: var(--ink-3);
  }
</style>
