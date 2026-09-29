// Wire types, hand-written against the captures in dev/fixtures. The gateway
// passes omp's events through untouched, so anything omp adds later shows up
// as an unknown event type or an unknown field and must be ignored, never
// thrown on.

export type ApprovalMode = 'yolo' | 'write' | 'always-ask';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Model as reported inside session info / omp state. */
export interface ModelRef {
  id: string;
  name?: string;
  provider: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: ModelCost;
  contextWindow?: number;
  maxTokens?: number;
  thinking?: {
    mode?: string;
    efforts: string[];
    defaultLevel?: string;
    requiresEffort?: boolean;
  } | null;
}

/** Model as emitted by `omp models --json` (GET /api/catalog/models). */
export interface CatalogModel {
  provider: string;
  kind: string;
  id: string;
  selector: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinking: string[] | null;
  input: string[];
  cost: ModelCost;
}

export interface CatalogModels {
  models: CatalogModel[];
}

export interface SessionInfo {
  gwId: string;
  cwd: string;
  approvalMode: ApprovalMode;
  resumedFrom: string | null;
  ompSessionId: string | null;
  ompSessionFile: string | null;
  ompSessionName: string | null;
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | string | null;
  isStreaming: boolean;
  idleSec: number;
  exited: boolean;
  exitCode: number | null;
  protocolVersion: number | null;
  uptimeSec: number;
  subscribers: number;
  messageCount: number;
  contextUsage: ContextUsage | null;
  lastEventSeq: number;
  pendingUi: UiRequest[];
}

export interface SavedSession {
  file: string;
  mtime: number;
  sizeBytes: number;
  cwdFolder: string;
  /** Working directory recorded in the transcript; null for older files. */
  cwd: string | null;
  title: string;
  running: boolean;
}

export interface SessionsList {
  live: SessionInfo[];
  saved: SavedSession[];
}

export type SlashSource = 'builtin' | 'skill' | 'extension' | 'custom' | 'file';

export interface SlashCommand {
  name: string;
  description: string;
  source: SlashSource;
  aliases?: string[];
  input?: { hint?: string };
  subcommands?: { name: string; description?: string }[];
}

/** GET /sessions/{id}/commands */
export interface CommandsResponse {
  data: { commands: SlashCommand[] };
}

/** GET /sessions/{id}/state (omp get_state minus system prompt and tool dumps). */
export interface SessionState {
  model: ModelRef | null;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: string;
  followUpMode: string;
  interruptMode: string;
  sessionFile: string;
  sessionId: string;
  autoCompactionEnabled: boolean;
  queuedMessageCount: number;
  hasPendingAsyncWork: boolean;
  isSettled: boolean;
  todoPhases: unknown[];
  fastModeEnabled: boolean;
  fastModeActive: boolean;
  tokensPerSecond: number | null;
  messageCount: number;
  contextUsage: ContextUsage | null;
}

export interface SessionStatsData {
  sessionFile: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  premiumRequests: number;
  contextUsage: ContextUsage | null;
}

/** GET /sessions/{id}/stats */
export interface SessionStats {
  data: SessionStatsData;
}

export interface SystemInfo {
  gateway: { version: string; uptimeSec: number; maxSessions: number; idleReapSec: number };
  omp: { version: string; agentDir: string; configFile: string };
  liveSessions: number;
}

// ------------------------------------------------------------------ messages

export interface TextBlock { type: 'text'; text: string; textSignature?: string }
export interface ThinkingBlock { type: 'thinking'; thinking: string; thinkingSignature?: string }
export interface ImageBlock { type: 'image'; data?: string; mimeType?: string }
export interface ToolCallBlock {
  type: 'toolCall';
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  intent?: string;
}
export type ContentBlock = TextBlock | ThinkingBlock | ImageBlock | ToolCallBlock;

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reasoningTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface UserMessage {
  role: 'user';
  content: string | ContentBlock[];
  attribution?: string;
  timestamp?: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | ContentBlock[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  stopReason?: string;
  timestamp?: number;
  responseId?: string;
  duration?: number;
  ttft?: number;
  completedAt?: number;
  errorMessage?: string;
}

export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: string | ContentBlock[];
  details?: Record<string, unknown>;
  isError?: boolean;
  timestamp?: number;
}

export interface CustomMessage {
  role: 'custom';
  customType: string;
  content: string | ContentBlock[];
  display?: boolean;
  details?: Record<string, unknown>;
  attribution?: string;
  timestamp?: number;
}

export type OmpMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage;

/** GET /sessions/{id}/messages */
export interface MessagesResponse {
  messages: OmpMessage[];
  totalMessages: number;
}

// -------------------------------------------------------------------- events

