<script lang="ts">
  let { size = 14, label = '' }: { size?: number; label?: string } = $props();
</script>

<span class="spinner" style:width="{size}px" style:height="{size}px" aria-hidden="true"></span>
{#if label}<span class="sr-only" role="status">{label}</span>{/if}
