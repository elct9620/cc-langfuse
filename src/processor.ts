import { propagateAttributes } from "@langfuse/tracing";
import { debug } from "./logger.js";
import { groupTurns } from "./parser.js";
import { parseNewMessages } from "./filesystem.js";
import type { State } from "./filesystem.js";
import { createTrace } from "./tracer.js";

interface UpdateStateParams {
  state: State;
  sessionId: string;
  turnCount: number;
  newTurns: number;
  consumed: number;
  lineOffsets: number[];
  lastLine: number;
}

function computeUpdatedState(params: UpdateStateParams): State {
  const {
    state,
    sessionId,
    turnCount,
    newTurns,
    consumed,
    lineOffsets,
    lastLine,
  } = params;
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
      createTrace(sessionId, turnCount + i + 1, turns[i]);
    }
  });

  const updatedState = computeUpdatedState({
    state,
    sessionId,
    turnCount,
    newTurns: turns.length,
    consumed,
    lineOffsets: parsed.lineOffsets,
    lastLine,
  });

  return { turns: turns.length, updatedState };
}

export async function processTranscriptWithRecovery(
  currentSessionId: string,
  currentFile: string,
  prevSessionId: string,
  prevFile: string,
  state: State,
): Promise<{ turns: number; updatedState: State }> {
  const prevResult = await processTranscript(prevSessionId, prevFile, state);

  const currentResult = await processTranscript(
    currentSessionId,
    currentFile,
    prevResult.updatedState,
  );

  return {
    turns: prevResult.turns + currentResult.turns,
    updatedState: currentResult.updatedState,
  };
}
