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

export function isTextBlock(item: ContentBlock): item is TextBlock {
  return item.type === "text";
}

export function isToolUseBlock(item: ContentBlock): item is ToolUseBlock {
  return item.type === "tool_use";
}

export function isToolResultBlock(item: ContentBlock): item is ToolResultBlock {
  return item.type === "tool_result";
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
      content: normalizeContent(raw.message?.content ?? raw.content),
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

  const details: Record<string, number> = {};
  if (usage.input_tokens !== undefined) details.input = usage.input_tokens;
  if (usage.output_tokens !== undefined) details.output = usage.output_tokens;
  if (details.input !== undefined && details.output !== undefined)
    details.total = details.input + details.output;
  if (usage.cache_read_input_tokens !== undefined)
    details.cache_read_input_tokens = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens !== undefined)
    details.cache_creation_input_tokens = usage.cache_creation_input_tokens;

  return Object.keys(details).length > 0 ? details : undefined;
}
