import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { STATE_FILE, debug } from "./logger.js";

export interface SessionState {
  last_line: number;
  turn_count: number;
  updated: string;
}

export type State = Record<string, SessionState>;

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

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeStat(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function extractSessionId(filePath: string): {
  sessionId: string;
  filePath: string;
} | null {
  try {
    const firstLine = readFileSync(filePath, "utf8").split("\n")[0];
    const firstMsg = JSON.parse(firstLine);
    const sessionId =
      firstMsg.sessionId ?? filePath.replace(/.*\//, "").replace(".jsonl", "");
    debug(`Found transcript: ${filePath}, session: ${sessionId}`);
    return { sessionId, filePath };
  } catch (e) {
    debug(`Error reading transcript ${filePath}: ${e}`);
    return null;
  }
}

export function findLatestTranscript(): {
  sessionId: string;
  filePath: string;
} | null {
  const projectsDir = join(homedir(), ".claude", "projects");

  const dirs = safeReadDir(projectsDir);
  if (dirs.length === 0) {
    debug(`Projects directory not found: ${projectsDir}`);
    return null;
  }

  let latestFile: string | null = null;
  let latestMtime = 0;

  for (const dir of dirs) {
    const projectDir = join(projectsDir, dir);
    const stat = safeStat(projectDir);
    if (!stat?.isDirectory()) continue;

    const files = safeReadDir(projectDir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(projectDir, file);
      const fileStat = safeStat(filePath);
      if (fileStat && fileStat.mtimeMs > latestMtime) {
        latestMtime = fileStat.mtimeMs;
        latestFile = filePath;
      }
    }
  }

  if (!latestFile) {
    debug("No transcript files found");
    return null;
  }

  return extractSessionId(latestFile);
}
