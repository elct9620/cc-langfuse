// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = Record<string, any>;

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

export function groupTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];

  let currentUser: Message | null = null;
  let currentAssistants: Message[] = [];
  let currentParts: Message[] = [];
  let currentMsgId: string | null = null;
  let currentToolResults: Message[] = [];

  function finalizeParts(): void {
    if (currentMsgId !== null && currentParts.length > 0) {
      currentAssistants.push(mergeAssistantParts(currentParts));
      currentParts = [];
      currentMsgId = null;
    }
  }

  function finalizeTurn(): void {
    finalizeParts();
    if (currentUser !== null && currentAssistants.length > 0) {
      turns.push({
        user: currentUser,
        assistants: currentAssistants,
        toolResults: currentToolResults,
      });
    }
  }

  for (const msg of messages) {
    const role =
      msg.type ?? (msg.message as Message | undefined)?.role ?? undefined;

    if (role === "user") {
      if (isToolResult(msg)) {
        currentToolResults.push(msg);
        continue;
      }

      // New user message — finalize previous turn
      finalizeTurn();

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
  }

  // Process final turn
  finalizeTurn();

  return turns;
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
