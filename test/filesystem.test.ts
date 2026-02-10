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

const { parseNewMessages, loadState } = await import("../src/filesystem.js");

const STATE_FILE = join(testDir, ".claude", "state", "cc-langfuse_state.json");

function writeTranscript(lines: string[]): string {
  const dir = join(testDir, ".claude", "projects", "test-project");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "transcript.jsonl");
  writeFileSync(filePath, lines.join("\n"));
  return filePath;
}

describe("parseNewMessages", () => {
  it("returns all classified messages when lastLine is 0", () => {
    const filePath = writeTranscript([
      JSON.stringify({ type: "user", content: "hello" }),
      JSON.stringify({ type: "assistant", content: "hi" }),
    ]);

    const result = parseNewMessages(filePath, 0);

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );
    expect(result!.messages[1]).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      }),
    );
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
    expect(result!.messages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "bye" }],
      }),
    );
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
    expect(result!.messages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );
    expect(result!.messages[1]).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      }),
    );
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

  it("filters out meta messages", () => {
    const filePath = writeTranscript([
      JSON.stringify({ type: "user", content: "hello", isMeta: true }),
      JSON.stringify({ type: "user", content: "real question" }),
      JSON.stringify({
        message: { id: "m1", role: "assistant", content: "answer" },
      }),
    ]);

    const result = parseNewMessages(filePath, 0);

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0]).toEqual(
      expect.objectContaining({ role: "user" }),
    );
    expect(result!.messages[1]).toEqual(
      expect.objectContaining({ role: "assistant" }),
    );
    // lineOffsets skip the meta message (line 1)
    expect(result!.lineOffsets).toEqual([2, 3]);
  });
});

describe("loadState", () => {
  it("returns empty state when file does not exist", () => {
    expect(loadState()).toEqual({});
  });

  it("returns empty state when JSON is an array", () => {
    writeFileSync(STATE_FILE, "[]");
    expect(loadState()).toEqual({});
  });

  it("returns empty state when session value is missing last_line", () => {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ sess1: { turn_count: 1, updated: "" } }),
    );
    expect(loadState()).toEqual({});
  });

  it("returns empty state when session value is missing turn_count", () => {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ sess1: { last_line: 5, updated: "" } }),
    );
    expect(loadState()).toEqual({});
  });

  it("returns empty state when session value is a string", () => {
    writeFileSync(STATE_FILE, JSON.stringify({ sess1: "corrupt" }));
    expect(loadState()).toEqual({});
  });

  it("returns valid state when shape is correct", () => {
    const state = {
      sess1: { last_line: 10, turn_count: 3, updated: "2024-01-01" },
    };
    writeFileSync(STATE_FILE, JSON.stringify(state));
    expect(loadState()).toEqual(state);
  });
});
