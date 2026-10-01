// Per-device session pins. Pinned saved transcripts float to a "Pinned"
// section at the top of the rail's history and are excluded from session
// cleanup — the cleanup sheet never offers them for deletion. Web-local like
// the review markers: the gateway has no notion of pins, and the state keys
// on the transcript file path, which is stable across resumes and gateway
// restarts (unlike gw ids).
import { device } from '../platform/storage';

const PIN_KEY = 'ompgw-pinned-sessions';

function load(): Set<string> {
  const raw = device.get<unknown>(PIN_KEY, []);
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === 'string'));
}

export class PinStore {
  files = $state<Set<string>>(load());

  isPinned(file: string): boolean {
    return this.files.has(file);
  }

  toggle(file: string): void {
    const next = new Set(this.files);
    if (!next.delete(file)) next.add(file);
    this.files = next;
    device.set(PIN_KEY, [...this.files]);
  }

  /** True when the file must be spared by session cleanup. */
  protectedFromCleanup(file: string): boolean {
    return this.files.has(file);
  }
}

export const pins = new PinStore();
