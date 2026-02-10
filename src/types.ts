// --- External data boundary type (raw JSONL shape) ---

export interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface RawMessage {
  type?: string;
  subtype?: string;
  sessionId?: string;
  timestamp?: string;
  isMeta?: boolean;
  content?: ContentBlock[] | string;
  message?: {
    id: string;
    role: string;
    model?: string;
    content: ContentBlock[] | string;
    usage?: UsageInfo;
    timestamp?: string;
  };
  version?: string;
  slug?: string;
  cwd?: string;
  gitBranch?: string;
  durationMs?: number;
}

// --- Content block types (discriminated union on `type`) ---

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

// --- Classified message types (discriminated union on `role`) ---

export interface UserMessage {
  role: "user";
  content: ContentBlock[];
  timestamp?: string;
  sessionId?: string;
  version?: string;
  slug?: string;
  cwd?: string;
  gitBranch?: string;
}

export interface AssistantMessage {
  role: "assistant";
  id: string;
  model: string;
  content: ContentBlock[];
  usage?: UsageInfo;
  timestamp?: string;
}

export interface SystemMessage {
  role: "system";
  subtype?: string;
  durationMs?: number;
  timestamp?: string;
}

export type Message = UserMessage | AssistantMessage | SystemMessage;

// --- Derived types ---

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  timestamp?: Date;
  is_error?: boolean;
}

export interface Turn {
  user: UserMessage;
  assistants: AssistantMessage[];
  toolResults: UserMessage[];
  durationMs?: number;
}

export interface SessionMetadata {
  version?: string;
  slug?: string;
  cwd?: string;
  gitBranch?: string;
}

export interface GroupTurnsResult {
  turns: Turn[];
  consumed: number;
}
