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

class TurnBuilder {
  private turns: Turn[] = [];
  private currentUser: Message | null = null;
  private currentAssistants: Message[] = [];
  private currentParts: Message[] = [];
  private currentMsgId: string | null = null;
  private currentToolResults: Message[] = [];
  private lastCompleteTurnEnd = 0;

  build(messages: Message[]): GroupTurnsResult {
    let idx = 0;
    for (const msg of messages) {
      if (msg.isMeta === true) {
        idx++;
        continue;
      }

      const role =
        msg.type ?? (msg.message as Message | undefined)?.role ?? undefined;

      if (role === "user") {
        this.handleUser(msg, idx);
      } else if (role === "assistant") {
        this.handleAssistant(msg);
      }

      idx++;
    }

    this.finalizeTurn(messages.length);
    return { turns: this.turns, consumed: this.lastCompleteTurnEnd };
  }

  private handleUser(msg: Message, idx: number): void {
    if (isToolResult(msg)) {
      this.currentToolResults.push(msg);
      return;
    }

    this.finalizeTurn(idx);

    this.currentUser = msg;
    this.currentAssistants = [];
    this.currentParts = [];
    this.currentMsgId = null;
    this.currentToolResults = [];
  }

  private handleAssistant(msg: Message): void {
    const msgId: string | undefined = msg.message?.id;

    if (!msgId) {
      this.currentParts.push(msg);
    } else if (msgId === this.currentMsgId) {
      this.currentParts.push(msg);
    } else {
      this.finalizeParts();
      this.currentMsgId = msgId;
      this.currentParts = [msg];
    }
  }

  private finalizeParts(): void {
    if (this.currentMsgId !== null && this.currentParts.length > 0) {
      this.currentAssistants.push(mergeAssistantParts(this.currentParts));
      this.currentParts = [];
      this.currentMsgId = null;
    }
  }

  private finalizeTurn(nextIdx: number): void {
    this.finalizeParts();
    if (this.currentUser !== null && this.currentAssistants.length > 0) {
      this.turns.push({
        user: this.currentUser,
        assistants: this.currentAssistants,
        toolResults: this.currentToolResults,
      });
      this.lastCompleteTurnEnd = nextIdx;
    }
  }
}

export function groupTurns(messages: Message[]): GroupTurnsResult {
  return new TurnBuilder().build(messages);
}

function findToolResultBlock(
  toolResults: Message[],
  toolUseId: string,
): { block: ToolResultBlock; message: Message } | undefined {
  for (const msg of toolResults) {
    const content = getContent(msg);
    if (!Array.isArray(content)) continue;
    const block = content.find(
      (item): item is ToolResultBlock =>
        isToolResultBlock(item) && item.tool_use_id === toolUseId,
    );
    if (block) return { block, message: msg };
  }
  return undefined;
}

export function matchToolResults(
  toolUseBlocks: ToolUseBlock[],
  toolResults: Message[],
): ToolCall[] {
  return toolUseBlocks.map((block) => {
    const match = findToolResultBlock(toolResults, block.id);

    return {
      id: block.id,
      name: block.name,
      input: block.input,
      output: match?.block.content ?? null,
      timestamp: match ? getTimestamp(match.message) : undefined,
    };
  });
}
