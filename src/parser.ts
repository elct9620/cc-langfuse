import type {
  Message,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolCall,
  Turn,
  GroupTurnsResult,
} from "./types.js";

export {
  type Message,
  type TextBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type ContentBlock,
  type ToolCall,
  type Turn,
  type GroupTurnsResult,
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

export function mergeAssistantParts(parts: Message[]): Message {
  if (parts.length === 0) return {};

  const mergedContent: unknown[] = [];
  for (const part of parts) {
    const content = getContent(part);
    if (Array.isArray(content)) {
      mergedContent.push(...content);
    } else if (content !== undefined && content !== null) {
      mergedContent.push({ type: "text", text: String(content) });
    }
  }

  const result = { ...parts[0] };
  if ("message" in result) {
    result.message = { ...result.message, content: mergedContent };
  } else {
    result.content = mergedContent;
  }
  return result;
}

export function groupTurns(messages: Message[]): GroupTurnsResult {
  const turns: Turn[] = [];

  let currentUser: Message | null = null;
  let currentAssistants: Message[] = [];
  let currentParts: Message[] = [];
  let currentMsgId: string | null = null;
  let currentToolResults: Message[] = [];
  let lastCompleteTurnEnd = 0;

  function finalizeParts(): void {
    if (currentMsgId !== null && currentParts.length > 0) {
      currentAssistants.push(mergeAssistantParts(currentParts));
      currentParts = [];
      currentMsgId = null;
    }
  }

  function finalizeTurn(nextIdx: number): void {
    finalizeParts();
    if (currentUser !== null && currentAssistants.length > 0) {
      turns.push({
        user: currentUser,
        assistants: currentAssistants,
        toolResults: currentToolResults,
      });
      lastCompleteTurnEnd = nextIdx;
    }
  }

  let idx = 0;
  for (const msg of messages) {
    if (msg.isMeta === true) {
      idx++;
      continue;
    }

    const role =
      msg.type ?? (msg.message as Message | undefined)?.role ?? undefined;

    if (role === "user") {
      if (isToolResult(msg)) {
        currentToolResults.push(msg);
        idx++;
        continue;
      }

      // New user message — finalize previous turn
      finalizeTurn(idx);

      currentUser = msg;
      currentAssistants = [];
      currentParts = [];
      currentMsgId = null;
      currentToolResults = [];
    } else if (role === "assistant") {
      const msgId: string | undefined = msg.message?.id;

      if (!msgId) {
        currentParts.push(msg);
      } else if (msgId === currentMsgId) {
        currentParts.push(msg);
      } else {
        finalizeParts();
        currentMsgId = msgId;
        currentParts = [msg];
      }
    }

    idx++;
  }

  // Process final turn
  finalizeTurn(messages.length);

  return { turns, consumed: lastCompleteTurnEnd };
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

export function matchToolResults(
  toolUseBlocks: ToolUseBlock[],
  toolResults: Message[],
): ToolCall[] {
  return toolUseBlocks.map((block) => {
    const match = toolResults
      .filter((tr) => Array.isArray(getContent(tr)))
      .find((tr) =>
        (getContent(tr) as unknown[]).some(
          (item) => isToolResultBlock(item) && item.tool_use_id === block.id,
        ),
      );

    const matchedItem = match
      ? (getContent(match) as unknown[]).find(
          (item): item is ToolResultBlock =>
            isToolResultBlock(item) && item.tool_use_id === block.id,
        )
      : undefined;

    return {
      id: block.id,
      name: block.name,
      input: block.input,
      output: matchedItem?.content ?? null,
      timestamp: match ? getTimestamp(match) : undefined,
    };
  });
}
