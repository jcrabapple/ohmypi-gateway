// Per-session composer drafts, in scoped localStorage. A draft outlives reloads,
// reconnects and the session itself.
import { getItem, removeItem, sessionScope, setItem } from '../platform/storage';

const KEY = 'draft';

export function loadDraft(gwId: string): string {
  const v = getItem<unknown>(sessionScope(gwId), KEY, '');
  return typeof v === 'string' ? v : '';
}

export function saveDraft(gwId: string, text: string): void {
  if (text.trim()) setItem(sessionScope(gwId), KEY, text);
  else removeItem(sessionScope(gwId), KEY);
}

export function clearDraft(gwId: string): void {
  removeItem(sessionScope(gwId), KEY);
}
