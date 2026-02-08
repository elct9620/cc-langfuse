import { readFileSync } from "node:fs";
import type { Langfuse } from "langfuse";
import { debug } from "./logger.js";
import {
  getTextContent,
  getToolCalls,
  matchToolResults,
  groupTurns,
} from "./parser.js";
import type { Turn, ToolCall } from "./parser.js";
import type { State } from "./filesystem.js";

function extractTurnMetadata(turn: Turn): {
  userText: string;
  assistantText: string;
  model: string;
} {
  const userText = getTextContent(turn.user);
  const assistantText =
    turn.assistants.length > 0
      ? getTextContent(turn.assistants[turn.assistants.length - 1])
      : "";
  const model = turn.assistants[0]?.message?.model ?? "claude";
  return { userText, assistantText, model };
}

function collectToolCalls(turn: Turn): ToolCall[] {
  const toolUseBlocks = turn.assistants.flatMap(getToolCalls);
  return matchToolResults(toolUseBlocks, turn.toolResults);
}

function createTrace(
  langfuse: Langfuse,
  sessionId: string,
  turnNum: number,
  turn: Turn,
): void {
  const { userText, assistantText, model } = extractTurnMetadata(turn);
  const allToolCalls = collectToolCalls(turn);

  const trace = langfuse.trace({
    name: `Turn ${turnNum}`,
    sessionId,
    input: { role: "user", content: userText },
    output: { role: "assistant", content: assistantText },
    metadata: {
      source: "claude-code",
      turn_number: turnNum,
      session_id: sessionId,
    },
  });

  trace.generation({
    name: model,
    model,
    input: { role: "user", content: userText },
    output: { role: "assistant", content: assistantText },
    metadata: { tool_count: allToolCalls.length },
  });

  for (const toolCall of allToolCalls) {
    const span = trace.span({
      name: `Tool: ${toolCall.name}`,
      input: toolCall.input,
      metadata: {
        tool_name: toolCall.name,
        tool_id: toolCall.id,
      },
    });
    span.end({ output: toolCall.output });
    debug(`Created span for tool: ${toolCall.name}`);
  }

  debug(`Created trace for turn ${turnNum}`);
}

export function processTranscript(
  langfuse: Langfuse,
  sessionId: string,
  transcriptFile: string,
  state: State,
): { turns: number; updatedState: State } {
  const sessionState = state[sessionId] ?? { last_line: 0, turn_count: 0 };
  const lastLine = sessionState.last_line;
  const turnCount = sessionState.turn_count;

  const lines = readFileSync(transcriptFile, "utf8").trim().split("\n");
  const totalLines = lines.length;

  if (lastLine >= totalLines) {
    debug(
      `No new lines to process (last: ${lastLine}, total: ${totalLines})`,
    );
    return { turns: 0, updatedState: state };
  }

  // Parse new messages
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const newMessages: Record<string, any>[] = [];
  for (let i = lastLine; i < totalLines; i++) {
    try {
      newMessages.push(JSON.parse(lines[i]));
    } catch (e) {
      debug(`Skipping line ${i}: ${e}`);
      continue;
    }
  }

  if (newMessages.length === 0) return { turns: 0, updatedState: state };

  debug(`Processing ${newMessages.length} new messages`);

  const turns = groupTurns(newMessages);

  for (let i = 0; i < turns.length; i++) {
    createTrace(langfuse, sessionId, turnCount + i + 1, turns[i]);
  }

  const updatedState: State = {
    ...state,
    [sessionId]: {
      last_line: totalLines,
      turn_count: turnCount + turns.length,
      updated: new Date().toISOString(),
    },
  };

  return { turns: turns.length, updatedState };
}
