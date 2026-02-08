import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
