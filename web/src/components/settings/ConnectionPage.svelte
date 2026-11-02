<script lang="ts">
  import { onMount } from 'svelte';
  import { auth as authApi, host } from '../../lib/api/endpoints';
  import { uptime } from '../../lib/format';
  import {
    disablePush,
    enablePush,
    loadPushPrefs,
    pushStatus,
    savePushPrefs,
    type PushPrefs,
  } from '../../lib/push/push';
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
let push = $state<{
  state: 'checking' | 'on' | 'off' | 'unsupported' | 'blocked';
  reason?: string;
  error?: string;
  busy?: boolean;
}>({ state: 'checking' });

async function refreshPush(): Promise<void> {
  try {
    push = await pushStatus();
  } catch {
    push = { state: 'unsupported', reason: 'Push status is unavailable.' };
  }
  await refreshPrefs();
}
onMount(refreshPush);

// What pushes, once this device is subscribed. The gateway decides whether to
// send, so the choice applies to every subscribed device.
const PUSH_PREF_ROWS = [
  {
    kind: 'completion' as const,
    label: 'When a turn finishes',
    hint: 'A turn ends while nobody is watching that session.',
  },
  {
    kind: 'error' as const,
    label: 'When a turn fails',
    hint: 'omp reports an error instead of a normal end.',
  },
  {
    kind: 'ask' as const,
    label: 'When a session needs an answer',
    hint: 'A tool approval or a question is blocking a turn.',
  },
];

let prefs = $state<PushPrefs | null>(null);
let prefsError = $state<string | null>(null);
let prefsBusy = $state(false);

async function refreshPrefs(): Promise<void> {
  try {
    prefs = await loadPushPrefs();
    prefsError = null;
  } catch (e) {
    prefsError = e instanceof Error ? e.message : 'Could not load notification settings.';
  }
}

async function setPref(kind: keyof PushPrefs, value: boolean): Promise<void> {
  if (prefsBusy) return;
  prefsBusy = true;
  try {
    prefs = await savePushPrefs({ [kind]: value } as Partial<PushPrefs>);
    prefsError = null;
  } catch (e) {
    prefsError = e instanceof Error ? e.message : 'Could not save notification settings.';
    await refreshPrefs();
  } finally {
    prefsBusy = false;
  }
}

async function turnOn(): Promise<void> {
  if (push.busy) return;
  push = { state: push.state, reason: push.reason, busy: true };
  try {
    await enablePush();
    await refreshPush();
  } catch (e) {
    push = { state: 'off', error: e instanceof Error ? e.message : 'Could not subscribe.' };
  }
}

async function turnOff(): Promise<void> {
  if (push.busy) return;
  push = { ...push, busy: true };
  try {
    await disablePush();
  } finally {
    await refreshPush();
  }
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
  hint="Get notified when a session needs an answer or a turn ends while nobody is watching it. iOS needs the installed app."
>
  {#if push.state === 'checking'}
    <p class="push-note">Checking this device...</p>
  {:else if push.state === 'unsupported'}
    <p class="push-note">{push.reason}</p>
  {:else if push.state === 'blocked'}
    <p class="push-note">Notifications are blocked for this site. Allow them in the browser's site settings.</p>
  {:else if push.state === 'on'}
    <p class="push-note">This device is subscribed.</p>
    <button type="button" class="btn" disabled={push.busy} onclick={turnOff}>{push.busy ? 'Working...' : 'Turn off'}</button>
  {:else}
    <p class="push-note">Off.</p>
    {#if push.error}<p class="push-note push-error" role="alert">{push.error}</p>{/if}
    <button type="button" class="btn" disabled={push.busy} onclick={turnOn}>{push.busy ? 'Working...' : 'Turn on'}</button>
  {/if}
  {#if push.state === 'on' || push.state === 'off'}
    <fieldset class="prefs">
      <legend>What pushes, once this device is subscribed</legend>
      {#each PUSH_PREF_ROWS as row (row.kind)}
        <label class="pref">
          <input
            type="checkbox"
            checked={prefs ? prefs[row.kind] : false}
            disabled={prefs === null || prefsBusy}
            onchange={(e) => void setPref(row.kind, e.currentTarget.checked)}
          />
          <span class="pref-label">{row.label}</span>
          <span class="pref-hint">{row.hint}</span>
        </label>
      {/each}
    </fieldset>
    {#if prefsError}<p class="push-note push-error" role="alert">{prefsError}</p>{/if}
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
  .prefs {
    display: grid;
    gap: var(--s-3);
    margin: 0 0 var(--s-4);
    padding: 0;
    border: 0;
  }
  .prefs legend {
    padding: 0;
    margin-bottom: var(--s-2);
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .pref {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    column-gap: var(--s-3);
    align-items: baseline;
    cursor: pointer;
  }
  .pref input {
    margin: 0;
  }
  .pref-hint {
    grid-column: 2;
    color: var(--ink-3);
    font-size: var(--fs-sm);
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
