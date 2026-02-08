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
  getUsage,
} from "./content.js";
import { matchToolResults, groupTurns } from "./parser.js";
import type { Turn, Message } from "./types.js";
import type { State } from "./filesystem.js";

function computeTraceEnd(messages: Message[]): Date | undefined {
  return messages.reduce<Date | undefined>((latest, msg) => {
    const ts = getTimestamp(msg);
    if (!ts) return latest;
    if (!latest || ts > latest) return ts;
    return latest;
  }, undefined);
}

/**
 * Translates parsed message data into Langfuse generation/tool observations.
 *
 * This function intentionally couples with parser/content helpers (getTextContent,
 * getToolCalls, matchToolResults, etc.) — the tracer acts as a translation layer
 * between the parsed transcript format and the Langfuse SDK. Introducing an
 * intermediate adapter would add complexity without meaningful decoupling.
 */
function createGenerationObservation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parentObservation: any,
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
  const usageDetails = getUsage(assistant);

  // Use global startObservation() to work around SDK bug where
  // instance method drops startTime from options
  const generation = startObservation(
    assistantModel,
    {
      model: assistantModel,
      ...(index === 0 && { input: { role: "user", content: userText } }),
      output: { role: "assistant", content: assistantText },
      metadata: { tool_count: toolCalls.length },
      ...(usageDetails && { usageDetails }),
    },
    {
      asType: "generation",
      ...(genStart && { startTime: genStart }),
      parentSpanContext: parentObservation.otelSpan.spanContext(),
    },
  );

  for (const toolCall of toolCalls) {
    const tool = startObservation(
      `Tool: ${toolCall.name}`,
      {
        input: toolCall.input,
        metadata: {
          tool_name: toolCall.name,
          tool_id: toolCall.id,
        },
      },
      {
        asType: "tool",
        ...(genStart && { startTime: genStart }),
        parentSpanContext: generation.otelSpan.spanContext(),
      },
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

      // Use global startObservation() to work around SDK bug where
      // instance method drops startTime from options
      const rootSpan = startObservation(
        `Turn ${turnNum}`,
        {
          input: { role: "user", content: userText },
          output: { role: "assistant", content: lastAssistantText },
        },
        {
          asType: "agent",
          ...(hasTraceStart && { startTime: traceStart }),
          parentSpanContext: span.otelSpan.spanContext(),
        },
      );

      for (let i = 0; i < turn.assistants.length; i++) {
        const nextGenStart =
          i + 1 < turn.assistants.length
            ? getTimestamp(turn.assistants[i + 1])
            : undefined;

        createGenerationObservation(
          rootSpan,
          turn.assistants[i],
          i,
          turn,
          model,
          userText,
          nextGenStart ?? new Date(),
        );
      }

      if (traceEnd) {
        rootSpan.end(traceEnd);
        span.end(traceEnd);
      }
    },
    {
      ...(hasTraceStart && { startTime: traceStart, endOnExit: false }),
    },
  );

  debug(`Created trace for turn ${turnNum}`);
}

function parseNewMessages(
  transcriptFile: string,
  lastLine: number,
): { messages: Message[]; lineOffsets: number[] } | null {
  const lines = readFileSync(transcriptFile, "utf8").trim().split("\n");
  const totalLines = lines.length;

  if (lastLine >= totalLines) {
    debug(`No new lines to process (last: ${lastLine}, total: ${totalLines})`);
    return null;
  }

  const messages: Message[] = [];
  const lineOffsets: number[] = [];
  for (let i = lastLine; i < totalLines; i++) {
    try {
      messages.push(JSON.parse(lines[i]));
      lineOffsets.push(i + 1);
    } catch (e) {
      // Malformed JSON lines are expected in incomplete transcripts
      debug(`Skipping line ${i}: ${e}`);
      continue;
    }
  }

  return messages.length > 0 ? { messages, lineOffsets } : null;
}

function computeUpdatedState(
  state: State,
  sessionId: string,
  turnCount: number,
  newTurns: number,
  consumed: number,
  lineOffsets: number[],
  lastLine: number,
): State {
  const newLastLine = consumed > 0 ? lineOffsets[consumed - 1] : lastLine;

  return {
    ...state,
    [sessionId]: {
      last_line: newLastLine,
      turn_count: turnCount + newTurns,
      updated: new Date().toISOString(),
    },
  };
}

export async function processTranscript(
  sessionId: string,
  transcriptFile: string,
  state: State,
): Promise<{ turns: number; updatedState: State }> {
  const sessionState = state[sessionId] ?? { last_line: 0, turn_count: 0 };
  const lastLine = sessionState.last_line;
  const turnCount = sessionState.turn_count;

  const parsed = parseNewMessages(transcriptFile, lastLine);
  if (!parsed) return { turns: 0, updatedState: state };

  debug(`Processing ${parsed.messages.length} new messages`);

  const { turns, consumed } = groupTurns(parsed.messages);
  if (turns.length === 0) return { turns: 0, updatedState: state };

  await propagateAttributes({ sessionId }, async () => {
    for (let i = 0; i < turns.length; i++) {
      await createTrace(sessionId, turnCount + i + 1, turns[i]);
    }
  });

  const updatedState = computeUpdatedState(
    state,
    sessionId,
    turnCount,
    turns.length,
    consumed,
    parsed.lineOffsets,
    lastLine,
  );

  return { turns: turns.length, updatedState };
}
