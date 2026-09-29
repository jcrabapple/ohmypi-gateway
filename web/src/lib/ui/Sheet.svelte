<script lang="ts">
  // Modal surface on the native <dialog>: centered on desktop, a bottom sheet with a
  // drag handle below 900 px. Focus trapping, inertness and focus return come from
  // showModal()/close(); Escape is routed to `onclose` so state stays in sync.
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import { viewport } from './media.svelte';

  type Props = {
    open: boolean;
    onclose: () => void;
    title?: string;
    /** Accessible name when there is no visible title. */
    label?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    /** The body lays itself out (no padding, no scroll), e.g. a search field over a list. */
    flush?: boolean;
    /** Below 900 px the sheet fills the screen height instead of sizing to its content. */
    fillNarrow?: boolean;
    /** On wide screens the dialog keeps one height instead of growing and shrinking. */
    fixedHeight?: boolean;
    /** Wide screens: `top` sits in the upper third, like a palette. */
    place?: 'center' | 'top';
    /** Hide the header (the body supplies its own, e.g. a search field). */
    bare?: boolean;
    children: Snippet;
    footer?: Snippet;
  };

  let {
    open, onclose, title, label, size = 'md', bare = false, flush = false, fillNarrow = false,
    fixedHeight = false, place = 'center', children, footer,
  }: Props = $props();

  let dlg: HTMLDialogElement | undefined = $state();
  let dragY = $state(0);
  let dragging = $state(false);
  let dragStart = 0;
  let dragT = 0;
  const uid = $props.id();

  $effect(() => {
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    else if (!open && dlg.open) dlg.close();
  });

  function cancel(e: Event) {
    e.preventDefault();
    onclose();
  }

  function backdrop(e: MouseEvent) {
    if (e.target === dlg) onclose();
  }

  function down(e: PointerEvent) {
    if (!viewport.narrow || !e.isPrimary) return;
    if ((e.target as Element).closest('button')) return;
    dragging = true;
    dragStart = e.clientY;
    dragT = e.timeStamp;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (dragging) dragY = Math.max(0, e.clientY - dragStart);
  }
  function up(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const speed = dragY / Math.max(1, e.timeStamp - dragT);
    const close = dragY > 96 || (dragY > 32 && speed > 0.5);
    dragY = 0;
    if (close) onclose();
  }
</script>

<dialog
  bind:this={dlg}
  class="sheet {size}"
  class:fill={fillNarrow}
  class:fixed={fixedHeight}
  class:top={place === 'top'}
  aria-labelledby={title && !bare ? `${uid}-t` : undefined}
  aria-label={title && !bare ? undefined : label}
  oncancel={cancel}
  onclick={backdrop}
>
  {#if open}
    <div
      class="panel"
      class:dragging
      style:transform={dragY ? `translateY(${dragY}px)` : undefined}
    >
      {#if !bare}
        <div
          class="grab"
          role="presentation"
          onpointerdown={down}
          onpointermove={move}
          onpointerup={up}
          onpointercancel={up}
        >
          <span class="handle" aria-hidden="true"></span>
          <div class="head">
            <h2 id="{uid}-t">{title}</h2>
            <button type="button" class="icon-btn" aria-label="Close" onclick={onclose}><Icon name="x" /></button>
          </div>
        </div>
      {:else if viewport.narrow}
        <div class="grab" role="presentation" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}>
          <span class="handle" aria-hidden="true"></span>
        </div>
      {/if}
      <div class="body scroll-y" class:flush>{@render children()}</div>
      {#if footer}<div class="foot">{@render footer()}</div>{/if}
    </div>
  {/if}
</dialog>

<style>
  dialog {
    padding: 0;
    border: 0;
    background: var(--surface);
    color: var(--ink);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-pop);
    margin: auto;
    width: min(var(--w, 560px), calc(100vw - 32px));
    max-height: min(720px, calc(100dvh - 64px));
    overflow: hidden;
  }
  dialog.sm { --w: 400px; }
  dialog.md { --w: 560px; }
  dialog.lg { --w: 720px; }
  dialog.xl { --w: 900px; }
  dialog.fixed { height: min(660px, calc(100dvh - 64px)); }
  dialog.top { margin-top: min(12vh, 110px); }
  dialog[open] {
    display: flex;
    animation: pop-in var(--dur) var(--ease);
  }
  dialog::backdrop {
    background: var(--scrim);
    animation: fade-in var(--dur) var(--ease);
  }
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    width: 100%;
    max-height: inherit;
    transition: transform var(--dur) var(--ease);
  }
  .panel.dragging {
    transition: none;
  }
  .grab {
    touch-action: none;
    flex: none;
  }
  .handle {
    display: none;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    padding: var(--s-3) var(--s-3) var(--s-3) var(--s-5);
    border-bottom: 1px solid var(--line);
  }
  h2 {
    font-size: var(--fs-lg);
    font-weight: 600;
    min-width: 0;
  }
  .body {
    padding: var(--s-4) var(--s-5) var(--s-5);
    min-height: 0;
    flex: 1 1 auto;
  }
  .body.flush {
    display: flex;
    flex-direction: column;
    padding: 0;
    overflow: hidden;
  }
  .foot {
    flex: none;
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-5) var(--s-4);
    border-top: 1px solid var(--line);
  }

  @media (max-width: 899.98px) {
    dialog {
      margin: auto 0 0;
      width: 100%;
      max-width: none;
      border-radius: var(--r-lg) var(--r-lg) 0 0;
      max-height: calc(100dvh - var(--kb) - var(--safe-t) - var(--s-4));
    }
    dialog.top {
      margin-top: auto;
    }
    dialog.fixed:not(.fill) {
      height: auto;
    }
    dialog.fill {
      height: calc(100dvh - var(--kb) - var(--safe-t) - var(--s-4));
    }
    dialog[open] {
      animation: slide-up var(--dur-slow) var(--ease);
    }
    .handle {
      display: block;
      width: 36px;
      height: 4px;
      margin: var(--s-2) auto 0;
      border-radius: 999px;
      background: var(--line-strong);
    }
    .head {
      padding: var(--s-1) var(--s-2) var(--s-2) var(--s-4);
    }
    .body {
      padding: var(--s-3) var(--s-4) var(--s-4);
    }
    .body.flush {
      padding: 0;
    }
    .foot {
      padding: var(--s-3) var(--s-4) calc(var(--s-3) + var(--safe-b));
    }
  }

  @keyframes pop-in {
    from { opacity: 0; transform: translateY(6px) scale(0.985); }
  }
  @keyframes slide-up {
    from { transform: translateY(100%); }
  }
  @keyframes fade-in {
    from { opacity: 0; }
  }
</style>
