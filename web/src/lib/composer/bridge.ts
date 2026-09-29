// Lets code outside the session view (shortcuts, the palette) reach the open composer.
export interface ComposerHandle {
  setText(text: string): void;
  focus(): void;
}

let handle: ComposerHandle | null = null;

export function registerComposer(next: ComposerHandle | null): void {
  handle = next;
}

export function focusComposer(): boolean {
  if (!handle) return false;
  handle.focus();
  return true;
}

export function fillComposer(text: string): boolean {
  if (!handle) return false;
  handle.setText(text);
  return true;
}
