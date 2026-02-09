import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `cc-langfuse-fs-test-${Date.now()}`);

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => testDir };
});

beforeEach(() => {
  mkdirSync(join(testDir, ".claude", "state"), { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

const { parseNewMessages } = await import("../src/filesystem.js");

function writeTranscript(lines: string[]): string {
  const dir = join(testDir, ".claude", "projects", "test-project");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "transcript.jsonl");
  writeFileSync(filePath, lines.join("\n"));
  return filePath;
}

describe("parseNewMessages", () => {
  it("returns all messages when lastLine is 0", () => {
    const filePath = writeTranscript([
      JSON.stringify({ type: "user", content: "hello" }),
      JSON.stringify({ type: "assistant", content: "hi" }),
    ]);

    const result = parseNewMessages(filePath, 0);

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0]).toEqual({ type: "user", content: "hello" });
    expect(result!.messages[1]).toEqual({ type: "assistant", content: "hi" });
  });

  it("returns null when lastLine >= total lines", () => {
    const filePath = writeTranscript([
      JSON.stringify({ type: "user", content: "hello" }),
      JSON.stringify({ type: "assistant", content: "hi" }),
    ]);

    expect(parseNewMessages(filePath, 2)).toBeNull();
    expect(parseNewMessages(filePath, 3)).toBeNull();
  });

  it("returns only new messages when lastLine > 0 (resume scenario)", () => {
    const filePath = writeTranscript([
      JSON.stringify({ type: "user", content: "hello" }),
      JSON.stringify({ type: "assistant", content: "hi" }),
      JSON.stringify({ type: "user", content: "bye" }),
    ]);

    const result = parseNewMessages(filePath, 2);

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0]).toEqual({ type: "user", content: "bye" });
  });

  it("returns null for empty file", () => {
    const filePath = writeTranscript([]);
    writeFileSync(filePath, "");

    expect(parseNewMessages(filePath, 0)).toBeNull();
  });

  it("skips malformed JSON lines", () => {
    const filePath = writeTranscript([
      JSON.stringify({ type: "user", content: "hello" }),
      "not valid json{{{",
      JSON.stringify({ type: "assistant", content: "hi" }),
    ]);

    const result = parseNewMessages(filePath, 0);

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0]).toEqual({ type: "user", content: "hello" });
    expect(result!.messages[1]).toEqual({ type: "assistant", content: "hi" });
  });

  it("produces correct 1-based lineOffsets", () => {
    const filePath = writeTranscript([
      JSON.stringify({ type: "user", content: "hello" }),
      JSON.stringify({ type: "assistant", content: "hi" }),
      JSON.stringify({ type: "user", content: "bye" }),
    ]);

    const result = parseNewMessages(filePath, 0);

    expect(result).not.toBeNull();
    expect(result!.lineOffsets).toEqual([1, 2, 3]);
  });

  it("produces correct lineOffsets when resuming from lastLine > 0", () => {
    const filePath = writeTranscript([
      JSON.stringify({ type: "user", content: "hello" }),
      JSON.stringify({ type: "assistant", content: "hi" }),
      JSON.stringify({ type: "user", content: "bye" }),
    ]);

    const result = parseNewMessages(filePath, 1);

    expect(result).not.toBeNull();
    expect(result!.lineOffsets).toEqual([2, 3]);
  });

  it("returns null when all new lines are malformed JSON", () => {
    const filePath = writeTranscript([
      JSON.stringify({ type: "user", content: "hello" }),
      "bad json 1",
      "bad json 2",
    ]);

    const result = parseNewMessages(filePath, 1);

    expect(result).toBeNull();
  });
});
