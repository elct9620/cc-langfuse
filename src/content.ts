import type {
  Message,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from "./types.js";

export function isTextBlock(item: unknown): item is TextBlock {
  return (
    typeof item === "object" &&
    item !== null &&
    (item as Message).type === "text"
  );
}

export function isToolUseBlock(item: unknown): item is ToolUseBlock {
  return (
    typeof item === "object" &&
    item !== null &&
    (item as Message).type === "tool_use"
  );
}

export function isToolResultBlock(item: unknown): item is ToolResultBlock {
  return (
    typeof item === "object" &&
    item !== null &&
    (item as Message).type === "tool_result"
  );
}

export function getTimestamp(msg: Message): Date | undefined {
  const ts = msg.timestamp ?? msg.message?.timestamp;
  if (typeof ts === "string") return new Date(ts);
  return undefined;
}

export function getContent(msg: unknown): unknown {
  if (msg === null || typeof msg !== "object") return undefined;
  const record = msg as Message;
  if ("message" in record && typeof record.message === "object") {
    return record.message?.content;
  }
  return record.content;
}

export function isToolResult(msg: Message): boolean {
  const content = getContent(msg);
  if (!Array.isArray(content)) return false;
  return content.some(isToolResultBlock);
}

export function getToolCalls(msg: Message): ToolUseBlock[] {
  const content = getContent(msg);
  if (!Array.isArray(content)) return [];
  return content.filter(isToolUseBlock);
}

export function getTextContent(msg: Message): string {
  const content = getContent(msg);
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (isTextBlock(item)) {
      parts.push(item.text);
    } else if (typeof item === "string") {
      parts.push(item);
    }
  }
  return parts.join("\n");
}

export function getUsage(msg: Message): Record<string, number> | undefined {
  const usage = msg.message?.usage;
  if (!usage) return undefined;

  const details: Record<string, number> = {};
  if (typeof usage.input_tokens === "number")
    details.input = usage.input_tokens;
  if (typeof usage.output_tokens === "number")
    details.output = usage.output_tokens;
  if (
    typeof usage.input_tokens === "number" &&
    typeof usage.output_tokens === "number"
  )
    details.total = usage.input_tokens + usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === "number")
    details.cache_read_input_tokens = usage.cache_read_input_tokens;

  return Object.keys(details).length > 0 ? details : undefined;
}
