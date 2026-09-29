<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { showsProgress, toBlocks } from '../lib/transcript/blocks';
  import { active, nav, ui } from '../lib/state';
  import { Icon } from '../lib/ui';
  import EmptySession from './EmptySession.svelte';
  import AssistantMessage from './items/AssistantMessage.svelte';
  import CommandCard from './items/CommandCard.svelte';
  import NoticeLine from './items/NoticeLine.svelte';
  import SkillChip from './items/SkillChip.svelte';
  import ThinkingRow from './items/ThinkingRow.svelte';
  import ToolGroup from './items/ToolGroup.svelte';
  import UserBubble from './items/UserBubble.svelte';

  let { onstarter }: { onstarter: (text: string) => void } = $props();

  const FOLLOW_PX = 120;

  let scroller: HTMLDivElement | undefined = $state();
  let inner: HTMLDivElement | undefined = $state();
  let following = $state(true);

  const items = $derived(active.transcript.items);
  const blocks = $derived(toBlocks(items));
  const working = $derived(active.running && !showsProgress(items));
  const showEmpty = $derived(active.phase === 'ready' && items.length === 0 && !active.running);
  const skeleton = $derived(active.phase === 'loading' && items.length === 0);

  function distanceFromBottom(): number {
    if (!scroller) return 0;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  }

  function toBottom(smooth = false) {
    if (!scroller) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'instant' });
  }

  function onscroll() {
    following = distanceFromBottom() <= FOLLOW_PX;
  }

  async function jump() {
    following = true;
    await tick();
    toBottom(true);
  }

  onMount(() => {
    toBottom();
    if (!inner) return;
    // Content grows while streaming, when images load and when rows expand.
    const ro = new ResizeObserver(() => {
      if (following) toBottom();
    });
    ro.observe(inner);
    return () => ro.disconnect();
  });

  // Sending always brings you back to the bottom.
  let lastSentId = '';
  $effect(() => {
    const last = items.at(-1);
    if (last?.kind === 'user' && last.pending && last.id !== lastSentId) {
      lastSentId = last.id;
      following = true;
      void tick().then(() => toBottom());
    }
  });

  const status = $derived(
    active.pendingUi.length ? 'Waiting for your answer' : active.running ? 'omp is working' : 'omp is idle',
  );

  function openNew(e: MouseEvent) {
    ui.open('new-session', e.currentTarget as HTMLElement);
  }

  function resume() {
    const file = active.info?.ompSessionFile;
    if (file) void nav.resume({ file, running: false });
  }
</script>

