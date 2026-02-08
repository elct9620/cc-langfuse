import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_FILE, debug } from "./logger.js";
import type { Message } from "./types.js";

export interface SessionState {
  last_line: number;
  turn_count: number;
  updated: string;
}

export type State = Record<string, SessionState>;

/**
 * Loads persisted session state from disk.
 *
 * Returns empty state on any failure (missing file, corrupt JSON, permission
 * errors) — this is intentional graceful degradation so the hook can always
 * proceed by reprocessing from scratch rather than crashing.
 */
export function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch (e) {
    debug(`Failed to load state: ${e}`);
    return {};
  }
}

export function saveState(state: State): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export interface PreviousSession {
  sessionId: string;
  transcriptPath: string;
}

export function findPreviousSession(
  transcriptPath: string,
  currentSessionId: string,
): PreviousSession | null {
  try {
    const content = readFileSync(transcriptPath, "utf8");
    const firstNewline = content.indexOf("\n");
    const firstLine =
      firstNewline === -1 ? content : content.slice(0, firstNewline);
    if (!firstLine) return null;

    const parsed = JSON.parse(firstLine);
    const sessionId = parsed.sessionId;

    if (typeof sessionId !== "string") return null;
    if (sessionId === currentSessionId) return null;

    const previousPath = join(dirname(transcriptPath), `${sessionId}.jsonl`);
    if (!existsSync(previousPath)) return null;

    return { sessionId, transcriptPath: previousPath };
  } catch {
    debug("Failed to detect previous session from transcript first line");
    return null;
  }
}

export function parseNewMessages(
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

export function countTotalLines(filePath: string): number {
  try {
    return readFileSync(filePath, "utf8").trim().split("\n").length;
  } catch {
    return 0;
  }
}

export function mergeTranscriptMessages(
  prevFile: string,
  prevLastLine: number,
  currentFile: string,
  currentLastLine: number,
): {
  messages: Message[];
  prevCount: number;
  currentLineOffsets: number[];
} | null {
  const prev = parseNewMessages(prevFile, prevLastLine);
  const current = parseNewMessages(currentFile, currentLastLine);

  const prevMessages = prev?.messages ?? [];
  const currentMessages = current?.messages ?? [];

  if (prevMessages.length === 0 && currentMessages.length === 0) return null;

  return {
    messages: [...prevMessages, ...currentMessages],
    prevCount: prevMessages.length,
    currentLineOffsets: current?.lineOffsets ?? [],
  };
}
