<script lang="ts">
  import { keyLabels } from '../lib/keymap';
  import { ui } from '../lib/state';
  import { Icon, Kbd } from '../lib/ui';
  import { viewport } from '../lib/ui/media.svelte';

  function openDrawer(e: MouseEvent) {
    ui.open('drawer', e.currentTarget as HTMLElement);
  }
</script>

<div class="home">
  {#if viewport.narrow}
    <button type="button" class="icon-btn menu" aria-label="Sessions" onclick={openDrawer}>
      <Icon name="menu" />
    </button>
  {/if}
  <div class="body">
    <Icon name="mark" size={32} />
    <p class="lead">Pick a session or start a new one</p>
    <button type="button" class="btn btn-primary" onclick={() => ui.open('new-session')}>
      <Icon name="plus" size={16} /> New session
    </button>
    {#if !viewport.coarse}
      <p class="hint">
        <span class="keys">{#each keyLabels('mod+shift+o') as k (k)}<Kbd>{k}</Kbd>{/each}</span> new session
        <span class="keys">{#each keyLabels('mod+k') as k (k)}<Kbd>{k}</Kbd>{/each}</span> search
      </p>
    {/if}
  </div>
</div>

<style>
  .home {
    position: relative;
    display: grid;
    place-items: center;
    height: 100%;
    background: var(--canvas);
    color: var(--ink-3);
  }
  .menu {
    position: absolute;
    top: max(var(--safe-t), var(--s-2));
    left: var(--s-2);
  }
  .body {
    display: grid;
    justify-items: center;
    gap: var(--s-3);
    padding: var(--s-5);
    text-align: center;
  }
  .lead {
    color: var(--ink-2);
  }
  .hint {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: var(--s-2) var(--s-4);
    font-size: var(--fs-sm);
  }
  .keys {
    display: inline-flex;
    gap: var(--s-1);
  }
</style>
