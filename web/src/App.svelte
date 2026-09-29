<script lang="ts">
  import { onMount } from 'svelte';
  import Login from './components/Login.svelte';
  import Shell from './components/Shell.svelte';
  import { watchKeyboard } from './lib/platform/keyboard';
  import { auth, settings } from './lib/state';
  import { ConfirmDialog, Spinner, Toasts } from './lib/ui';

  onMount(() => {
    settings.apply();
    const stopTheme = settings.watchSystem();
    const stopKeyboard = watchKeyboard();
    void auth.check();
    return () => {
      stopTheme();
      stopKeyboard();
    };
  });
</script>

{#if auth.status === 'signed-in'}
  <Shell />
{:else if auth.status === 'signed-out'}
  <Login />
  <ConfirmDialog />
  <Toasts />
{:else}
  <div class="boot" aria-live="polite">
    {#if auth.error}
      <p class="msg">{auth.error}</p>
      <button type="button" class="btn" onclick={() => auth.check()}>Try again</button>
    {:else}
      <Spinner size={18} label="Connecting" />
    {/if}
  </div>
{/if}

<style>
  .boot {
    display: grid;
    place-content: center;
    justify-items: center;
    gap: var(--s-3);
    height: 100%;
    background: var(--canvas);
    color: var(--ink-3);
  }
  .msg {
    color: var(--ink-2);
  }
</style>
