import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { debug } from "./logger.js";
import type { Message } from "./types.js";

const STATE_FILE = join(
  homedir(),
  ".claude",
  "state",
  "cc-langfuse_state.json",
);

export interface SessionState {
  last_line: number;
  turn_count: number;
  updated: string;
}

export type State = Record<string, SessionState>;

function isValidState(data: unknown): data is State {
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return false;
  for (const v of Object.values(data)) {
    if (
      typeof v !== "object" ||
      v === null ||
      typeof (v as SessionState).last_line !== "number" ||
      typeof (v as SessionState).turn_count !== "number"
    )
      return false;
  }
  return true;
}

/**
 * Loads persisted session state from disk.
 *
 * Returns empty state on any failure (missing file, corrupt JSON, permission
 * errors, invalid shape) — this is intentional graceful degradation so the
 * hook can always proceed by reprocessing from scratch rather than crashing.
 */
export function loadState(): State {
  try {
    const data: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!isValidState(data)) {
      debug("State file has invalid shape, resetting to empty state");
      return {};
    }
    return data;
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
  const raw = readFileSync(transcriptFile, "utf8").trim();
  if (!raw) return null;

  const lines = raw.split("\n").slice(lastLine);
  if (lines.length === 0) {
    debug(`No new lines to process (last: ${lastLine})`);
    return null;
  }

  const messages: Message[] = [];
  const lineOffsets: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      messages.push(JSON.parse(lines[i]));
      lineOffsets.push(lastLine + i + 1);
    } catch (e) {
      debug(`Skipping line ${lastLine + i}: ${e}`);
      continue;
    }
  }

  return messages.length > 0 ? { messages, lineOffsets } : null;
}
