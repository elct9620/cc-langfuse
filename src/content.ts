import type {
  ContentBlock,
  RawMessage,
  Message,
  UserMessage,
  AssistantMessage,
  SessionMetadata,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from "./types.js";

// --- Content block type guards ---

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

// --- Message classification ---

function normalizeContent(
  raw: ContentBlock[] | string | undefined,
): ContentBlock[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  return [];
}

export function classifyMessage(raw: RawMessage): Message | null {
  if (raw.isMeta) return null;

  if (raw.type === "system") {
    return {
      role: "system",
      subtype: raw.subtype,
      durationMs: raw.durationMs,
      timestamp: raw.timestamp,
    };
  }

  const role = raw.type ?? raw.message?.role;

  if (role === "assistant") {
    const body = raw.message;
    return {
      role: "assistant",
      id: body?.id ?? "",
      model: body?.model ?? "unknown",
      content: normalizeContent(body?.content ?? raw.content),
      usage: body?.usage,
      timestamp: raw.timestamp ?? body?.timestamp,
    };
  }

  if (role === "user") {
    return {
      role: "user",
      content: normalizeContent(raw.content),
      timestamp: raw.timestamp,
      sessionId: raw.sessionId,
      version: raw.version,
      slug: raw.slug,
      cwd: raw.cwd,
      gitBranch: raw.gitBranch,
    };
  }

  return null;
}

// --- Message accessors ---

export function getTimestamp(msg: Message): Date | undefined {
  if (msg.timestamp) return new Date(msg.timestamp);
  return undefined;
}

export function isToolResult(msg: UserMessage): boolean {
  return msg.content.some(isToolResultBlock);
}

export function getToolCalls(msg: AssistantMessage): ToolUseBlock[] {
  return msg.content.filter(isToolUseBlock);
}

export function getTextContent(msg: UserMessage | AssistantMessage): string {
  const parts: string[] = [];
  for (const item of msg.content) {
    if (isTextBlock(item)) {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

export function getSessionMetadata(
  msg: UserMessage,
): SessionMetadata | undefined {
  const metadata: SessionMetadata = {};
  if (msg.version) metadata.version = msg.version;
  if (msg.slug) metadata.slug = msg.slug;
  if (msg.cwd) metadata.cwd = msg.cwd;
  if (msg.gitBranch) metadata.gitBranch = msg.gitBranch;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function getUsage(
  msg: AssistantMessage,
): Record<string, number> | undefined {
  const usage = msg.usage;
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
