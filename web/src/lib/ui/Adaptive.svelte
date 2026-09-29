<script lang="ts">
  // One surface for pickers and menus: a popover on desktop, a bottom sheet below 900 px.
  import type { Snippet } from 'svelte';
  import Popover from './Popover.svelte';
  import Sheet from './Sheet.svelte';
  import { viewport } from './media.svelte';

  type Props = {
    open: boolean;
    onclose: () => void;
    anchor?: HTMLElement | null;
    title: string;
    /** `always` forces the sheet (long-press action sheets have no anchor). */
    mode?: 'auto' | 'sheet';
    width?: number;
    align?: 'start' | 'end';
    size?: 'sm' | 'md' | 'lg';
    children: Snippet;
  };

  let { open, onclose, anchor = null, title, mode = 'auto', width = 340, align = 'start', size = 'sm', children }: Props = $props();

  const asSheet = $derived(mode === 'sheet' || viewport.narrow || !anchor);
</script>

{#if asSheet}
  <Sheet {open} {onclose} {title} {size}>
    {@render children()}
  </Sheet>
{:else}
  <Popover {open} {onclose} {anchor} {width} {align} label={title}>
    {@render children()}
  </Popover>
{/if}