export type AssistantMessageEventType =
  | 'text_start' | 'text_delta' | 'text_end'
  | 'thinking_start' | 'thinking_delta' | 'thinking_end'
  | 'toolcall_start' | 'toolcall_delta' | 'toolcall_end';

export interface AssistantMessageEvent {
  type: AssistantMessageEventType;
  contentIndex?: number;
  delta?: string;
  content?: string;
  toolCall?: ToolCallBlock;
  partial?: AssistantMessage;
}

/** Blocking dialog methods answered by the user; the rest are fire-and-forget. */
export type BlockingUiMethod = 'select' | 'confirm' | 'input' | 'editor';
export type FireAndForgetUiMethod =
  | 'notify' | 'setStatus' | 'setWidget' | 'setTitle' | 'set_editor_text' | 'open_url';

export interface UiRequest {
  type?: 'extension_ui_request';
  id: string;
  method: BlockingUiMethod | FireAndForgetUiMethod | string;
  title?: string;
  message?: string;
  options?: string[];
  optionDetails?: { description?: string }[];
  placeholder?: string;
  prefill?: string;
  text?: string;
  timeout?: number;
  [k: string]: unknown;
}

export function isBlockingUi(u: { method: string }): boolean {
  return u.method === 'select' || u.method === 'confirm' || u.method === 'input' || u.method === 'editor';
}

export type UiAnswer =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

interface Ev<T extends string> { type: T }

export type OmpEvent =
  | Ev<'agent_start'>
  | (Ev<'agent_end'> & { messages?: OmpMessage[] })
  | Ev<'turn_start'>
  | (Ev<'turn_end'> & { message?: OmpMessage; toolResults?: unknown[] })
  | (Ev<'message_start'> & { message: OmpMessage; messageId?: string })
  | (Ev<'message_update'> & {
      message?: AssistantMessage;
      assistantMessageEvent: AssistantMessageEvent;
      messageId?: string;
    })
  | (Ev<'message_end'> & { message: OmpMessage; messageId?: string })
  | (Ev<'tool_execution_start'> & {
      toolCallId: string; toolName: string; args?: unknown; intent?: string;
    })
  | (Ev<'tool_execution_update'> & {
      toolCallId: string; toolName?: string; args?: unknown; partialResult?: unknown;
    })
  | (Ev<'tool_execution_end'> & {
      toolCallId: string; toolName?: string; result?: unknown; isError?: boolean;
    })
  | (Ev<'extension_ui_request'> & UiRequest)
  | (Ev<'ui_resolved'> & { id: string; method?: string; reason?: string; response?: unknown })
  | (Ev<'command_output'> & { text: string })
  | (Ev<'available_commands_update'> & { commands: SlashCommand[] })
  | (Ev<'prompt_result'> & {
      id?: string; agentInvoked?: boolean; status?: string; sessionSettled?: boolean;
    })
  | Ev<'session_settled'>
  | (Ev<'auto_compaction_start'> & { reason?: string })
  | (Ev<'auto_compaction_end'> & { aborted?: boolean; errorMessage?: string; result?: unknown })
  | (Ev<'auto_retry_start'> & {
      attempt?: number; maxAttempts?: number; delayMs?: number; errorMessage?: string;
    })
  | (Ev<'auto_retry_end'> & { success?: boolean; attempt?: number; finalError?: string })
  | (Ev<'model_changed'> & { model?: ModelRef | string })
  | (Ev<'thinking_level_changed'> & { level?: string; thinkingLevel?: string })
  | (Ev<'notice'> & { message?: string; text?: string; level?: string })
  | (Ev<'extension_error'> & { extensionPath?: string; event?: string; error?: string });

/** Every event type the reducer or stores act on. Others are ignored. */
export type KnownEventType = OmpEvent['type'];

export interface UnknownEvent { type: string; [k: string]: unknown }

// --------------------------------------------------------- gateway control

export interface AuthOkFrame { type: 'auth_ok'; session: SessionInfo; gap?: boolean }
export interface HeartbeatFrame { type: 'heartbeat' }
export interface PongFrame { type: 'pong' }
export interface WsErrorFrame { type: 'ws_error'; error: string }
export interface RpcResponseFrame {
  type: 'rpc_response';
  id?: string;
  command?: string;
  success: boolean;
  data?: unknown;
  error?: string;
}
export type ControlEvent = AuthOkFrame | HeartbeatFrame | PongFrame | WsErrorFrame | RpcResponseFrame;

/** Every server frame is `{seq, event}`; seq 0 marks a control frame. */
export interface WireFrame { seq: number; event: OmpEvent | ControlEvent | UnknownEvent }

/** GET /sessions/{id}/events?after=n */
export interface EventsResponse {
  events: { seq: number; event: OmpEvent | UnknownEvent }[];
  lastSeq: number;
  gap?: boolean;
}
