import {
  startActiveObservation,
  startObservation,
  updateActiveTrace,
  propagateAttributes,
} from "@langfuse/tracing";
import type { LangfuseObservation } from "@langfuse/tracing";
import { debug } from "./logger.js";
import {
  getSessionId,
  getTextContent,
  getTimestamp,
  getToolCalls,
  getUsage,
} from "./content.js";
import { matchToolResults, groupTurns } from "./parser.js";
import type { Turn, Message } from "./types.js";
import {
  parseNewMessages,
  computeUpdatedState,
  computeRecoveryState,
  mergeTranscriptMessages,
  countTotalLines,
} from "./filesystem.js";
import type { State } from "./filesystem.js";

interface GenerationContext {
  parentObservation: LangfuseObservation;
  assistant: Message;
  index: number;
  turn: Turn;
  model: string;
  userText: string;
  genEnd: Date | undefined;
}

function computeTraceEnd(messages: Message[]): Date | undefined {
  return messages.reduce<Date | undefined>((latest, msg) => {
    const ts = getTimestamp(msg);
    if (!ts) return latest;
    if (!latest || ts > latest) return ts;
    return latest;
  }, undefined);
}

function childObservationOptions(
  parent: LangfuseObservation,
  startTime?: Date,
): {
  parentSpanContext: ReturnType<LangfuseObservation["otelSpan"]["spanContext"]>;
  startTime?: Date;
} {
  return {
    ...(startTime && { startTime }),
    parentSpanContext: parent.otelSpan.spanContext(),
  };
}

function createToolObservations(
  parentObservation: LangfuseObservation,
  toolCalls: ReturnType<typeof matchToolResults>,
  genStart: Date | undefined,
): void {
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
        ...childObservationOptions(parentObservation, genStart),
      },
    );
    tool.update({ output: toolCall.output }).end(toolCall.timestamp);
    debug(`Created tool observation for: ${toolCall.name}`);
  }
}

function createGenerationObservation(ctx: GenerationContext): void {
  const { parentObservation, assistant, index, turn, model, userText, genEnd } =
    ctx;
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
      ...childObservationOptions(parentObservation, genStart),
    },
  );

  createToolObservations(generation, toolCalls, genStart);

  generation.end(genEnd);
}

function computeTraceContext(turn: Turn) {
  const userText = getTextContent(turn.user);
  const lastAssistantText =
    turn.assistants.length > 0
      ? getTextContent(turn.assistants[turn.assistants.length - 1])
      : "";
  const model = turn.assistants[0]?.message?.model ?? "claude";
  const traceStart = getTimestamp(turn.user);
  const traceEnd = computeTraceEnd([...turn.assistants, ...turn.toolResults]);

  return { userText, lastAssistantText, model, traceStart, traceEnd };
}

function createGenerations(
  parentObservation: LangfuseObservation,
  turn: Turn,
  model: string,
  userText: string,
): void {
  for (let i = 0; i < turn.assistants.length; i++) {
    const nextGenStart =
      i + 1 < turn.assistants.length
        ? getTimestamp(turn.assistants[i + 1])
        : undefined;

    createGenerationObservation({
      parentObservation,
      assistant: turn.assistants[i],
      index: i,
      turn,
      model,
      userText,
      genEnd: nextGenStart ?? new Date(),
    });
  }
}

async function createTrace(
  sessionId: string,
  turnNum: number,
  turn: Turn,
): Promise<void> {
  const { userText, lastAssistantText, model, traceStart, traceEnd } =
    computeTraceContext(turn);
  const hasTraceStart = traceStart !== undefined;

  await startActiveObservation(
    `Turn ${turnNum}`,
    async (span) => {
      updateActiveTrace({
        name: `Turn ${turnNum}`,
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
          ...childObservationOptions(
            span,
            hasTraceStart ? traceStart : undefined,
          ),
        },
      );

      createGenerations(rootSpan, turn, model, userText);

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

interface IndexedTurn {
  turn: Turn;
  index: number;
}

async function createSessionTraces(
  sessionId: string,
  turns: IndexedTurn[],
  startingTurnCount: number,
): Promise<void> {
  if (turns.length === 0) return;

  await propagateAttributes({ sessionId }, async () => {
    for (let i = 0; i < turns.length; i++) {
      await createTrace(sessionId, startingTurnCount + i + 1, turns[i].turn);
    }
  });
}

function partitionTurnsBySession(
  turns: Turn[],
  prevSessionId: string,
): { prevTurns: IndexedTurn[]; currentTurns: IndexedTurn[] } {
  const prevTurns: IndexedTurn[] = [];
  const currentTurns: IndexedTurn[] = [];

  for (let i = 0; i < turns.length; i++) {
    const sid = getSessionId(turns[i].user);
    if (sid === prevSessionId) {
      prevTurns.push({ turn: turns[i], index: i });
    } else {
      currentTurns.push({ turn: turns[i], index: i });
    }
  }

  return { prevTurns, currentTurns };
}

export async function processTranscriptWithRecovery(
  currentSessionId: string,
  currentFile: string,
  prevSessionId: string,
  prevFile: string,
  state: State,
): Promise<{ turns: number; updatedState: State }> {
  const prevState = state[prevSessionId] ?? { last_line: 0, turn_count: 0 };
  const currentState = state[currentSessionId] ?? {
    last_line: 0,
    turn_count: 0,
  };

  const merged = mergeTranscriptMessages(
    prevFile,
    prevState.last_line,
    currentFile,
    currentState.last_line,
  );
  if (!merged) return { turns: 0, updatedState: state };

  debug(
    `Merging transcripts: ${merged.prevCount} prev + ${merged.messages.length - merged.prevCount} current messages`,
  );

  const { turns, consumed } = groupTurns(merged.messages);
  if (turns.length === 0) return { turns: 0, updatedState: state };

  const { prevTurns, currentTurns } = partitionTurnsBySession(
    turns,
    prevSessionId,
  );

  await createSessionTraces(prevSessionId, prevTurns, prevState.turn_count);
  await createSessionTraces(
    currentSessionId,
    currentTurns,
    currentState.turn_count,
  );

  const prevTotalLines = countTotalLines(prevFile);
  const currentConsumed = Math.max(0, consumed - merged.prevCount);
  const currentLastLine =
    currentConsumed > 0
      ? merged.currentLineOffsets[currentConsumed - 1]
      : currentState.last_line;

  const updatedState = computeRecoveryState(
    state,
    prevSessionId,
    prevTotalLines,
    prevState.turn_count,
    prevTurns.length,
    currentSessionId,
    currentLastLine,
    currentState.turn_count,
    currentTurns.length,
  );

  return { turns: turns.length, updatedState };
}
