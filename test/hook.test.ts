import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock homedir before importing modules that use it
const testDir = join(tmpdir(), `cc-langfuse-test-${Date.now()}`);

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => testDir };
});

// Mock @langfuse/tracing
const mockObservationEnd = vi.fn();
const mockObservationUpdate = vi
  .fn()
  .mockReturnValue({ end: mockObservationEnd });
const mockStartChildObservation = vi.fn();
mockStartChildObservation.mockImplementation(() => ({
  update: mockObservationUpdate,
  end: mockObservationEnd,
  startObservation: mockStartChildObservation,
}));
const mockStartObservation = vi.fn().mockImplementation(() => ({
  end: mockObservationEnd,
  startObservation: mockStartChildObservation,
}));
const mockSpanEnd = vi.fn();
const mockStartActiveObservation = vi
  .fn()
  .mockImplementation(
    async (
      _name: string,
      callback: (span: { end: typeof mockSpanEnd }) => Promise<void>,
    ) => {
      await callback({ end: mockSpanEnd });
    },
  );
const mockUpdateActiveTrace = vi.fn();
const mockPropagateAttributes = vi
  .fn()
  .mockImplementation(async (_attrs: object, callback: () => Promise<void>) => {
    await callback();
  });

vi.mock("@langfuse/tracing", () => ({
  startActiveObservation: mockStartActiveObservation,
  startObservation: mockStartObservation,
  updateActiveTrace: mockUpdateActiveTrace,
  propagateAttributes: mockPropagateAttributes,
}));

// Mock @langfuse/otel
const mockForceFlush = vi.fn().mockResolvedValue(undefined);

vi.mock("@langfuse/otel", () => ({
  LangfuseSpanProcessor: vi.fn().mockImplementation(function () {
    return { forceFlush: mockForceFlush };
  }),
}));

// Mock @opentelemetry/sdk-node
const mockSdkStart = vi.fn();
const mockSdkShutdown = vi.fn().mockResolvedValue(undefined);

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: vi.fn().mockImplementation(function () {
    return { start: mockSdkStart, shutdown: mockSdkShutdown };
  }),
}));

