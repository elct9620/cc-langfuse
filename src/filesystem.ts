import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
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

export function findLatestTranscript(): {
  sessionId: string;
  filePath: string;
} | null {
  const projectsDir = join(homedir(), ".claude", "projects");

  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    debug(`Projects directory not found: ${projectsDir}`);
    return null;
  }

  let latestFile: string | null = null;
  let latestMtime = 0;

  for (const dir of dirs) {
    const projectDir = join(projectsDir, dir);
    let stat;
    try {
      stat = statSync(projectDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let files: string[];
    try {
      files = readdirSync(projectDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(projectDir, file);
      try {
        const mtime = statSync(filePath).mtimeMs;
        if (mtime > latestMtime) {
          latestMtime = mtime;
          latestFile = filePath;
        }
      } catch {
        continue;
      }
    }
  }

  if (!latestFile) {
    debug("No transcript files found");
    return null;
  }

  try {
    const firstLine = readFileSync(latestFile, "utf8").split("\n")[0];
    const firstMsg = JSON.parse(firstLine);
    const sessionId =
      firstMsg.sessionId ?? latestFile.replace(/.*\//, "").replace(".jsonl", "");
    debug(`Found transcript: ${latestFile}, session: ${sessionId}`);
    return { sessionId, filePath: latestFile };
  } catch (e) {
    debug(`Error reading transcript ${latestFile}: ${e}`);
    return null;
  }
}
