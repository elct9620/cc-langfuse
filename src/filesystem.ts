import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_FILE, debug } from "./logger.js";

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
  state: State,
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
    if (state[sessionId]) return null;

    const previousPath = join(dirname(transcriptPath), `${sessionId}.jsonl`);
    if (!existsSync(previousPath)) return null;

    return { sessionId, transcriptPath: previousPath };
  } catch {
    debug("Failed to detect previous session from transcript first line");
    return null;
  }
}
