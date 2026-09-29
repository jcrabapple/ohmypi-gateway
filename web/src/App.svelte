<script lang="ts">
  // Placeholder shell for Task B: login, then a plain list of live sessions.
  // Task C replaces this file with the real layout.
  import { onMount } from 'svelte';
  import { watchKeyboard } from './lib/platform/keyboard';
  import { auth, sessionsStore, settings, ui } from './lib/state';

  let token = $state('');

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

  $effect(() => {
    if (auth.status !== 'signed-in') return;
    sessionsStore.start();
    return () => sessionsStore.stop();
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && ui.escape()) e.preventDefault();
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    if (await auth.login(token)) token = '';
  }
</script>

<svelte:window onkeydown={onKey} />

<main>
  {#if auth.status === 'unknown'}
    <p class="center" aria-live="polite" aria-busy="true"><span class="spinner" aria-hidden="true"></span></p>
  {:else if auth.status === 'signed-out'}
    <form class="card" onsubmit={submit}>
      <h1>omp</h1>
      <label for="token">Access token</label>
      <input
        id="token"
        type="password"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        bind:value={token}
      />
      <button type="submit" class="primary hit" disabled={auth.busy || !token.trim()}>Sign in</button>
      <p class="error" role="alert">{auth.error ?? ''}</p>
    </form>
  {:else}
    <section class="list">
      <header>
        <h1>Sessions</h1>
        <button type="button" class="hit" onclick={() => auth.logout()}>Sign out</button>
      </header>
      {#if !sessionsStore.loaded}
        <div class="skeleton" style="height: 3rem"></div>
      {:else if sessionsStore.live.length === 0}
        <p class="muted">No live sessions.</p>
      {:else}
        <ul>
          {#each sessionsStore.live as s (s.gwId)}
            <li>
              <span class="mono">{s.cwd}</span>
              <span class="muted">{s.model?.id ?? 'no model'}</span>
              <span class="muted">
                {s.exited ? 'exited' : s.pendingUi.length ? 'needs you' : s.isStreaming ? 'running' : 'idle'}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
      {#if sessionsStore.error}
        <p class="error" role="status">{sessionsStore.error}</p>
      {/if}
    </section>
  {/if}
</main>

<style>
  main {
    height: 100%;
    overflow: auto;
    padding: var(--s-5) var(--s-4) calc(var(--s-5) + var(--kb) + var(--safe-b));
    background: var(--canvas);
  }
  .center {
    display: grid;
    place-items: center;
    height: 100%;
    color: var(--ink-3);
  }
  .card,
  .list {
    max-width: 420px;
    margin: 10vh auto 0;
    display: grid;
    gap: var(--s-3);
  }
  .list {
    max-width: var(--reading-w);
    margin-top: var(--s-5);
  }
  .card {
    padding: var(--s-5);
    background: var(--surface);
    border-radius: var(--r-lg);
    box-shadow: var(--ring);
  }
  h1 {
    font-size: var(--fs-xl);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  label {
    color: var(--ink-2);
    font-size: var(--fs-sm);
  }
  input {
    min-height: var(--hit);
    padding: 0 var(--s-3);
    background: var(--field);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-md);
  }
  input:focus-visible {
    outline-offset: 0;
    border-color: var(--accent);
  }
  .primary {
    background: var(--accent);
    color: var(--accent-ink);
    border-radius: var(--r-md);
    font-weight: 600;
  }
  header button {
    color: var(--ink-2);
    padding: 0 var(--s-3);
    border-radius: var(--r-md);
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: var(--s-2);
  }
  li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2) var(--s-4);
    padding: var(--s-3);
    background: var(--surface);
    border-radius: var(--r-md);
    box-shadow: var(--ring);
  }
  .mono {
    font-family: var(--mono);
    overflow-wrap: anywhere;
  }
  .muted {
    color: var(--ink-3);
  }
  .error {
    color: var(--err);
    min-height: 1.5em;
    font-size: var(--fs-sm);
  }
</style>
