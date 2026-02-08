import { mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const STATE_FILE = join(
  homedir(),
  ".claude",
  "state",
  "cc-langfuse_state.json",
);
export const LOG_FILE = join(
  homedir(),
  ".claude",
  "state",
  "cc-langfuse_hook.log",
);
export const DEBUG =
  (process.env.CC_LANGFUSE_DEBUG ?? "").toLowerCase() === "true";

export function log(level: string, message: string): void {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  appendFileSync(LOG_FILE, `${timestamp} [${level}] ${message}\n`);
}

export function debug(message: string): void {
  if (DEBUG) {
    log("DEBUG", message);
  }
}
