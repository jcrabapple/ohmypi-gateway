import type { OmpEvent, OmpMessage, UiRequest, UnknownEvent, Usage } from '../api/types';
import type { PromptImage, PromptMode } from '../api/endpoints';

interface ItemBase {
  /** Stable across history and live for keyed items; use as the `{#each}` key. */
  id: string;
  /**
   * Cross-source message key (`role:timestamp`, or `role:id:<messageId>` without a
   * timestamp). Links items to the message they came from so replays are idempotent.
   */
  messageKey?: string;
  /** Latest source object, for the inspector. Not compared in tests. */
  raw?: unknown;
}

export type UserNote = 'steer' | 'queued' | 'other-client';

export interface UserItem extends ItemBase {
  kind: 'user';
  text: string;
  images: number;
  /** True from local send until the echo arrives (or the session settles). */
  pending: boolean;
  note?: UserNote;
  failed?: boolean;
  error?: string;
  timestamp?: number;
  /** Local sends only: the id the caller passed to `local-send`. */
  localId?: string;
}

export interface AssistantItem extends ItemBase {
  kind: 'assistant';
  text: string;
  streaming: boolean;
  model?: string;
  provider?: string;
  usage?: Usage;
  stopReason?: string;
  error?: string;
  timestamp?: number;
  /** Milliseconds, from message_end. */
  duration?: number;
  ttft?: number;
}

export interface ThinkingItem extends ItemBase {
  kind: 'thinking';
  text: string;
  streaming: boolean;
  /** Live: when we first saw it. History: the assistant message timestamp. */
  startedAt?: number;
  /** Live only. History has no thinking timing. */
  endedAt?: number;
}

export type ToolStatus = 'running' | 'done' | 'error' | 'interrupted';

export interface ToolItem extends ItemBase {
  kind: 'tool';
  toolCallId: string;
  toolName: string;
  /** Arguments with omp's `i` (intent) key removed. */
  args: Record<string, unknown> | undefined;
  /** intent, else command, path, file_path, pattern, query, url, else compact JSON. */
  summary: string;
  intent?: string;
  output: string;
  status: ToolStatus;
  details?: unknown;
  startedAt?: number;
  endedAt?: number;
}

export interface SkillItem extends ItemBase {
  kind: 'skill';
  name: string;
  /** Full injected prompt, for the expander. */
  content: string;
  prompt?: string;
  lineCount?: number;
  timestamp?: number;
}

export interface CommandItem extends ItemBase {
  kind: 'command';
  /** What the user typed, when we know it. */
  command?: string;
  /** Raw output, ANSI SGR codes intact. Render with `lib/render/ansi`. */
  text: string;
}

export type NoticeTag = 'compaction' | 'retry';

export interface NoticeItem extends ItemBase {
  kind: 'notice';
  level: 'info' | 'error';
  text: string;
  tag?: NoticeTag;
  /** True while the thing the notice describes is still going on. */
  active?: boolean;
}

export type Item =
  | UserItem | AssistantItem | ThinkingItem | ToolItem | SkillItem | CommandItem | NoticeItem;

export interface TranscriptState {
  items: readonly Item[];
  /** Blocking extension dialogs waiting for an answer. */
  pendingUi: readonly UiRequest[];
  /** Between agent_start and agent_end (or the `streaming` flag of a history input). */
  running: boolean;
  /** Source of ids for items that have no natural key. */
  counter: number;
}

export type TranscriptInput =
  | { kind: 'history'; messages: readonly OmpMessage[]; streaming?: boolean }
  | { kind: 'event'; event: OmpEvent | UnknownEvent; at?: number }
  | {
      kind: 'local-send';
      localId: string;
      text: string;
      mode: PromptMode;
      images?: readonly PromptImage[];
    }
  | { kind: 'local-send-failed'; localId: string; error: string }
  | { kind: 'pending-ui'; requests: readonly UiRequest[] };
