import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `cc-langfuse-fs-test-${Date.now()}`);

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => testDir };
});

const { findLatestTranscript } = await import("../src/filesystem.js");

function createProjectDir(name: string): string {
  const dir = join(testDir, ".claude", "projects", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createTranscript(
  projectName: string,
  fileName: string,
  lines: object[],
  mtime?: Date,
): string {
  const dir = createProjectDir(projectName);
  const filePath = join(dir, fileName);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"));
  if (mtime) {
    utimesSync(filePath, mtime, mtime);
  }
  return filePath;
}

describe("findLatestTranscript", () => {
  beforeEach(() => {
    mkdirSync(join(testDir, ".claude", "state"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("returns null when projects directory does not exist", () => {
    // testDir exists but .claude/projects does not
    const result = findLatestTranscript();
    expect(result).toBeNull();
  });

  it("returns null when no .jsonl files exist", () => {
    createProjectDir("empty-project");
    const result = findLatestTranscript();
    expect(result).toBeNull();
  });

  it("finds the latest .jsonl file across multiple projects", () => {
    const older = new Date("2025-01-01T00:00:00Z");
    const newer = new Date("2025-06-01T00:00:00Z");

    createTranscript(
      "project-a",
      "old-session.jsonl",
      [{ sessionId: "old-sess", type: "user", content: "hello" }],
      older,
    );
    createTranscript(
      "project-b",
      "new-session.jsonl",
      [{ sessionId: "new-sess", type: "user", content: "hello" }],
      newer,
    );

    const result = findLatestTranscript();
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("new-sess");
    expect(result!.filePath).toContain("new-session.jsonl");
  });

  it("uses sessionId from first line JSON when available", () => {
    createTranscript("project-a", "abc-123.jsonl", [
      { sessionId: "my-session-id", type: "user", content: "hello" },
    ]);

    const result = findLatestTranscript();
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("my-session-id");
  });

  it("falls back to filename when sessionId is absent in first line", () => {
    createTranscript("project-a", "fallback-name.jsonl", [
      { type: "user", content: "hello" },
    ]);

    const result = findLatestTranscript();
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("fallback-name");
  });

  it("returns null when first line JSON is malformed", () => {
    const dir = createProjectDir("project-a");
    const filePath = join(dir, "bad.jsonl");
    writeFileSync(filePath, "this is not json\n");

    const result = findLatestTranscript();
    expect(result).toBeNull();
  });

  it("ignores non-.jsonl files", () => {
    const dir = createProjectDir("project-a");
    writeFileSync(join(dir, "notes.txt"), "not a transcript");
    writeFileSync(join(dir, "data.json"), '{"key":"value"}');

    const result = findLatestTranscript();
    expect(result).toBeNull();
  });

  it("ignores non-directory entries in projects dir", () => {
    const projectsDir = join(testDir, ".claude", "projects");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, "not-a-dir"), "file content");

    createTranscript("real-project", "session.jsonl", [
      { sessionId: "sess1", type: "user", content: "hello" },
    ]);

    const result = findLatestTranscript();
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess1");
  });
});
