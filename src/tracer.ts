import { readFileSync } from "node:fs";
import {
  startActiveObservation,
  startObservation,
  updateActiveTrace,
  propagateAttributes,
} from "@langfuse/tracing";
import { debug } from "./logger.js";
import {
  getTextContent,
  getTimestamp,
  getToolCalls,
  matchToolResults,
  groupTurns,
} from "./parser.js";
import type { Turn } from "./parser.js";
import type { State } from "./filesystem.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = Record<string, any>;

function computeTraceEnd(messages: Message[]): Date | undefined {
  return messages.reduce<Date | undefined>((latest, msg) => {
    const ts = getTimestamp(msg);
    if (!ts) return latest;
    if (!latest || ts > latest) return ts;
    return latest;
  }, undefined);
}

function createGenerationObservation(
  assistant: Message,
  index: number,
  turn: Turn,
  model: string,
  userText: string,
  genEnd: Date | undefined,
): void {
  const assistantText = getTextContent(assistant);
  const assistantModel = assistant.message?.model ?? model;
  const toolUseBlocks = getToolCalls(assistant);
  const toolCalls = matchToolResults(toolUseBlocks, turn.toolResults);

  const genStart = getTimestamp(assistant);

  const generation = startObservation(
    assistantModel,
    {
      model: assistantModel,
      ...(index === 0 && { input: { role: "user", content: userText } }),
      output: { role: "assistant", content: assistantText },
      metadata: { tool_count: toolCalls.length },
    },
    { asType: "generation", ...(genStart && { startTime: genStart }) },
  );

  for (const toolCall of toolCalls) {
    const tool = generation.startObservation(
      `Tool: ${toolCall.name}`,
      {
        input: toolCall.input,
        metadata: {
          tool_name: toolCall.name,
          tool_id: toolCall.id,
        },
      },
      { asType: "tool", ...(genStart && { startTime: genStart }) },
    );
    tool.update({ output: toolCall.output }).end(toolCall.timestamp);
    debug(`Created tool observation for: ${toolCall.name}`);
  }

  generation.end(genEnd);
}

async function createTrace(
  sessionId: string,
  turnNum: number,
  turn: Turn,
): Promise<void> {
  const userText = getTextContent(turn.user);
  const lastAssistantText =
    turn.assistants.length > 0
      ? getTextContent(turn.assistants[turn.assistants.length - 1])
      : "";
  const model = turn.assistants[0]?.message?.model ?? "claude";

  const traceStart = getTimestamp(turn.user);
  const traceEnd = computeTraceEnd([...turn.assistants, ...turn.toolResults]);
  const hasTraceStart = traceStart !== undefined;

  await startActiveObservation(
    `Turn ${turnNum}`,
    async (span) => {
      updateActiveTrace({
        sessionId,
        input: { role: "user", content: userText },
        output: { role: "assistant", content: lastAssistantText },
        metadata: {
          source: "claude-code",
          turn_number: turnNum,
          session_id: sessionId,
        },
      });

      for (let i = 0; i < turn.assistants.length; i++) {
        const nextGenStart =
          i + 1 < turn.assistants.length
            ? getTimestamp(turn.assistants[i + 1])
            : undefined;

        createGenerationObservation(
          turn.assistants[i],
          i,
          turn,
          model,
          userText,
          nextGenStart ?? traceEnd,
        );
      }

      if (traceEnd) {
        span.end(traceEnd);
      }
    },
    {
      ...(hasTraceStart && { startTime: traceStart, endOnExit: false }),
    },
  );

  debug(`Created trace for turn ${turnNum}`);
}

export async function processTranscript(
  sessionId: string,
  transcriptFile: string,
  state: State,
): Promise<{ turns: number; updatedState: State }> {
  const sessionState = state[sessionId] ?? { last_line: 0, turn_count: 0 };
  const lastLine = sessionState.last_line;
  const turnCount = sessionState.turn_count;

  const lines = readFileSync(transcriptFile, "utf8").trim().split("\n");
  const totalLines = lines.length;

  if (lastLine >= totalLines) {
    debug(`No new lines to process (last: ${lastLine}, total: ${totalLines})`);
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

  await propagateAttributes({ sessionId }, async () => {
    for (let i = 0; i < turns.length; i++) {
      await createTrace(sessionId, turnCount + i + 1, turns[i]);
    }
  });

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
