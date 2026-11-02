<script lang="ts">
  // Artifacts in the session's working directory: browse, download what a run
  // produced, and put a file in. Downloads go through the gateway with the
  // session cookie, so a plain link works and nothing needs a token in the URL.
  import { onMount } from 'svelte';
  import { fileUrl, sessionFiles, sessions } from '../lib/api/endpoints';
  import type { FileIndexEntry } from '../lib/api/types';
  import { ApiError } from '../lib/api/client';
  import type { OverlayProps } from '../lib/overlays';
  import { active } from '../lib/state';
  import { Loader } from '../lib/state/loader.svelte';
  import { Icon, Sheet, Spinner, toast } from '../lib/ui';

  let { onclose }: OverlayProps = $props();

  const listing = new Loader<FileIndexEntry[]>();
  const gwId = $derived(active.gwId);
  const cwd = $derived(active.info?.cwd ?? '');

  let dir = $state('');
  let fileInput: HTMLInputElement | undefined = $state();
  let uploading = $state(false);
  let dragging = $state(false);

  const load = () => {
    if (!gwId) return;
    void listing.run(() => sessionFiles(gwId!, dir));
  };

  onMount(load);

  // Opening another folder resets the list instead of showing the old one.
  $effect(() => {
    void dir;
    if (gwId) load();
  });

  const parts = $derived(dir ? dir.split('/').filter(Boolean) : []);
  const crumbs = $derived(() => {
    const out: { label: string; path: string }[] = [{ label: cwd.split('/').filter(Boolean).pop() || 'session', path: '' }];
    let acc = '';
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      out.push({ label: p, path: acc });
    }
    return out;
  });

  const entries = $derived(listing.data ?? []);
  const size = (n: number | null) => {
    if (n === null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  function up() {
    if (!parts.length) return;
    dir = parts.slice(0, -1).join('/');
  }

  function onchoose(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files?.length) void upload([...input.files]);
    input.value = '';
  }

  function ondrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) void upload(files);
  }

  async function upload(files: File[]) {
    if (!gwId || uploading) return;
    uploading = true;
    let ok = 0;
    const failed: string[] = [];
    for (const file of files) {
      try {
        await sessions.upload(gwId, file, dir);
        ok += 1;
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : 'upload failed';
        failed.push(`${file.name}: ${msg}`);
      }
    }
    uploading = false;
    load();
    if (ok && !failed.length) toast(ok === 1 ? 'File uploaded' : `${ok} files uploaded`);
    if (failed.length) toast(failed[0], { kind: 'error' });
  }
</script>

<Sheet open onclose={onclose} title="Files" size="lg" flush>
  <div class="files">
    <div class="bar">
      <button type="button" class="icon-btn" aria-label="Up one folder" disabled={!parts.length} onclick={up}>
        <Icon name="chevron-right" size={16} />
      </button>
      <nav class="crumbs" aria-label="Folder path">
        {#each crumbs() as c, i (c.path)}
          {#if i > 0}<span class="sep">/</span>{/if}
          <button
            type="button"
            class="crumb"
            aria-current={i === crumbs().length - 1 ? 'true' : undefined}
            onclick={() => (dir = c.path)}
          >{c.label}</button>
        {/each}
      </nav>
      <button type="button" class="btn btn-sm" disabled={uploading} onclick={() => fileInput?.click()}>
        {#if uploading}<Spinner size={12} label="Uploading" />{:else}<Icon name="plus" size={14} />{/if}
        Upload
      </button>
      <input bind:this={fileInput} type="file" multiple hidden onchange={onchoose} />
    </div>

    <div
      class="drop"
      class:dragging
      role="region"
      aria-label="Files in this folder"
      ondragover={(e) => {
        e.preventDefault();
        dragging = true;
      }}
      ondragleave={() => (dragging = false)}
      ondrop={ondrop}
    >
      {#if listing.error}
        <div class="err" role="alert">
          <p>{listing.error}</p>
          <button type="button" class="btn btn-sm" onclick={load}>Try again</button>
        </div>
      {:else if listing.data === null}
        <div class="sk" aria-hidden="true">
          {#each [0, 1, 2, 3] as n (n)}<span class="skeleton" style:width="{80 - n * 9}%"></span>{/each}
        </div>
      {:else if entries.length === 0}
        <p class="empty">This folder is empty. Upload something, or a run can write here.</p>
      {:else}
        <ul class="list">
          {#each entries as e (e.path)}
            <li>
              {#if e.isDir}
                <button type="button" class="row" onclick={() => (dir = e.path)}>
                  <Icon name="file" size={15} />
                  <span class="name">{e.name}</span>
                  <span class="meta">folder</span>
                  <Icon name="chevron-right" size={15} />
                </button>
              {:else}
                <div class="row">
                  <Icon name="file" size={15} />
                  <span class="name" title={e.path}>{e.name}</span>
                  <span class="meta">{size(e.size)}</span>
                  {#if gwId}
                    <a class="btn btn-ghost btn-sm dl" href={fileUrl(gwId, e.path)} download>Download</a>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if dragging}<div class="overlay">Drop to upload into {dir || 'the session folder'}</div>{/if}
    </div>
  </div>
</Sheet>

<style>
  .files {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-2) var(--s-3);
    border-bottom: 1px solid var(--line);
  }
  .bar .icon-btn:disabled {
    opacity: 0.4;
  }
  .bar :global(.icon-btn) {
    transform: rotate(-90deg);
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1 1 auto;
    min-width: 0;
    overflow-x: auto;
    white-space: nowrap;
  }
  .crumb {
    color: var(--ink-2);
    font-size: var(--fs-sm);
    padding: 4px 2px;
    min-height: 32px;
  }
  .crumb[aria-current='true'] {
    color: var(--ink);
    font-weight: 600;
  }
  .sep {
    color: var(--ink-3);
  }
  .drop {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: var(--s-3);
  }
  .list {
    display: grid;
    gap: var(--s-1);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    border-radius: var(--r-md);
    background: var(--inset);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    width: 100%;
    min-height: 44px;
    padding: var(--s-2) var(--s-3);
    text-align: left;
    color: var(--ink);
  }
  .name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
  }
  .meta {
    color: var(--ink-3);
    font-size: var(--fs-xs);
    flex: none;
  }
  .dl {
    flex: none;
  }
  .empty {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .err {
    display: grid;
    justify-items: start;
    gap: var(--s-3);
    padding: var(--s-3) var(--s-4);
    border-radius: var(--r-md);
    background: var(--err-soft);
    overflow-wrap: anywhere;
  }
  .sk {
    display: grid;
    gap: var(--s-3);
  }
  .sk .skeleton {
    height: 14px;
  }
  .overlay {
    position: absolute;
    inset: var(--s-2);
    display: grid;
    place-items: center;
    border: 2px dashed var(--accent);
    border-radius: var(--r-lg);
    background: var(--accent-soft);
    color: var(--ink);
    font-size: var(--fs-sm);
    pointer-events: none;
  }
</style>