<div class="wrap">
  <div class="sr-only" role="status" aria-live="polite">{status}</div>

  {#if active.phase === 'gone'}
    <div class="state">
      <p class="lead">This session has ended</p>
      <p class="sub">The transcript is saved in History. Your draft is kept.</p>
      <div class="acts">
        {#if active.info?.ompSessionFile}
          <button type="button" class="btn btn-primary" onclick={resume}>Resume</button>
        {/if}
        <button type="button" class="btn" onclick={openNew}>New session</button>
        <button type="button" class="btn btn-ghost" onclick={() => nav.home()}>Back</button>
      </div>
    </div>
  {:else if active.phase === 'error'}
    <div class="state">
      <p class="lead">Could not open this session</p>
      <p class="sub">{active.error}</p>
      <div class="acts">
        <button type="button" class="btn btn-primary" onclick={() => active.gwId && active.open(active.gwId)}>Try again</button>
        <button type="button" class="btn btn-ghost" onclick={() => nav.home()}>Back</button>
      </div>
    </div>
  {:else}
    <div class="scroller scroll-y" bind:this={scroller} {onscroll}>
      <div class="inner" bind:this={inner}>
        {#if skeleton}
          <div class="skel" aria-hidden="true">
            <span class="skeleton bubble"></span>
            <span class="skeleton l1"></span>
            <span class="skeleton l2"></span>
            <span class="skeleton l3"></span>
          </div>
        {:else if showEmpty}
          <EmptySession onpick={onstarter} />
        {:else}
          {#each blocks as b (b.key)}
            <div class="block {b.kind === 'item' ? b.item.kind : 'tool'}">
              {#if b.kind === 'tools'}
                <ToolGroup tools={b.tools} />
              {:else if b.item.kind === 'user'}
                <UserBubble item={b.item} />
              {:else if b.item.kind === 'assistant'}
                <AssistantMessage item={b.item} />
              {:else if b.item.kind === 'thinking'}
                <ThinkingRow item={b.item} />
              {:else if b.item.kind === 'skill'}
                <SkillChip item={b.item} />
              {:else if b.item.kind === 'command'}
                <CommandCard item={b.item} />
              {:else if b.item.kind === 'notice'}
                <NoticeLine item={b.item} />
              {/if}
            </div>
          {/each}
          {#if working}
            <p class="working"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span> Working</p>
          {/if}
        {/if}
      </div>
    </div>

    {#if !following && !showEmpty && !skeleton}
      <button type="button" class="jump" onclick={jump}>
        <Icon name="arrow-down" size={14} /> Jump to latest
      </button>
    {/if}
  {/if}
</div>

<style>
  .wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .scroller {
    flex: 1;
    min-height: 0;
    overflow-anchor: none;
  }
  .inner {
    width: 100%;
    max-width: var(--reading-w);
    margin: 0 auto;
    padding: var(--s-5) var(--s-4) var(--s-6);
    min-height: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
  .block {
    flex: none;
    min-width: 0;
    /* Paint containment clips at the padding box, so leave room for hover tools and focus rings. */
    padding: 6px 4px;
    margin: -6px -4px;
  }
  /* Finished blocks skip layout and paint while off screen. The streaming one must stay live. */
  .block:not(:last-child) {
    content-visibility: auto;
    contain-intrinsic-size: auto 96px;
  }
  .state {
    flex: 1;
    display: grid;
    align-content: center;
    justify-items: center;
    gap: var(--s-3);
    padding: var(--s-6) var(--s-4);
    text-align: center;
  }
  .lead {
    font-size: var(--fs-lg);
    font-weight: 600;
  }
  .sub {
    color: var(--ink-3);
    max-width: 44ch;
    overflow-wrap: anywhere;
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--s-2);
    margin-top: var(--s-2);
  }
  .skel {
    display: grid;
    gap: var(--s-3);
  }
  .skel span {
    display: block;
    height: 14px;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  .skel .bubble {
    justify-self: end;
    width: 46%;
    height: 40px;
    border-radius: var(--r-lg);
  }
  .skel .l1 { width: 92%; }
  .skel .l2 { width: 78%; }
  .skel .l3 { width: 55%; }
  .working {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .dots {
    display: inline-flex;
    gap: 3px;
  }
  .dots i {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--ink-3);
    animation: bounce 1.2s var(--ease) infinite;
  }
  .dots i:nth-child(2) { animation-delay: 0.15s; }
  .dots i:nth-child(3) { animation-delay: 0.3s; }
  .jump {
    position: absolute;
    left: 50%;
    bottom: var(--s-4);
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    min-height: max(32px, var(--hit));
    padding: 0 var(--s-4);
    border-radius: 999px;
    background: var(--surface);
    box-shadow: var(--shadow-pop);
    font-size: var(--fs-sm);
    animation: rise var(--dur) var(--ease);
  }
  .jump:hover {
    background: color-mix(in srgb, var(--surface) 88%, var(--ink));
  }
  @keyframes shimmer {
    50% { opacity: 0.5; }
  }
  @keyframes bounce {
    40% { transform: translateY(-3px); opacity: 1; }
    0%, 80%, 100% { opacity: 0.4; }
  }
  @keyframes rise {
    from { opacity: 0; transform: translate(-50%, 6px); }
  }
</style>
