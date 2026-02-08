import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock homedir before importing modules that use it
const testDir = join(tmpdir(), `cc-langfuse-test-${Date.now()}`);

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => testDir };
});

// Mock Langfuse
const mockGeneration = vi.fn().mockReturnValue({});
const mockSpanEnd = vi.fn().mockReturnThis();
const mockSpan = vi.fn().mockReturnValue({ end: mockSpanEnd });
const mockTrace = vi.fn().mockReturnValue({
  generation: mockGeneration,
  span: mockSpan,
});
const mockFlushAsync = vi.fn().mockResolvedValue(undefined);
const mockShutdownAsync = vi.fn().mockResolvedValue(undefined);

function createMockLangfuse() {
  return {
    trace: mockTrace,
    flushAsync: mockFlushAsync,
    shutdownAsync: mockShutdownAsync,
  };
}

vi.mock("langfuse", () => ({
  Langfuse: vi.fn().mockImplementation(function () {
    return createMockLangfuse();
  }),
}));

// Import after mocks
const { hook } = await import("../src/index.js");
const { processTranscript, loadState, saveState } = await import(
  "../src/tracer.js"
);
const { Langfuse } = await import("langfuse");

function setupTranscript(lines: object[]): string {
  const projectDir = join(testDir, ".claude", "projects", "test-project");
  mkdirSync(projectDir, { recursive: true });
  const filePath = join(projectDir, "abc-session.jsonl");
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"));
  return filePath;
}

describe("hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdirSync(join(testDir, ".claude", "state"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    delete process.env.TRACE_TO_LANGFUSE;
    delete process.env.CC_LANGFUSE_PUBLIC_KEY;
    delete process.env.CC_LANGFUSE_SECRET_KEY;
  });

  it("exits silently when TRACE_TO_LANGFUSE is not set", async () => {
    await hook();
    expect(Langfuse).not.toHaveBeenCalled();
  });

  it("exits silently when API keys are missing", async () => {
    process.env.TRACE_TO_LANGFUSE = "true";
    await hook();
    expect(Langfuse).not.toHaveBeenCalled();
  });

  it("initializes Langfuse and processes transcript", async () => {
    process.env.TRACE_TO_LANGFUSE = "true";
    process.env.CC_LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.CC_LANGFUSE_SECRET_KEY = "sk-test";

    setupTranscript([
      { sessionId: "sess1", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "hi there" }],
        },
      },
    ]);

    await hook();

    expect(Langfuse).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: "pk-test",
        secretKey: "sk-test",
      }),
    );
    expect(mockTrace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Turn 1" }),
    );
    expect(mockGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-5-20250929" }),
    );
    expect(mockFlushAsync).toHaveBeenCalled();
    expect(mockShutdownAsync).toHaveBeenCalled();
  });
});

describe("processTranscript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdirSync(join(testDir, ".claude", "state"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("creates traces for each turn", () => {
    const filePath = setupTranscript([
      { sessionId: "sess1", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "hi" }],
        },
      },
      { type: "user", content: "bye" },
      {
        message: {
          id: "m2",
          role: "assistant",
          content: [{ type: "text", text: "goodbye" }],
        },
      },
    ]);

    const langfuse = createMockLangfuse();
    const state = {};
    const turns = processTranscript(langfuse, "sess1", filePath, state);

    expect(turns).toBe(2);
    expect(mockTrace).toHaveBeenCalledTimes(2);
  });

  it("creates tool spans for tool calls", () => {
    const filePath = setupTranscript([
      { sessionId: "sess1", type: "user", content: "read a file" },
      {
        message: {
          id: "m1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Read",
              input: { path: "/test" },
            },
          ],
        },
      },
      {
        type: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file data" },
        ],
      },
      {
        message: {
          id: "m2",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      },
    ]);

    const langfuse = createMockLangfuse();
    const state = {};
    processTranscript(langfuse, "sess1", filePath, state);

    expect(mockSpan).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Tool: Read" }),
    );
    expect(mockSpanEnd).toHaveBeenCalledWith(
      expect.objectContaining({ output: "file data" }),
    );
  });

  it("resumes from last processed line", () => {
    const filePath = setupTranscript([
      { sessionId: "sess1", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        },
      },
      { type: "user", content: "bye" },
      {
        message: {
          id: "m2",
          role: "assistant",
          content: [{ type: "text", text: "goodbye" }],
        },
      },
    ]);

    const langfuse = createMockLangfuse();
    const state = { sess1: { last_line: 2, turn_count: 1, updated: "" } };
    const turns = processTranscript(langfuse, "sess1", filePath, state);

    expect(turns).toBe(1);
    expect(mockTrace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Turn 2" }),
    );
  });

  it("saves state after processing", () => {
    const filePath = setupTranscript([
      { sessionId: "sess1", type: "user", content: "hi" },
      {
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ]);

    const langfuse = createMockLangfuse();
    const state = {};
    processTranscript(langfuse, "sess1", filePath, state);

    const stateFile = join(
      testDir,
      ".claude",
      "state",
      "cc-langfuse_state.json",
    );
    const saved = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(saved.sess1.last_line).toBe(2);
    expect(saved.sess1.turn_count).toBe(1);
  });
});

describe("state management", () => {
  beforeEach(() => {
    mkdirSync(join(testDir, ".claude", "state"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("returns empty state when file does not exist", () => {
    const state = loadState();
    expect(state).toEqual({});
  });

  it("saves and loads state", () => {
    const state = {
      sess1: { last_line: 10, turn_count: 3, updated: "2024-01-01" },
    };
    saveState(state);
    const loaded = loadState();
    expect(loaded).toEqual(state);
  });
});