// Isolate tests from host environment variables
const LANGFUSE_ENV_KEYS = [
  "TRACE_TO_LANGFUSE",
  "CC_LANGFUSE_PUBLIC_KEY",
  "CC_LANGFUSE_SECRET_KEY",
  "CC_LANGFUSE_BASE_URL",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

// Import after mocks
const { hook } = await import("../src/index.js");
const { processTranscript } = await import("../src/tracer.js");
const { loadState, saveState } = await import("../src/filesystem.js");
const { NodeSDK } = await import("@opentelemetry/sdk-node");
const { LangfuseSpanProcessor } = await import("@langfuse/otel");

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
    for (const key of LANGFUSE_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
    mkdirSync(join(testDir, ".claude", "state"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("exits silently when TRACE_TO_LANGFUSE is not set", async () => {
    await hook();
    expect(NodeSDK).not.toHaveBeenCalled();
  });

  it("exits silently when API keys are missing", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    await hook();
    expect(NodeSDK).not.toHaveBeenCalled();
  });

  it("passes credentials to LangfuseSpanProcessor", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    vi.stubEnv("CC_LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("CC_LANGFUSE_SECRET_KEY", "sk-test");
    vi.stubEnv("CC_LANGFUSE_BASE_URL", "https://langfuse.example.com");

    setupTranscript([
      { sessionId: "sess1", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ]);

    await hook();

    expect(LangfuseSpanProcessor).toHaveBeenCalledWith({
      exportMode: "immediate",
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: "https://langfuse.example.com",
    });
  });

  it("omits baseUrl when not set", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    vi.stubEnv("CC_LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("CC_LANGFUSE_SECRET_KEY", "sk-test");

    setupTranscript([
      { sessionId: "sess1", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ]);

    await hook();

    expect(LangfuseSpanProcessor).toHaveBeenCalledWith({
      exportMode: "immediate",
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: undefined,
    });
  });

  it("initializes NodeSDK and processes transcript", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    vi.stubEnv("CC_LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("CC_LANGFUSE_SECRET_KEY", "sk-test");

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

    expect(NodeSDK).toHaveBeenCalled();
    expect(mockSdkStart).toHaveBeenCalled();
    expect(mockStartActiveObservation).toHaveBeenCalledWith(
      "Turn 1",
      expect.any(Function),
      {},
    );
    expect(mockStartObservation).toHaveBeenCalledWith(
      "claude-sonnet-4-5-20250929",
      expect.objectContaining({ model: "claude-sonnet-4-5-20250929" }),
      { asType: "generation" },
    );
    expect(mockForceFlush).toHaveBeenCalled();
    expect(mockSdkShutdown).toHaveBeenCalled();
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

  it("creates traces for each turn", async () => {
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

    const state = {};
    const result = await processTranscript("sess1", filePath, state);

    expect(result.turns).toBe(2);
    expect(mockStartActiveObservation).toHaveBeenCalledTimes(2);
  });

  it("creates tool observations for tool calls", async () => {
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

    const state = {};
    await processTranscript("sess1", filePath, state);

    expect(mockStartChildObservation).toHaveBeenCalledWith(
      "Tool: Read",
      expect.objectContaining({
        input: { path: "/test" },
      }),
      { asType: "tool" },
    );
    expect(mockObservationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ output: "file data" }),
    );
  });

  it("only sets input on the first generation per turn", async () => {
    const filePath = setupTranscript([
      { sessionId: "sess1", type: "user", content: "do something" },
      {
        message: {
          id: "m1",
          role: "assistant",
          content: [
            { type: "text", text: "let me read that" },
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
          content: [{ type: "text", text: "here is the result" }],
        },
      },
    ]);

    const state = {};
    await processTranscript("sess1", filePath, state);

    // Two generations in one turn
    expect(mockStartObservation).toHaveBeenCalledTimes(2);

    // First generation should have input with user message
    expect(mockStartObservation).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({
        input: { role: "user", content: "do something" },
      }),
      { asType: "generation" },
    );

    // Second generation should NOT have input
    const secondCallArgs = mockStartObservation.mock.calls[1][1];
    expect(secondCallArgs).not.toHaveProperty("input");
  });

  it("resumes from last processed line", async () => {
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

    const state = { sess1: { last_line: 2, turn_count: 1, updated: "" } };
    const result = await processTranscript("sess1", filePath, state);

    expect(result.turns).toBe(1);
    expect(mockStartActiveObservation).toHaveBeenCalledWith(
      "Turn 2",
      expect.any(Function),
      {},
    );
  });

  it("returns updated state after processing", async () => {
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

    const state = {};
    const result = await processTranscript("sess1", filePath, state);

    expect(result.updatedState.sess1.last_line).toBe(2);
    expect(result.updatedState.sess1.turn_count).toBe(1);
  });

  it("should pass startTime to startActiveObservation for trace", async () => {
    const filePath = setupTranscript([
      {
        sessionId: "sess1",
        type: "user",
        timestamp: "2025-01-15T10:00:00Z",
        content: "hello",
      },
      {
        timestamp: "2025-01-15T10:00:05Z",
        message: {
          id: "m1",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ]);

    const state = {};
    await processTranscript("sess1", filePath, state);

    expect(mockStartActiveObservation).toHaveBeenCalledWith(
      "Turn 1",
      expect.any(Function),
      {
        startTime: new Date("2025-01-15T10:00:00Z"),
        endOnExit: false,
      },
    );
  });

  it("should pass startTime to startObservation for generation", async () => {
    const filePath = setupTranscript([
      {
        sessionId: "sess1",
        type: "user",
        timestamp: "2025-01-15T10:00:00Z",
        content: "hello",
      },
      {
        timestamp: "2025-01-15T10:00:05Z",
        message: {
          id: "m1",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ]);

    const state = {};
    await processTranscript("sess1", filePath, state);

    expect(mockStartObservation).toHaveBeenCalledWith(
      "claude",
      expect.any(Object),
      {
        asType: "generation",
        startTime: new Date("2025-01-15T10:00:05Z"),
      },
    );
  });

  it("should pass endTime to generation.end()", async () => {
    const filePath = setupTranscript([
      {
        sessionId: "sess1",
        type: "user",
        timestamp: "2025-01-15T10:00:00Z",
        content: "hello",
      },
      {
        timestamp: "2025-01-15T10:00:05Z",
        message: {
          id: "m1",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ]);

    const state = {};
    await processTranscript("sess1", filePath, state);

    // Generation end should be called with traceEnd (last message timestamp)
    expect(mockObservationEnd).toHaveBeenCalledWith(
      new Date("2025-01-15T10:00:05Z"),
    );
  });

  it("should pass startTime and endTime to tool observation", async () => {
    const filePath = setupTranscript([
      {
        sessionId: "sess1",
        type: "user",
        timestamp: "2025-01-15T10:00:00Z",
        content: "read file",
      },
      {
        timestamp: "2025-01-15T10:00:05Z",
        message: {
          id: "m1",
          role: "assistant",
          model: "claude",
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
        timestamp: "2025-01-15T10:00:10Z",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file data" },
        ],
      },
      {
        timestamp: "2025-01-15T10:00:15Z",
        message: {
          id: "m2",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "done" }],
        },
      },
    ]);

    const state = {};
    await processTranscript("sess1", filePath, state);

    // Tool should have genStart as startTime
    expect(mockStartChildObservation).toHaveBeenCalledWith(
      "Tool: Read",
      expect.objectContaining({
        input: { path: "/test" },
      }),
      {
        asType: "tool",
        startTime: new Date("2025-01-15T10:00:05Z"),
      },
    );

    // Tool end should be called with tool_result timestamp
    expect(mockObservationEnd).toHaveBeenCalledWith(
      new Date("2025-01-15T10:00:10Z"),
    );
  });

  it("should omit timing when messages lack timestamp", async () => {
    const filePath = setupTranscript([
      { sessionId: "sess1", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ]);

    const state = {};
    await processTranscript("sess1", filePath, state);

    // No startTime in options (empty object)
    expect(mockStartActiveObservation).toHaveBeenCalledWith(
      "Turn 1",
      expect.any(Function),
      {},
    );

    // No startTime in generation options
    expect(mockStartObservation).toHaveBeenCalledWith(
      "claude",
      expect.any(Object),
      { asType: "generation" },
    );

    // generation.end() called with undefined (no endTime)
    expect(mockObservationEnd).toHaveBeenCalledWith(undefined);
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
