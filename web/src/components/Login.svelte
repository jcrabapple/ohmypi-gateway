<script lang="ts">
  import { onDestroy } from 'svelte';
  import Icon from '../lib/ui/Icon.svelte';
  import Spinner from '../lib/ui/Spinner.svelte';
  import { auth } from '../lib/state';

  let token = $state('');
  let left = $state(0);
  let timer: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    left = auth.lockedSec ?? 0;
    if (timer) clearInterval(timer);
    timer = null;
    if (left > 0) {
      timer = setInterval(() => {
        left = Math.max(0, left - 1);
        if (left === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      }, 1000);
    }
  });
  onDestroy(() => timer && clearInterval(timer));

  const minutes = $derived(Math.max(1, Math.ceil(left / 60)));
  const locked = $derived(left > 0);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!token.trim() || locked) return;
    if (await auth.login(token)) token = '';
  }
</script>

<div class="wrap">
  <form class="card" onsubmit={submit}>
    <div class="brand">
      <Icon name="mark" size={28} />
      <h1>omp</h1>
    </div>
    <label for="token">Access token</label>
    <input
      id="token"
      class="field"
      type="password"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      aria-describedby="login-status"
      aria-invalid={auth.error ? 'true' : undefined}
      bind:value={token}
    />
    <button type="submit" class="btn btn-primary" disabled={auth.busy || locked || !token.trim()}>
      {#if auth.busy}<Spinner label="Signing in" />{/if}
      Sign in
    </button>
    <p id="login-status" class="status" role="alert">
      {#if locked}
        Too many attempts. Try again in {minutes} {minutes === 1 ? 'minute' : 'minutes'}.
      {:else if auth.error}
        {auth.error}
      {/if}
    </p>
  </form>
</div>

<style>
  .wrap {
    display: grid;
    place-items: center;
    height: 100%;
    padding: var(--s-4) var(--s-4) calc(var(--s-4) + max(var(--kb), var(--safe-b)));
    overflow: auto;
  }
  .card {
    width: min(380px, 100%);
    display: grid;
    gap: var(--s-3);
    padding: var(--s-6) var(--s-5) var(--s-5);
    background: var(--surface);
    border-radius: var(--r-lg);
    box-shadow: var(--ring);
    animation: enter var(--dur-slow) var(--ease);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    color: var(--accent);
    margin-bottom: var(--s-3);
  }
  h1 {
    font-size: var(--fs-xl);
    font-weight: 600;
    color: var(--ink);
    letter-spacing: -0.01em;
  }
  label {
    color: var(--ink-2);
    font-size: var(--fs-sm);
  }
  .btn {
    margin-top: var(--s-2);
    min-height: max(var(--hit), 40px);
  }
  .status {
    min-height: 3em;
    color: var(--err);
    font-size: var(--fs-sm);
  }
  @keyframes enter {
    from { opacity: 0; transform: translateY(6px); }
  }
</style>
