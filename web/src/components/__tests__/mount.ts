// Tiny mount helper: real Svelte components in happy-dom, no testing-library.
import { flushSync, mount, unmount } from 'svelte';
import type { Component } from 'svelte';

const live: Record<string, unknown>[] = [];

export function render<P extends Record<string, unknown>>(component: Component<P>, props: P) {
  const target = document.createElement('div');
  document.body.append(target);
  const instance = mount(component, { target, props });
  live.push(instance);
  flushSync();
  return { target, instance };
}

export function cleanup(): void {
  for (const i of live.splice(0)) void unmount(i);
  document.body.innerHTML = '';
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    flushSync();
  }
}

export function buttonNamed(root: ParentNode, name: string | RegExp): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find((b) => {
    const label = (b.getAttribute('aria-label') ?? b.textContent ?? '').replace(/\s+/g, ' ').trim();
    return typeof name === 'string' ? label === name : name.test(label);
  });
}
