<script lang="ts">
  import { onMount } from 'svelte';
  import { host } from '../../lib/api/endpoints';
  import { ansiToHtml } from '../../lib/render/ansi';
  import { Loader } from '../../lib/state/loader.svelte';
  import { Icon } from '../../lib/ui';
  import LoadState from './LoadState.svelte';
  import Section from './Section.svelte';

  const usage = new Loader<Awaited<ReturnType<typeof host.usage>>>();
  const load = () => void usage.run(() => host.usage());
  onMount(load);

  const html = $derived(usage.data?.raw ? ansiToHtml(usage.data.raw) : '');
</script>

<Section id="usage-report" title="Usage report" hint="What each provider reports for your accounts. Fetching it can take a few seconds.">
  {#snippet actions()}
    <button type="button" class="btn btn-sm" disabled={usage.loading} onclick={load}>
      <Icon name="clock" size={14} /> Refresh
    </button>
  {/snippet}
  <LoadState ready={usage.data !== null} error={usage.error} refreshing={usage.refreshing} rows={6} onretry={load}>
    {#if usage.data?.error}
      <p class="note" role="alert">{usage.data.error}</p>
    {/if}
    {#if html}
      <!-- ansiToHtml escapes all text; only its own span tags remain -->
      <pre class="report mono">{@html html}</pre>
    {:else if !usage.data?.error}
      <p class="note">The gateway returned no usage data.</p>
    {/if}
  </LoadState>
</Section>

<style>
  .report {
    margin: 0;
    padding: var(--s-3) var(--s-4);
    border-radius: var(--r-md);
    background: var(--inset);
    font-size: var(--fs-sm);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 60vh;
    overflow: auto;
  }
  .note {
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
</style>
