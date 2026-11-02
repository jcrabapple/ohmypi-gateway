<script lang="ts">
  // omp plugins on the gateway host: what is installed, and the one action you
  // actually need from a phone (install or remove a package). Every action runs
  // `omp plugin <verb>` server-side; the target is validated there too.
  import { onMount } from 'svelte';
  import { plugins } from '../../lib/api/endpoints';
  import type { PluginActionResult, PluginEntry } from '../../lib/api/types';
  import { ApiError } from '../../lib/api/client';
  import { Loader } from '../../lib/state/loader.svelte';
  import { Icon, Spinner, confirm, toast } from '../../lib/ui';
  import LoadState from './LoadState.svelte';
  import Section from './Section.svelte';

  const list = new Loader<Awaited<ReturnType<typeof plugins.list>>>();
  const load = () => void list.run(() => plugins.list());

  let target = $state('');
  let busy = $state<string | null>(null);
  let output = $state<PluginActionResult | null>(null);

  onMount(load);

  const installed = $derived(list.data?.installed ?? []);

  function label(p: PluginEntry): string {
    if (typeof p.name === 'string' && p.name) return p.name;
    if (typeof p.id === 'string' && p.id) return p.id;
    if (typeof p.package === 'string' && p.package) return p.package;
    return 'plugin';
  }

  function detail(p: PluginEntry): string {
    const bits: string[] = [];
    if (typeof p.version === 'string') bits.push(`v${p.version}`);
    if (typeof p.description === 'string') bits.push(p.description);
    return bits.join(' · ');
  }

  async function run(action: 'install' | 'uninstall' | 'enable' | 'disable' | 'doctor', name = '') {
    if (busy) return;
    // Claim the page before the dialog opens: a second action fired while the
    // confirm is up would race the CLI.
    busy = action + name;
    if (action === 'uninstall') {
      const ok = await confirm({
        title: `Remove ${name}?`,
        body: 'The plugin is uninstalled from this host. Sessions started afterwards will not load it.',
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!ok) {
        busy = null;
        return;
      }
    }
    output = null;
    try {
      const res = await plugins.action(action, name);
      output = res;
      if (res.ok) toast(action === 'doctor' ? 'Health check finished' : `${action} finished`);
      else toast(res.error ?? 'The action failed', { kind: 'error' });
      load();
      if (action === 'install' && res.ok) target = '';
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'The action failed', { kind: 'error' });
    } finally {
      busy = null;
    }
  }
</script>

<Section id="plugin-list" title="Installed plugins" hint="Read from omp on the gateway host.">
  <LoadState ready={list.data !== null} error={list.error} refreshing={list.refreshing} onretry={load}>
    {#if installed.length}
      <ul class="list">
        {#each installed as p, i (label(p) + i)}
          <li>
            <div class="top">
              <span class="name mono">{label(p)}</span>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                disabled={busy !== null}
                onclick={() => run('uninstall', label(p))}
              >
                Remove
              </button>
            </div>
            {#if detail(p)}<p class="desc">{detail(p)}</p>{/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty">
        No plugins are installed. A plugin adds tools or commands to every session; install one by
        package name below.
      </p>
    {/if}
    {#if list.data?.error}<p class="warn" role="alert">{list.data.error}</p>{/if}
  </LoadState>
</Section>

<Section id="plugin-install" title="Install a plugin" hint="npm package name or a path on the host, as `omp plugin install` takes it.">
  <form
    class="install"
    onsubmit={(e) => {
      e.preventDefault();
      if (target.trim()) void run('install', target.trim());
    }}
  >
    <input class="field" bind:value={target} placeholder="@scope/omp-plugin-name" aria-label="Plugin package" />
    <button type="submit" class="btn btn-sm primary" disabled={busy !== null || !target.trim()}>
      {#if busy === 'install' + target.trim()}<Spinner size={12} label="Installing" />{:else}Install{/if}
    </button>
    <button type="button" class="btn btn-ghost btn-sm" disabled={busy !== null} onclick={() => run('doctor')}>
      {#if busy === 'doctor'}<Spinner size={12} label="Checking" />{:else}Health check{/if}
    </button>
  </form>

  {#if output}
    <div class="out" class:err={!output.ok}>
      <p class="lead">
        <Icon name={output.ok ? 'check' : 'alert'} size={14} />
        {output.action}{output.target ? ` ${output.target}` : ''}
      </p>
      <pre class="mono">{output.output}</pre>
    </div>
  {/if}
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
  .top :global(button) {
    margin-left: auto;
  }
  .desc {
    color: var(--ink-2);
    font-size: var(--fs-sm);
    margin-top: 2px;
    overflow-wrap: anywhere;
  }
  .empty {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .warn {
    color: var(--err);
    font-size: var(--fs-sm);
  }
  .install {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }
  .install .field {
    flex: 1 1 220px;
  }
  .out {
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    padding: var(--s-3);
    background: var(--inset);
  }
  .out.err {
    border-color: var(--err);
  }
  .lead {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--fs-sm);
    font-weight: 600;
  }
  pre {
    margin-top: var(--s-2);
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: var(--fs-xs);
    color: var(--ink-2);
  }
</style>
