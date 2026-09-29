<script lang="ts">
  import { onMount } from 'svelte';
  import { configDraft as draft } from '../../lib/state/config-draft.svelte';
  import { Spinner } from '../../lib/ui';
  import LoadState from './LoadState.svelte';
  import Section from './Section.svelte';

  const load = () => void draft.load();
  onMount(load);

  const uid = $props.id();

  function key(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void draft.save();
    }
  }
</script>

<Section
  id="config"
  title="Agent config file"
  hint="This is the omp config on the gateway host. The gateway checks it before it writes."
>
  <LoadState ready={draft.saved !== null} error={draft.loadError} refreshing={draft.loading} rows={8} onretry={load}>
    {#if draft.file}<p class="file mono">{draft.file}</p>{/if}
    {#if draft.parseError}
      <p class="msg warn" role="status">The file on disk does not parse: {draft.parseError}</p>
    {/if}

    <label class="sr-only" for="{uid}-yaml">Config YAML</label>
    <textarea
      id="{uid}-yaml"
      class="field yaml mono"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      wrap="off"
      rows="18"
      bind:value={draft.text}
      onkeydown={key}
      aria-describedby="{uid}-msg"
      aria-invalid={draft.saveError ? true : undefined}
    ></textarea>

    <div class="bar">
      <div id="{uid}-msg" class="status">
        {#if draft.saveError}
          <p class="msg bad" role="alert">{draft.saveError}</p>
        {:else if draft.dirty}
          <p class="msg" aria-live="polite">Unsaved changes</p>
        {:else if draft.savedNote}
          <p class="msg ok" aria-live="polite">{draft.savedNote}</p>
        {/if}
      </div>
      <button type="button" class="btn btn-ghost" disabled={!draft.dirty || draft.saving} onclick={() => draft.revert()}>
        Revert
      </button>
      <button type="button" class="btn btn-primary" disabled={!draft.dirty || draft.saving} onclick={() => draft.save()}>
        {#if draft.saving}<Spinner size={13} label="Saving" />{/if}
        Save
      </button>
    </div>
  </LoadState>
</Section>

<style>
  .file {
    color: var(--ink-3);
    font-size: var(--fs-sm);
    overflow-wrap: anywhere;
  }
  .yaml {
    display: block;
    width: 100%;
    min-height: 260px;
    padding: var(--s-3);
    font-size: var(--fs-sm);
    line-height: 1.5;
    resize: vertical;
    tab-size: 2;
    white-space: pre;
    overflow: auto;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
  }
  .status {
    flex: 1 1 200px;
    min-width: 0;
  }
  .msg {
    color: var(--ink-2);
    font-size: var(--fs-sm);
    overflow-wrap: anywhere;
  }
  .msg.bad {
    color: var(--err);
    padding: var(--s-2) var(--s-3);
    border-radius: var(--r-md);
    background: var(--err-soft);
  }
  .msg.ok {
    color: var(--ok);
  }
  .msg.warn {
    color: var(--warn);
  }
</style>
