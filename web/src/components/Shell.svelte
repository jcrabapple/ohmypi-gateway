<script lang="ts">
  import { onMount } from 'svelte';
  import { runShortcut } from '../lib/actions.svelte';
  import { createKeyMap } from '../lib/keymap';
  import { canNotify, permission, requestPermission } from '../lib/platform/notify';
  import { device } from '../lib/platform/storage';
  import { active, nav, sessionsStore, ui } from '../lib/state';
  import { viewport } from '../lib/ui/media.svelte';
  import { watchEdgeSwipe } from '../lib/ui/swipe';
  import Home from './Home.svelte';
  import Overlays from './Overlays.svelte';
  import Rail from './Rail.svelte';
  import SearchView from './SearchView.svelte';
  import SessionView from './SessionView.svelte';
  import UsageView from './UsageView.svelte';

  const COLLAPSED_KEY = 'railCollapsed';
  const NOTIFY_KEY = 'notifyAsked';

  let drawer: HTMLDivElement | undefined = $state();

  ui.railCollapsed = device.get<unknown>(COLLAPSED_KEY, false) === true;

  const drawerOpen = $derived(viewport.narrow && ui.isOpen('drawer'));
  const needs = $derived(sessionsStore.live.filter((s) => !s.exited && s.pendingUi.length > 0).length);

  onMount(() => {
    sessionsStore.start();
    const stopNav = nav.start();
    const stopSwipe = watchEdgeSwipe({
      isOpen: () => ui.isOpen('drawer'),
      enabled: () => viewport.narrow && (ui.top === null || ui.top === 'drawer'),
      onOpen: () => ui.open('drawer', null),
      onClose: () => ui.close('drawer'),
    });
    return () => {
      stopSwipe();
      stopNav();
      sessionsStore.stop();
      active.close();
    };
  });

  // The URL decides which session is open.
  $effect(() => {
    const id = nav.gwId;
    if (id) void active.open(id);
    else active.close();
  });

  $effect(() => {
    if (active.phase === 'gone' && active.gwId) nav.noteGone(active.gwId, active.info?.cwd ?? null);
  });

  // A wide window has no drawer, so drop the entry rather than leave it on the stack.
  $effect(() => {
    if (!viewport.narrow && ui.isOpen('drawer')) ui.close('drawer');
  });

  $effect(() => {
    device.set(COLLAPSED_KEY, ui.railCollapsed);
  });

  $effect(() => {
    document.title = needs > 0 ? `(${needs}) omp` : 'omp';
  });

  // Ask once, after the list has loaded, so the prompt is not the first thing anyone sees.
  $effect(() => {
    if (!sessionsStore.loaded || !canNotify() || permission() !== 'default') return;
    if (device.get<unknown>(NOTIFY_KEY, false) === true) return;
    device.set(NOTIFY_KEY, true);
    ui.toast('Get a desktop alert when a session needs you', {
      ms: 12000,
      action: { label: 'Enable', run: () => void requestPermission() },
    });
  });

  // Focus moves into the drawer when it opens on touch; closing returns it to the opener.
  $effect(() => {
    if (!drawerOpen) return;
    drawer?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  });

  const keys = createKeyMap({
    run: runShortcut,
    modalOpen: () => !!ui.confirmRequest || ui.overlays.some((o) => o.id !== 'drawer'),
  });

  function onkey(e: KeyboardEvent) {
    keys.handle(e);
  }
</script>

<svelte:window onkeydown={onkey} />

<div class="shell" class:collapsed={!viewport.narrow && ui.railCollapsed}>
  <div
    class="rail"
    class:drawer={viewport.narrow}
    class:open={drawerOpen}
    bind:this={drawer}
    inert={viewport.narrow ? !drawerOpen : ui.railCollapsed}
  >
    <Rail />
  </div>
  {#if viewport.narrow}
    <button
      type="button"
      class="scrim"
      class:open={drawerOpen}
      tabindex="-1"
      aria-hidden="true"
      onclick={() => ui.close('drawer')}
    ></button>
  {/if}
  <main>
    {#if nav.search}
      <SearchView />
    {:else if nav.usage}
      <UsageView />
    {:else if nav.gwId}
      {#key nav.gwId}
        <SessionView gwId={nav.gwId} />
      {/key}
    {:else}
      <Home />
    {/if}
  </main>
</div>

<Overlays />

<style>
  .shell {
    display: grid;
    grid-template-columns: var(--rail-w) minmax(0, 1fr);
    height: 100%;
    background: var(--canvas);
    transition: grid-template-columns var(--dur) var(--ease);
  }
  .shell.collapsed {
    grid-template-columns: 0 minmax(0, 1fr);
  }
  .rail {
    min-width: 0;
    overflow: hidden;
  }
  .shell.collapsed .rail {
    visibility: hidden;
  }
  main {
    min-width: 0;
    min-height: 0;
    height: 100%;
  }

  @media (max-width: 899.98px) {
    .shell,
    .shell.collapsed {
      grid-template-columns: minmax(0, 1fr);
    }
    .rail.drawer {
      position: fixed;
      inset: 0 auto 0 0;
      z-index: 40;
      width: min(var(--rail-w), 86vw);
      transform: translateX(-100%);
      visibility: hidden;
      box-shadow: var(--shadow-pop);
      transition:
        transform var(--dur) var(--ease),
        visibility 0s linear var(--dur);
    }
    .rail.drawer.open {
      transform: none;
      visibility: visible;
      transition: transform var(--dur) var(--ease);
    }
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 39;
      background: var(--scrim);
      opacity: 0;
      pointer-events: none;
      transition: opacity var(--dur) var(--ease);
    }
    .scrim.open {
      opacity: 1;
      pointer-events: auto;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .shell,
    .rail.drawer,
    .scrim {
      transition: none;
    }
  }
</style>
