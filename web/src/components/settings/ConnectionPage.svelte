<script lang="ts">
  import { onMount } from 'svelte';
  import { auth as authApi, host } from '../../lib/api/endpoints';
  import { uptime } from '../../lib/format';
  import { disablePush, enablePush, pushStatus } from '../../lib/push/push';
  import { auth } from '../../lib/state';
  import { Loader } from '../../lib/state/loader.svelte';
  import { confirm } from '../../lib/ui';
  import LoadState from './LoadState.svelte';
  import Section from './Section.svelte';

  const system = new Loader<Awaited<ReturnType<typeof host.system>>>();
  const me = new Loader<Awaited<ReturnType<typeof authApi.me>>>();
  const load = () => {
    void system.run(() => host.system());
    void me.run(() => authApi.me());
  };
  onMount(load);

  async function signOut() {
    const ok = await confirm({
      title: 'Sign out',
      body: 'Live sessions keep running on the gateway.',
      confirmLabel: 'Sign out',
    });
    if (ok) await auth.logout();
  }

  // --- push notifications -------------------------------------------------
  let push = $state<{ state: 'checking' | 'on' | 'off' | 'unsupported' | 'blocked'; reason?: string; error?: string }>({
    state: 'checking',
  });

  async function refreshPush(): Promise<void> {
    try {
      push = await pushStatus();
    } catch {
      push = { state: 'unsupported', reason: 'Push status is unavailable.' };
    }
  }
  onMount(refreshPush);

  async function turnOn(): Promise<void> {
    push = { state: push.state, error: undefined };
    try {
      await enablePush();
      await refreshPush();
    } catch (e) {
      push = { state: 'off', error: e instanceof Error ? e.message : 'Could not subscribe.' };
    }
  }

  async function turnOff(): Promise<void> {
    await disablePush();
    await refreshPush();
  }

  const rows = $derived.by(() => {
    const s = system.data;
    if (!s) return [];
    return [
      ['Gateway', s.gateway.version],
      ['Gateway uptime', uptime(s.gateway.uptimeSec)],
      ['omp', s.omp.version],
      ['Live sessions', `${s.liveSessions} of ${s.gateway.maxSessions}`],
      ['Idle sessions stop after', uptime(s.gateway.idleReapSec)],
      ['Signed in with', me.data ? (me.data.method === 'bearer' ? 'Access token' : 'Browser cookie') : ''],
      ['Config file', s.omp.configFile],
    ].filter(([, v]) => v);
  });
</script>

<Section id="versions" title="Gateway and omp" hint="The host this page talks to.">
  <LoadState ready={system.data !== null} error={system.error} refreshing={system.refreshing} onretry={load}>
    <dl class="grid">
      {#each rows as [k, v] (k)}
        <dt>{k}</dt>
        <dd class:mono={k === 'Config file' || k === 'omp' || k === 'Gateway'}>{v}</dd>
      {/each}
    </dl>
  </LoadState>
</Section>

<Section id="sign-out" title="Sign out" hint="Clears this browser's cookie. Sessions on the gateway are not stopped.">
  <div>
    <button type="button" class="btn btn-danger" onclick={signOut}>Sign out</button>
  </div>
</Section>

<Section
  id="push"
  title="Push notifications"
  hint="Get notified when a session needs an answer and nobody is watching it. iOS needs the installed app."
>
  {#if push.state === 'checking'}
    <p class="push-note">Checking this device...</p>
  {:else if push.state === 'unsupported'}
    <p class="push-note">{push.reason}</p>
  {:else if push.state === 'blocked'}
    <p class="push-note">Notifications are blocked for this site. Allow them in the browser's site settings.</p>
  {:else if push.state === 'on'}
    <p class="push-note">This device is subscribed.</p>
    <button type="button" class="btn" onclick={turnOff}>Turn off</button>
  {:else}
    <p class="push-note">Off.</p>
    {#if push.error}<p class="push-note push-error" role="alert">{push.error}</p>{/if}
    <button type="button" class="btn" onclick={turnOn}>Turn on</button>
  {/if}
</Section>

<style>
  .grid {
    display: grid;
    grid-template-columns: minmax(0, max-content) minmax(0, 1fr);
    gap: var(--s-2) var(--s-5);
    margin: 0;
  }
  dt {
    color: var(--ink-3);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .push-note {
    margin: 0 0 var(--s-3);
    color: var(--ink-3);
  }
  .push-error {
    color: var(--ansi-1, #f87171);
  }
  @media (max-width: 480px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
      gap: 0;
    }
    dd {
      margin-bottom: var(--s-3);
    }
  }
</style>
