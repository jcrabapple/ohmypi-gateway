// Typed calls for every gateway route the app uses. Thin on purpose: no state,
// no caching. Stores decide what to do with the results.
import { api, resetSignedOut } from './client';
import type {
  ApprovalMode, CatalogModels, CommandsResponse, EntriesResponse, EventsResponse, FileIndexEntry, FilesResponse,
  ForkResponse, LedgerResponse, LedgerSessionsResponse, MessagesResponse, SavedSession, SessionInfo, SessionsList,
  SessionState, SessionStats, SubagentMessagesResponse, SystemInfo, ThinkingLevel, UiAnswer, UiRequest,
} from './types';

export type PromptMode = 'prompt' | 'steer' | 'follow_up';

export interface PromptImage {
  type: 'image';
  data: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}

export interface NewSession {
  cwd?: string;
  model?: string;
  thinking?: ThinkingLevel;
  approvalMode?: ApprovalMode;
  resumeFrom?: string;
  /** Enable omp's advisor runtime (passively reviews each turn). Launch-time only. */
  advisor?: boolean;
}

/** Extra fields on POST /api/sessions: the file was already open, or the saved folder is gone. */
export interface SessionOpenFlags {
  alreadyLive?: boolean;
  cwdFallback?: boolean;
}

const sid = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;
const POST = 'POST';

export const auth = {
  async login(token: string): Promise<void> {
    await api('/auth/login', { method: POST, body: { token } });
    resetSignedOut();
  },
  logout: () => api('/auth/logout', { method: POST }),
  me: () => api<{ method: 'bearer' | 'cookie' }>('/api/me'),
};

export const host = {
  system: () => api<SystemInfo>('/api/system'),
  catalogModels: (refresh = false) =>
    api<CatalogModels>(`/api/catalog/models${refresh ? '?refresh=1' : ''}`, { timeoutMs: 180_000 }),
  config: () => api<{ raw: string; parsed: unknown; file?: string; path?: string; parseError?: string }>('/api/config'),
  saveConfig: (yaml: string) =>
    api<{ ok?: boolean; note?: string }>('/api/config', {
      method: 'PUT', body: yaml, headers: { 'Content-Type': 'text/yaml' }, timeoutMs: 120_000,
    }),
  skills: () => api<{ installed: { name: string; description: string; symlink: boolean }[] }>('/api/skills'),
  usage: () => api<{ raw: string; error?: string }>('/api/usage', { timeoutMs: 120_000 }),
  ledger: (days: number, signal?: AbortSignal) => api<LedgerResponse>(`/api/ledger?days=${days}`, { signal }),
  ledgerSessions: (days: number, signal?: AbortSignal) =>
    api<LedgerSessionsResponse>(`/api/ledger/sessions?days=${days}`, { signal }),
};

export const sessions = {
  list: (limit = 60, signal?: AbortSignal) =>
    api<SessionsList>(`/api/sessions?limit=${limit}`, { signal }),
  create: (body: NewSession) => api<SessionInfo & SessionOpenFlags>('/api/sessions', { method: POST, body }),
  resume: (saved: Pick<SavedSession, 'file'>) =>
    api<SessionInfo & SessionOpenFlags>('/api/sessions', { method: POST, body: { resumeFrom: saved.file } }),
  info: (id: string, signal?: AbortSignal) => api<SessionInfo>(sid(id), { signal }),
  stop: (id: string) => api<unknown>(sid(id), { method: 'DELETE' }),
  messages: (id: string, signal?: AbortSignal) => api<MessagesResponse>(`${sid(id)}/messages`, { signal }),
  /** Session-file message entries; user rows are the fork targets. */
  entries: (id: string, signal?: AbortSignal) => api<EntriesResponse>(`${sid(id)}/entries`, { signal }),
  /** Branch at a user entry. The fork carries history before that entry;
   *  `text` is the forked message, for prefilling the composer. */
  fork: (id: string, entryId: string) =>
    api<ForkResponse>(`${sid(id)}/fork`, { method: POST, body: { entryId }, timeoutMs: 120_000 }),
  state: (id: string, signal?: AbortSignal) => api<SessionState>(`${sid(id)}/state`, { signal }),
  stats: (id: string, signal?: AbortSignal) => api<SessionStats>(`${sid(id)}/stats`, { signal }),
  commands: (id: string, signal?: AbortSignal) => api<CommandsResponse>(`${sid(id)}/commands`, { signal }),
  events: (id: string, after: number, signal?: AbortSignal) =>
    api<EventsResponse>(`${sid(id)}/events?after=${after}`, { signal }),
  pendingUi: (id: string) => api<{ pending: UiRequest[] }>(`${sid(id)}/ui`),

  prompt: (id: string, message: string, mode: PromptMode = 'prompt', images?: PromptImage[]) =>
    api<SessionInfo>(`${sid(id)}/prompt`, {
      method: POST,
      body: images?.length ? { message, mode, images } : { message, mode },
      timeoutMs: 60_000,
    }),
  abort: (id: string) => api<unknown>(`${sid(id)}/abort`, { method: POST }),
  retry: (id: string) => api<unknown>(`${sid(id)}/retry`, { method: POST }),
  compact: (id: string, instructions?: string) =>
    api<unknown>(`${sid(id)}/compact`, { method: POST, body: instructions ? { instructions } : {}, timeoutMs: 300_000 }),
  setModel: (id: string, provider: string, modelId: string) =>
    api<unknown>(`${sid(id)}/model`, { method: POST, body: { provider, modelId } }),
  setThinking: (id: string, level: ThinkingLevel) =>
    api<unknown>(`${sid(id)}/thinking`, { method: POST, body: { level } }),
  rename: (id: string, name: string) => api<unknown>(`${sid(id)}/name`, { method: POST, body: { name } }),
  answerUi: (id: string, requestId: string, answer: UiAnswer) =>
    api<unknown>(`${sid(id)}/ui/${encodeURIComponent(requestId)}`, { method: POST, body: answer }),

  /** Registry snapshot; shape is omp's, parsed leniently by the subagent store. */
  subagents: {
    list: (id: string, signal?: AbortSignal) => api<unknown>(`${sid(id)}/subagents`, { signal }),
    messages: (id: string, subId: string, fromByte?: number, signal?: AbortSignal) =>
      api<SubagentMessagesResponse>(
        `${sid(id)}/subagents/${encodeURIComponent(subId)}/messages${fromByte != null ? `?from=${fromByte}` : ''}`,
        { signal },
      ),
  },
};

/** Index-only listing of ONE directory of the session cwd (for @-mentions).
 *  Rejects escapes at the gateway; any ApiError here means "no suggestions". */
export function sessionFiles(id: string, prefix: string, signal?: AbortSignal): Promise<FileIndexEntry[]> {
  return api<FilesResponse>(`${sid(id)}/files?prefix=${encodeURIComponent(prefix)}`, { signal }).then((r) => r.entries);
}
