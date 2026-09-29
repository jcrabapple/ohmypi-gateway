<script lang="ts">
  // Anchored floating panel (desktop). Opens above or below the anchor depending on
  // room, closes on outside press or Escape, and returns focus to the anchor.
  import { tick, type Snippet } from 'svelte';

  type Props = {
    open: boolean;
    onclose: () => void;
    anchor: HTMLElement | null;
    label: string;
    align?: 'start' | 'end';
    width?: number;
    children: Snippet;
  };

  let { open, onclose, anchor, label, align = 'start', width = 320, children }: Props = $props();

  let panel: HTMLDivElement | undefined = $state();
  let pos = $state<{ left: number; top?: number; bottom?: number; maxH: number } | null>(null);

  const GAP = 6;
  const MARGIN = 12;

  function place() {
    if (!anchor || !panel) return;
    const a = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const w = Math.min(width, vw - MARGIN * 2);
    let left = align === 'end' ? a.right - w : a.left;
    left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
    const below = vh - a.bottom - GAP - MARGIN;
    const above = a.top - GAP - MARGIN;
    const want = Math.min(panel.scrollHeight, 420);
    if (below >= want || below >= above) pos = { left, top: a.bottom + GAP, maxH: Math.max(160, below) };
    else pos = { left, bottom: vh - a.top + GAP, maxH: Math.max(160, above) };
  }

  $effect(() => {
    if (!open) {
      pos = null;
      return;
    }
    void tick().then(() => {
      place();
      const first = panel?.querySelector<HTMLElement>('[autofocus], [role^="menuitem"], input, button');
      (first ?? panel)?.focus({ preventScroll: true });
    });
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel?.contains(t) || anchor?.contains(t)) return;
      onclose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onclose();
      anchor?.focus();
    };
    const onResize = () => place();
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  });
</script>

{#if open}
  <div
    bind:this={panel}
    class="pop"
    role="dialog"
    aria-label={label}
    tabindex="-1"
    style:width="{width}px"
    style:left="{pos?.left ?? 0}px"
    style:top={pos?.top !== undefined ? `${pos.top}px` : undefined}
    style:bottom={pos?.bottom !== undefined ? `${pos.bottom}px` : undefined}
    style:max-height="{pos?.maxH ?? 420}px"
    style:visibility={pos ? 'visible' : 'hidden'}
  >
    {@render children()}
  </div>
{/if}

<style>
  .pop {
    position: fixed;
    z-index: 60;
    max-width: calc(100vw - 24px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--surface);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-pop);
    animation: pop var(--dur-fast) var(--ease);
  }
  .pop:focus {
    outline: none;
  }
  @keyframes pop {
    from { opacity: 0; transform: translateY(3px); }
  }
</style>
