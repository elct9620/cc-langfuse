import type {
  Message,
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

export {
  isTextBlock,
  isToolUseBlock,
  isToolResultBlock,
  getTimestamp,
  getContent,
  isToolResult,
  getToolCalls,
  getTextContent,
  getUsage,
} from "./content.js";

import {
  getContent,
  getTimestamp,
  isToolResult,
  isToolResultBlock,
} from "./content.js";

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
