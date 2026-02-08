import { propagateAttributes } from "@langfuse/tracing";
import { debug } from "./logger.js";
import { getSessionId } from "./content.js";
import { groupTurns } from "./parser.js";
import type { Turn } from "./types.js";
import {
  parseNewMessages,
  computeUpdatedState,
  computeRecoveryState,
  mergeTranscriptMessages,
  countTotalLines,
} from "./filesystem.js";
import type { State } from "./filesystem.js";
import { createTrace } from "./tracer.js";

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
