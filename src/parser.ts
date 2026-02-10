import type {
  ContentBlock,
  Message,
  UserMessage,
  AssistantMessage,
  ToolUseBlock,
  ToolResultBlock,
  ToolCall,
  Turn,
  GroupTurnsResult,
} from "./types.js";

import { getTimestamp, isToolResult, isToolResultBlock } from "./content.js";

export function mergeAssistantParts(
  parts: AssistantMessage[],
): AssistantMessage {
  const mergedContent: ContentBlock[] = parts.flatMap((p) => p.content);
  const lastPart = parts[parts.length - 1];
  return {
    ...parts[0],
    content: mergedContent,
    usage: lastPart.usage ?? parts[0].usage,
  };
}

class AssistantPartAccumulator {
  private parts: AssistantMessage[] = [];
  private msgId: string | null = null;

  add(msg: AssistantMessage): AssistantMessage | undefined {
    const id = msg.id;

    if (!id || id === this.msgId) {
      this.parts.push(msg);
      return undefined;
    }

    const flushed = this.flush();
    this.msgId = id;
    this.parts = [msg];
    return flushed;
  }

  flush(): AssistantMessage | undefined {
    if (this.msgId === null || this.parts.length === 0) return undefined;
    const merged = mergeAssistantParts(this.parts);
    this.parts = [];
    this.msgId = null;
    return merged;
  }
}

class TurnBuilder {
  private turns: Turn[] = [];
  private currentUser: UserMessage | null = null;
  private currentAssistants: AssistantMessage[] = [];
  private accumulator = new AssistantPartAccumulator();
  private currentToolResults: UserMessage[] = [];
  private lastCompleteTurnEnd = 0;
  private pendingDurationMs: number | undefined = undefined;

  build(messages: Message[]): GroupTurnsResult {
    let idx = 0;
    for (const msg of messages) {
      if (msg.role === "system") {
        if (msg.subtype === "turn_duration") {
          this.pendingDurationMs = msg.durationMs;
        }
        idx++;
        continue;
      }

      if (msg.role === "user") {
        this.handleUser(msg, idx);
      } else if (msg.role === "assistant") {
        this.handleAssistant(msg);
      }

      idx++;
    }

    this.finalizeTurn(messages.length);
    return { turns: this.turns, consumed: this.lastCompleteTurnEnd };
  }

  private handleUser(msg: UserMessage, idx: number): void {
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

  private handleAssistant(msg: AssistantMessage): void {
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
        durationMs: this.pendingDurationMs,
      });
      this.pendingDurationMs = undefined;
      this.lastCompleteTurnEnd = nextIdx;
    }
  }
}

export function groupTurns(messages: Message[]): GroupTurnsResult {
  return new TurnBuilder().build(messages);
}

function findToolResultBlock(
  toolResults: UserMessage[],
  toolUseId: string,
): { block: ToolResultBlock; message: UserMessage } | undefined {
  for (const msg of toolResults) {
    const block = msg.content.find(
      (item): item is ToolResultBlock =>
        isToolResultBlock(item) && item.tool_use_id === toolUseId,
    );
    if (block) return { block, message: msg };
  }
  return undefined;
}

export function matchToolResults(
  toolUseBlocks: ToolUseBlock[],
  toolResults: UserMessage[],
): ToolCall[] {
  return toolUseBlocks.map((block) => {
    const match = findToolResultBlock(toolResults, block.id);

    return {
      id: block.id,
      name: block.name,
      input: block.input,
      output: match?.block.content ?? null,
      timestamp: match ? getTimestamp(match.message) : undefined,
      is_error: match?.block.is_error ?? false,
    };
  });
}
