// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = Record<string, any>;

export interface Turn {
  user: Message;
  assistants: Message[];
  toolResults: Message[];
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
  return content.some(
    (item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      (item as Message).type === "tool_result",
  );
}

export function getToolCalls(msg: Message): Message[] {
  const content = getContent(msg);
  if (!Array.isArray(content)) return [];
  return content.filter(
    (item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      (item as Message).type === "tool_use",
  );
}

export function getTextContent(msg: Message): string {
  const content = getContent(msg);
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "object" && item !== null && item.type === "text") {
      parts.push(item.text ?? "");
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
