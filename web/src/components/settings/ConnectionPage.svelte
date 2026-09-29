<script lang="ts">
  import { onMount } from 'svelte';
  import { auth as authApi, host } from '../../lib/api/endpoints';
  import { uptime } from '../../lib/format';
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
