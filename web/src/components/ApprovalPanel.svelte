<script lang="ts">
  import { onMount } from 'svelte';
  import type { UiRequest } from '../lib/api/types';
  import { editorStart, optionTone, splitTitle, submitAnswer } from '../lib/composer/approval';
  import { Icon } from '../lib/ui';

  type Props = { request: UiRequest; index?: number; total?: number };

  let { request, index = 1, total = 1 }: Props = $props();

  let busy = $state(false);
  let armed = $state(false);
  let value = $state('');
  let root: HTMLDivElement | undefined = $state();

  const head = $derived(splitTitle(request.title));
  const options = $derived(request.options ?? []);
  const uid = $props.id();

  // A new request resets the fields. Digit keys stay off for a moment so a keystroke aimed at the
  // composer a second ago cannot answer a dialog that just appeared.
  $effect(() => {
    void request.id;
    value = request.method === 'editor' ? editorStart(request) : typeof request.prefill === 'string' ? request.prefill : '';
    armed = false;
    const t = setTimeout(() => (armed = true), 450);
    return () => clearTimeout(t);
  });

  onMount(() => root?.focus({ preventScroll: true }));

  async function answer(a: Parameters<typeof submitAnswer>[1]) {
    if (busy) return;
    busy = true;
    try {
      await submitAnswer(request, a);
    } finally {
      busy = false;
    }
  }

  function onwindowkey(e: KeyboardEvent) {
    if (request.method !== 'select' || !armed || busy) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (!/^[1-9]$/.test(e.key)) return;
    const opt = options[Number(e.key) - 1];
    if (opt === undefined) return;
    e.preventDefault();
    void answer({ value: opt });
  }
</script>

<svelte:window onkeydown={onwindowkey} />

<div
  class="panel"
  bind:this={root}
  tabindex="-1"
  role="group"
  aria-labelledby="{uid}-h"
  aria-live="assertive"
>
  <div class="top">
    <span class="tag"><Icon name="shield" size={14} /> Needs you</span>
    {#if total > 1}<span class="count">{index} of {total}</span>{/if}
  </div>

  <h2 id="{uid}-h">{head.headline || 'The agent has a question'}</h2>
  {#if head.detail}<pre class="detail mono">{head.detail}</pre>{/if}
  {#if request.message}<p class="message">{request.message}</p>{/if}

  {#if request.method === 'select'}
    <div class="choices">
      {#each options as opt, i (i)}
        {@const tone = optionTone(opt)}
        {@const desc = request.optionDetails?.[i]?.description}
        <button
          type="button"
          class="choice {tone}"
          disabled={busy}
          onclick={() => answer({ value: opt })}
        >
          <span class="main">
            <span class="label">{opt}</span>
            {#if desc}<span class="desc">{desc}</span>{/if}
          </span>
          {#if i < 9}<kbd class="key" aria-hidden="true">{i + 1}</kbd>{/if}
        </button>
      {/each}
    </div>
  {:else if request.method === 'confirm'}
    <div class="choices row">
      <button type="button" class="choice approve" disabled={busy} onclick={() => answer({ confirmed: true })}>
        <span class="main"><span class="label">Yes</span></span>
      </button>
      <button type="button" class="choice neutral" disabled={busy} onclick={() => answer({ confirmed: false })}>
        <span class="main"><span class="label">No</span></span>
      </button>
    </div>
  {:else if request.method === 'input'}
    <form
      class="form"
      onsubmit={(e) => {
        e.preventDefault();
        void answer({ value });
      }}
    >
      <label class="sr-only" for="{uid}-in">{head.headline}</label>
      <input
        id="{uid}-in"
        class="field"
        type="text"
        placeholder={request.placeholder ?? ''}
        autocomplete="off"
        bind:value
      />
      <button type="submit" class="btn btn-primary" disabled={busy}>Send</button>
    </form>
  {:else if request.method === 'editor'}
    <form
      class="form col"
      onsubmit={(e) => {
        e.preventDefault();
        void answer({ value });
      }}
    >
      <label class="sr-only" for="{uid}-ed">{head.headline}</label>
      <textarea
        id="{uid}-ed"
        class="field editor mono"
        rows="6"
        spellcheck="false"
        bind:value
        onkeydown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void answer({ value });
          }
        }}
      ></textarea>
      <button type="submit" class="btn btn-primary" disabled={busy}>Send</button>
    </form>
  {/if}

  <div class="foot">
    <button type="button" class="dismiss" disabled={busy} onclick={() => answer({ cancelled: true })}>
      Dismiss (cancel this request)
    </button>
  </div>
</div>

<style>
  .panel {
    display: grid;
    gap: var(--s-3);
    padding: var(--s-4);
    background: var(--surface);
    border-radius: var(--r-lg);
    box-shadow: 0 0 0 1px var(--warn), 0 0 0 4px var(--warn-soft);
    max-height: 70dvh;
    overflow-y: auto;
    overscroll-behavior: contain;
    animation: rise var(--dur) var(--ease);
  }
  .panel:focus {
    outline: none;
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: var(--fs-sm);
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    color: var(--warn);
    font-weight: 600;
  }
  .count {
    color: var(--ink-3);
  }
  h2 {
    font-size: var(--fs-lg);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .detail {
    max-height: 30dvh;
    overflow: auto;
    padding: var(--s-2) var(--s-3);
    background: var(--inset);
    border-radius: var(--r-md);
    font-size: var(--fs-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .message {
    color: var(--ink-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .choices {
    display: grid;
    gap: var(--s-2);
  }
  .choices.row {
    grid-template-columns: 1fr 1fr;
  }
  .choice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    width: 100%;
    min-height: 48px;
    padding: var(--s-2) var(--s-4);
    border-radius: var(--r-md);
    border: 1px solid var(--line-strong);
    text-align: left;
    background: var(--surface);
    color: var(--ink);
    transition: background var(--dur-fast) var(--ease);
  }
  .choice:hover:not(:disabled) {
    background: var(--press);
  }
  .choice.approve {
    background: var(--accent);
    border-color: transparent;
    color: var(--accent-ink);
    font-weight: 600;
  }
  .choice.approve:hover:not(:disabled) {
    background: var(--accent);
    filter: brightness(1.1);
  }
  .main {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .label {
    overflow-wrap: anywhere;
  }
  .desc {
    font-size: var(--fs-sm);
    font-weight: 400;
    overflow-wrap: anywhere;
  }
  .key {
    flex: none;
    min-width: 20px;
    padding: 0 5px;
    text-align: center;
    border: 1px solid currentColor;
    border-radius: var(--r-sm);
    font: 500 var(--fs-xs) / 18px var(--mono);
  }
  .deny .key,
  .neutral .key {
    color: var(--ink-2);
  }
  @media (pointer: coarse) {
    .key {
      display: none;
    }
  }
  .form {
    display: flex;
    gap: var(--s-2);
  }
  .form.col {
    flex-direction: column;
  }
  .editor {
    min-height: 120px;
    padding: var(--s-2) var(--s-3);
    resize: vertical;
  }
  .foot {
    display: flex;
    justify-content: center;
  }
  .dismiss {
    min-height: var(--hit);
    padding: 0 var(--s-4);
    color: var(--ink-2);
    font-size: var(--fs-sm);
    text-decoration: underline;
    text-underline-offset: 3px;
    border-radius: var(--r-md);
  }
  .dismiss:hover:not(:disabled) {
    color: var(--ink);
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(6px); }
  }
</style>
