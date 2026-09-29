<script lang="ts">
  import { overlayComponents } from '../lib/overlays';
  import { ui } from '../lib/state';
  import type { OverlayId } from '../lib/state/ui.svelte';
  import { ConfirmDialog, Toasts } from '../lib/ui';
  import NewSessionSheet from './NewSessionSheet.svelte';

  const registered = $derived(
    ui.overlays.map((o) => o.id).filter((id): id is OverlayId => id !== 'new-session' && !!overlayComponents[id]),
  );
</script>

{#if ui.isOpen('new-session')}
  <NewSessionSheet onclose={() => ui.close('new-session')} />
{/if}

{#each registered as id (id)}
  {@const Overlay = overlayComponents[id]}
  {#if Overlay}<Overlay onclose={() => ui.close(id)} />{/if}
{/each}

<ConfirmDialog />
<Toasts />
