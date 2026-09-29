<script module lang="ts">
  export interface Attached {
    id: number;
    file: File;
    url: string;
  }
</script>

<script lang="ts">
  import { Icon } from '../lib/ui';

  let { images, onremove }: { images: Attached[]; onremove: (id: number) => void } = $props();
</script>

<ul class="tray" aria-label="Attached images">
  {#each images as img, n (img.id)}
    <li class="thumb">
      <img src={img.url} alt="Attachment {n + 1}: {img.file.name}" />
      <button type="button" class="rm" aria-label="Remove image {n + 1}" onclick={() => onremove(img.id)}>
        <Icon name="x" size={12} />
      </button>
    </li>
  {/each}
</ul>

<style>
  .tray {
    display: flex;
    gap: var(--s-2);
    list-style: none;
    margin: 0;
    padding: var(--s-2) var(--s-3) 0;
    overflow-x: auto;
  }
  .thumb {
    position: relative;
    flex: none;
    width: 56px;
    height: 56px;
    border-radius: var(--r-md);
    overflow: hidden;
    box-shadow: var(--ring);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .rm {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--bg);
    color: var(--ink);
    box-shadow: var(--ring);
  }
  @media (pointer: coarse) {
    /* The visible dot stays small; the hit area grows around it. */
    .rm::after {
      content: '';
      position: absolute;
      inset: -11px;
    }
  }
</style>
