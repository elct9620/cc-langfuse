import type {
  ContentBlock,
  Message,
  SessionMetadata,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from "./types.js";

function isBlockOfType<T extends ContentBlock>(
  item: unknown,
  type: T["type"],
): item is T {
  return (
    typeof item === "object" &&
    item !== null &&
    "type" in item &&
    item.type === type
  );
}

function isTextBlock(item: unknown): item is TextBlock {
  return isBlockOfType<TextBlock>(item, "text");
}

function isToolUseBlock(item: unknown): item is ToolUseBlock {
  return isBlockOfType<ToolUseBlock>(item, "tool_use");
}

export function isToolResultBlock(item: unknown): item is ToolResultBlock {
  return isBlockOfType<ToolResultBlock>(item, "tool_result");
}

export function getTimestamp(msg: Message): Date | undefined {
  const ts = msg.timestamp ?? msg.message?.timestamp;
  if (typeof ts === "string") return new Date(ts);
  return undefined;
}

export function getContent(msg: Message): ContentBlock[] {
  const raw =
    msg.message && typeof msg.message === "object"
      ? msg.message.content
      : msg.content;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  return [];
}

export function isToolResult(msg: Message): boolean {
  return getContent(msg).some(isToolResultBlock);
}

export function getToolCalls(msg: Message): ToolUseBlock[] {
  return getContent(msg).filter(isToolUseBlock);
}

export function getTextContent(msg: Message): string {
  const parts: string[] = [];
  for (const item of getContent(msg)) {
    if (isTextBlock(item)) {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

export function getSessionMetadata(msg: Message): SessionMetadata | undefined {
  const metadata: SessionMetadata = {};
  if (msg.version) metadata.version = msg.version;
  if (msg.slug) metadata.slug = msg.slug;
  if (msg.cwd) metadata.cwd = msg.cwd;
  if (msg.gitBranch) metadata.gitBranch = msg.gitBranch;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function getUsage(msg: Message): Record<string, number> | undefined {
  const usage = msg.message?.usage;
  if (!usage) return undefined;

  const inputTokens =
    typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const outputTokens =
    typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;

  const details: Record<string, number> = {};
  if (inputTokens !== undefined) details.input = inputTokens;
  if (outputTokens !== undefined) details.output = outputTokens;
  if (inputTokens !== undefined && outputTokens !== undefined)
    details.total = inputTokens + outputTokens;
  if (typeof usage.cache_read_input_tokens === "number")
    details.cache_read_input_tokens = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === "number")
    details.cache_creation_input_tokens = usage.cache_creation_input_tokens;

  return Object.keys(details).length > 0 ? details : undefined;
}
