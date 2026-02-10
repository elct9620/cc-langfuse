import { vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

export function setupTranscript(testDir: string, lines: object[]): string {
  return setupTranscriptAt(testDir, "abc-session.jsonl", lines);
}

export function setupTranscriptAt(
  testDir: string,
  fileName: string,
  lines: object[],
): string {
  const projectDir = join(testDir, ".claude", "projects", "test-project");
  mkdirSync(projectDir, { recursive: true });
  const filePath = join(projectDir, fileName);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"));
  return filePath;
}

export function mockStdin(data: object): void {
  const readable = Readable.from([JSON.stringify(data)]);
  vi.spyOn(process, "stdin", "get").mockReturnValue(readable as any);
}
