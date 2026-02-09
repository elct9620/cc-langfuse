interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AssistantMessageBody {
  id: string;
  role: string;
  model?: string;
  content: ContentBlock[] | string;
  usage?: UsageInfo;
  timestamp?: string;
}

export interface Message {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  isMeta?: boolean;
  content?: ContentBlock[] | string;
  message?: AssistantMessageBody;
}

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
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  timestamp?: Date;
}

export interface Turn {
  user: Message;
  assistants: Message[];
  toolResults: Message[];
}

export interface GroupTurnsResult {
  turns: Turn[];
  consumed: number;
}
