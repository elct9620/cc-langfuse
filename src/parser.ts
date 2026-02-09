import type {
  ContentBlock,
  Message,
  ToolUseBlock,
  ToolResultBlock,
  ToolCall,
  Turn,
  GroupTurnsResult,
} from "./types.js";

import {
  getContent,
  getTimestamp,
  isToolResult,
  isToolResultBlock,
} from "./content.js";

export function mergeAssistantParts(parts: Message[]): Message {
  const mergedContent: ContentBlock[] = [];
  for (const part of parts) {
    const content = getContent(part);
    if (Array.isArray(content)) {
      mergedContent.push(...content);
    } else if (content !== undefined) {
      mergedContent.push({ type: "text", text: String(content) });
    }
  }

  const result = { ...parts[0] };
  if (result.message) {
    result.message = { ...result.message, content: mergedContent };
    const lastPart = parts[parts.length - 1];
    if (lastPart.message?.usage) {
      result.message.usage = lastPart.message.usage;
    }
  } else {
    result.content = mergedContent;
  }
  return result;
}

class AssistantPartAccumulator {
  private parts: Message[] = [];
  private msgId: string | null = null;

  add(msg: Message): Message | undefined {
    const id: string | undefined = msg.message?.id;

    if (!id || id === this.msgId) {
      this.parts.push(msg);
      return undefined;
    }

    const flushed = this.flush();
    this.msgId = id;
    this.parts = [msg];
    return flushed;
  }

  flush(): Message | undefined {
    if (this.msgId === null || this.parts.length === 0) return undefined;
    const merged = mergeAssistantParts(this.parts);
    this.parts = [];
    this.msgId = null;
    return merged;
  }
}

class TurnBuilder {
  private turns: Turn[] = [];
  private currentUser: Message | null = null;
  private currentAssistants: Message[] = [];
  private accumulator = new AssistantPartAccumulator();
  private currentToolResults: Message[] = [];
  private lastCompleteTurnEnd = 0;

  build(messages: Message[]): GroupTurnsResult {
    let idx = 0;
    for (const msg of messages) {
      if (msg.isMeta === true) {
        idx++;
        continue;
      }

      const role = msg.type ?? msg.message?.role;

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
    this.accumulator = new AssistantPartAccumulator();
    this.currentToolResults = [];
  }

  private handleAssistant(msg: Message): void {
    const merged = this.accumulator.add(msg);
    if (merged) this.currentAssistants.push(merged);
  }

  private finalizeTurn(nextIdx: number): void {
    const remaining = this.accumulator.flush();
    if (remaining) this.currentAssistants.push(remaining);

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
