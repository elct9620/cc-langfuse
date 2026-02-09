import { startObservation } from "@langfuse/tracing";
import type { LangfuseObservation } from "@langfuse/tracing";
import { debug } from "./logger.js";
import {
  getTextContent,
  getTimestamp,
  getToolCalls,
  getUsage,
} from "./content.js";
import { matchToolResults } from "./parser.js";
import type { Turn, Message } from "./types.js";

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
  let nextStart = genStart;
  for (const toolCall of toolCalls) {
    const tool = startObservation(
      toolCall.name,
      {
        input: toolCall.input,
        metadata: {
          tool_name: toolCall.name,
          tool_id: toolCall.id,
        },
      },
      {
        asType: "tool",
        ...childObservationOptions(parentObservation, nextStart),
      },
    );
    tool.update({ output: toolCall.output }).end(toolCall.timestamp);
    nextStart = toolCall.timestamp ?? nextStart;
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
  const lastAssistantText = getTextContent(
    turn.assistants[turn.assistants.length - 1],
  );
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

export function createTrace(
  sessionId: string,
  turnNum: number,
  turn: Turn,
): void {
  const { userText, lastAssistantText, model, traceStart, traceEnd } =
    computeTraceContext(turn);

  // Use startObservation (not startActiveObservation) to avoid depending on
  // OTel active span context, which breaks in cross-session recovery.
  const span = startObservation(
    `Turn ${turnNum}`,
    {},
    traceStart ? { startTime: traceStart } : undefined,
  );

  // Set trace-level attributes via the observation's updateTrace method.
  // This replaces updateActiveTrace() which silently skips when getActiveSpan() is null.
  span.updateTrace({
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

  // Use global startObservation() with explicit parentSpanContext.
  // Cannot use span.startObservation() instance method because it drops
  // startTime from options (SDK bug, see commit 167cde4).
  const rootSpan = startObservation(
    `Turn ${turnNum}`,
    {
      input: { role: "user", content: userText },
      output: { role: "assistant", content: lastAssistantText },
    },
    {
      asType: "agent",
      ...childObservationOptions(span, traceStart),
    },
  );

  createGenerations(rootSpan, turn, model, userText);

  rootSpan.end(traceEnd);
  span.end(traceEnd);

  debug(`Created trace for turn ${turnNum}`);
}
