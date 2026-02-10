import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

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

const mockSpanContext = {
  traceId: "mock-trace-id",
  spanId: "mock-span-id",
  traceFlags: 1,
};

// Mock for updateTrace on span observations
const mockUpdateTrace = vi.fn();

// Global startObservation mock — dispatches by asType
const mockStartObservation = vi
  .fn()
  .mockImplementation((_name, _attrs, options) => {
    const asType = options?.asType ?? "span";
    if (asType === "tool") {
      return {
        update: mockObservationUpdate,
        end: mockObservationEnd,
        otelSpan: { spanContext: () => mockSpanContext },
      };
    }
    // generation, agent, span all return the same shape (with updateTrace)
    return {
      end: mockObservationEnd,
      updateTrace: mockUpdateTrace,
      otelSpan: { spanContext: () => mockSpanContext },
    };
  });
const mockPropagateAttributes = vi
  .fn()
  .mockImplementation(async (_attrs: object, callback: () => Promise<void>) => {
    await callback();
  });

vi.mock("@langfuse/tracing", () => ({
  startObservation: mockStartObservation,
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

beforeEach(() => {
  vi.clearAllMocks();
  mkdirSync(join(testDir, ".claude", "state"), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// Import after mocks
const { hook } = await import("../src/index.js");
const { processTranscript, processTranscriptWithRecovery } =
  await import("../src/processor.js");
const { loadState, saveState, findPreviousSession } =
  await import("../src/filesystem.js");
const { NodeSDK } = await import("@opentelemetry/sdk-node");
const { LangfuseSpanProcessor } = await import("@langfuse/otel");

function setupTranscript(lines: object[]): string {
  const projectDir = join(testDir, ".claude", "projects", "test-project");
  mkdirSync(projectDir, { recursive: true });
  const filePath = join(projectDir, "abc-session.jsonl");
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"));
  return filePath;
}

function mockStdin(data: object): void {
  const readable = Readable.from([JSON.stringify(data)]);
  vi.spyOn(process, "stdin", "get").mockReturnValue(readable as any);
}

describe("hook", () => {
  beforeEach(() => {
    for (const key of LANGFUSE_ENV_KEYS) {
      vi.stubEnv(key, "");
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
    ]);
    mockStdin({ session_id: "sess1", transcript_path: filePath });

    await hook();

    expect(LangfuseSpanProcessor).toHaveBeenCalledWith({
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: "https://langfuse.example.com",
    });
  });

  it("omits baseUrl when not set", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    vi.stubEnv("CC_LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("CC_LANGFUSE_SECRET_KEY", "sk-test");

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
    ]);
    mockStdin({ session_id: "sess1", transcript_path: filePath });

    await hook();

    expect(LangfuseSpanProcessor).toHaveBeenCalledWith({
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: undefined,
    });
  });

  it("calls forceFlush even when processing throws an error", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    vi.stubEnv("CC_LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("CC_LANGFUSE_SECRET_KEY", "sk-test");

    // Provide a transcript path that doesn't exist to trigger an error
    mockStdin({
      session_id: "sess1",
      transcript_path: "/nonexistent/path.jsonl",
    });

    await hook();

    expect(mockForceFlush).toHaveBeenCalled();
    expect(mockSdkShutdown).toHaveBeenCalled();
  });

  it("initializes NodeSDK and processes transcript", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    vi.stubEnv("CC_LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("CC_LANGFUSE_SECRET_KEY", "sk-test");

    const filePath = setupTranscript([
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
    mockStdin({ session_id: "sess1", transcript_path: filePath });

    await hook();

    expect(NodeSDK).toHaveBeenCalled();
    expect(mockSdkStart).toHaveBeenCalled();
    expect(mockStartObservation).toHaveBeenCalledWith("Turn 1", {}, undefined);
    expect(mockStartObservation).toHaveBeenCalledWith(
      "claude-sonnet-4-5-20250929",
      expect.objectContaining({ model: "claude-sonnet-4-5-20250929" }),
      expect.objectContaining({ asType: "generation" }),
    );
    expect(mockForceFlush).toHaveBeenCalled();
    expect(mockSdkShutdown).toHaveBeenCalled();
  });
});

describe("processTranscript", () => {
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
    // 2 turns × (1 outer span + 1 agent + 1 generation) = 6 calls
    const spanCalls = mockStartObservation.mock.calls.filter(
      (call) => !call[2]?.asType,
    );
    expect(spanCalls).toHaveLength(2);
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

    expect(mockStartObservation).toHaveBeenCalledWith(
      "Read",
      expect.objectContaining({
        input: { path: "/test" },
      }),
      expect.objectContaining({ asType: "tool" }),
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

    // 1 outer span + 1 root span (agent) + 2 generations + 1 tool = 5 calls
    expect(mockStartObservation).toHaveBeenCalledTimes(5);

    // Filter generation calls
    const generationCalls = mockStartObservation.mock.calls.filter(
      (call) => call[2]?.asType === "generation",
    );
    expect(generationCalls).toHaveLength(2);

    // First generation should have input with user message
    expect(generationCalls[0][1]).toEqual(
      expect.objectContaining({
        input: { role: "user", content: "do something" },
      }),
    );

    // Second generation should NOT have input
    expect(generationCalls[1][1]).not.toHaveProperty("input");
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
    expect(mockStartObservation).toHaveBeenCalledWith("Turn 2", {}, undefined);
  });

  it("does not advance last_line past incomplete turns", async () => {
    const filePath = setupTranscript([
      { sessionId: "sess1", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        },
      },
      { type: "user", content: "incomplete turn without assistant" },
    ]);

    const state = {};
    const result = await processTranscript("sess1", filePath, state);

    expect(result.turns).toBe(1);
    // last_line should only cover the first complete turn (2 lines), not the trailing user message
    expect(result.updatedState.sess1.last_line).toBe(2);
  });

  it("reprocesses incomplete turn on next invocation", async () => {
    const filePath = setupTranscript([
      { sessionId: "sess1", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        },
      },
      { type: "user", content: "second question" },
    ]);

    // First invocation: processes turn 1, leaves "second question" incomplete
    const state = {};
    const result1 = await processTranscript("sess1", filePath, state);
    expect(result1.turns).toBe(1);
    expect(result1.updatedState.sess1.last_line).toBe(2);

    // Simulate appending an assistant reply to complete the second turn
    const { writeFileSync: writeFs, readFileSync: readFs } =
      await import("node:fs");
    const existing = readFs(filePath, "utf8");
    writeFs(
      filePath,
      existing +
        "\n" +
        JSON.stringify({
          message: {
            id: "m2",
            role: "assistant",
            content: [{ type: "text", text: "second reply" }],
          },
        }),
    );

    // Second invocation: should pick up the incomplete "second question" and its new reply
    const result2 = await processTranscript(
      "sess1",
      filePath,
      result1.updatedState,
    );
    expect(result2.turns).toBe(1);
    expect(result2.updatedState.sess1.turn_count).toBe(2);
    expect(result2.updatedState.sess1.last_line).toBe(4);
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

  it("should pass startTime to startObservation for outer span", async () => {
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
      "Turn 1",
      {},
      {
        startTime: new Date("2025-01-15T10:00:00Z"),
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
      expect.objectContaining({
        asType: "generation",
        startTime: new Date("2025-01-15T10:00:05Z"),
      }),
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

    // Last generation ends at current time (new Date())
    expect(mockObservationEnd).toHaveBeenCalledWith(expect.any(Date));
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

    // Single tool should use genStart as startTime (first tool in sequence)
    expect(mockStartObservation).toHaveBeenCalledWith(
      "Read",
      expect.objectContaining({
        input: { path: "/test" },
      }),
      expect.objectContaining({
        asType: "tool",
        startTime: new Date("2025-01-15T10:00:05Z"),
      }),
    );

    // Tool end should be called with tool_result timestamp
    expect(mockObservationEnd).toHaveBeenCalledWith(
      new Date("2025-01-15T10:00:10Z"),
    );
  });

  it("should use sequential startTime for multiple tool observations", async () => {
    const filePath = setupTranscript([
      {
        sessionId: "sess1",
        type: "user",
        timestamp: "2025-01-15T10:00:00Z",
        content: "read two files",
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
              input: { path: "/file1" },
            },
            {
              type: "tool_use",
              id: "t2",
              name: "Read",
              input: { path: "/file2" },
            },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2025-01-15T10:00:10Z",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "data1" },
          { type: "tool_result", tool_use_id: "t2", content: "data2" },
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

    const toolCalls = mockStartObservation.mock.calls.filter(
      (call) => call[2]?.asType === "tool",
    );
    expect(toolCalls).toHaveLength(2);

    // First tool should have genStart as startTime
    expect(toolCalls[0][2]).toEqual(
      expect.objectContaining({
        startTime: new Date("2025-01-15T10:00:05Z"),
      }),
    );

    // Second tool should have first tool's endTime (tool_result timestamp) as startTime
    expect(toolCalls[1][2]).toEqual(
      expect.objectContaining({
        startTime: new Date("2025-01-15T10:00:10Z"),
      }),
    );
  });

  it("creates root span with asType agent", async () => {
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

    expect(mockStartObservation).toHaveBeenCalledWith(
      "Turn 1",
      expect.objectContaining({
        input: { role: "user", content: "hello" },
        output: { role: "assistant", content: "hi" },
      }),
      expect.objectContaining({ asType: "agent" }),
    );
  });

  it("creates root span with timing", async () => {
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
      "Turn 1",
      expect.any(Object),
      expect.objectContaining({
        asType: "agent",
        startTime: new Date("2025-01-15T10:00:00Z"),
      }),
    );
  });

  it("includes usageDetails in generation when usage is present", async () => {
    const filePath = setupTranscript([
      { sessionId: "sess1", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "hi" }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
          },
        },
      },
    ]);

    const state = {};
    await processTranscript("sess1", filePath, state);

    expect(mockStartObservation).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        usageDetails: {
          input: 100,
          output: 50,
          total: 150,
          cache_read_input_tokens: 20,
        },
      }),
      expect.any(Object),
    );
  });

  it("omits usageDetails when usage is not present", async () => {
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

    // Find the generation call (skip root span agent call)
    const generationCall = mockStartObservation.mock.calls.find(
      (call) => call[2]?.asType === "generation",
    );
    expect(generationCall).toBeDefined();
    expect(generationCall![1]).not.toHaveProperty("usageDetails");
  });

  it("should end all spans even when messages lack timestamps", async () => {
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

    // outer span + rootSpan + generation = 3 .end() calls
    expect(mockObservationEnd).toHaveBeenCalledTimes(3);
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

    // No startTime in options (undefined)
    expect(mockStartObservation).toHaveBeenCalledWith("Turn 1", {}, undefined);

    // No startTime in generation options
    const generationCall = mockStartObservation.mock.calls.find(
      (call) => call[2]?.asType === "generation",
    );
    expect(generationCall).toBeDefined();
    expect(generationCall![2]).not.toHaveProperty("startTime");

    // Last generation ends at current time (new Date())
    expect(mockObservationEnd).toHaveBeenCalledWith(expect.any(Date));
  });
});

function setupTranscriptAt(fileName: string, lines: object[]): string {
  const projectDir = join(testDir, ".claude", "projects", "test-project");
  mkdirSync(projectDir, { recursive: true });
  const filePath = join(projectDir, fileName);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"));
  return filePath;
}

describe("findPreviousSession", () => {
  it("returns previous session when first line has different sessionId", () => {
    // Create previous session transcript
    setupTranscriptAt("prev-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ]);

    // Current transcript starts with previous session's last message
    const currentPath = setupTranscriptAt("current-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "plan mode msg" },
      { sessionId: "current-session", type: "user", content: "hello" },
      {
        message: {
          id: "m2",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ]);

    const result = findPreviousSession(currentPath, "current-session");
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("prev-session");
    expect(result!.transcriptPath).toContain("prev-session.jsonl");
  });

  it("returns null when first line sessionId matches current session", () => {
    const filePath = setupTranscriptAt("sess1.jsonl", [
      { sessionId: "sess1", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ]);

    const result = findPreviousSession(filePath, "sess1");
    expect(result).toBeNull();
  });

  it("returns null when first line has no sessionId (file-history-snapshot)", () => {
    const filePath = setupTranscriptAt("sess1.jsonl", [
      { type: "file-history-snapshot", messageId: "m0", snapshot: {} },
      { sessionId: "sess1", type: "user", content: "hello" },
    ]);

    const result = findPreviousSession(filePath, "sess1");
    expect(result).toBeNull();
  });

  it("returns previous session even when previous sessionId already in state", () => {
    setupTranscriptAt("prev-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "hello" },
    ]);

    const filePath = setupTranscriptAt("current.jsonl", [
      { sessionId: "prev-session", type: "user", content: "msg" },
    ]);

    const result = findPreviousSession(filePath, "current");
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("prev-session");
  });

  it("returns null when previous session transcript file does not exist", () => {
    // Don't create the prev-session.jsonl file
    const filePath = setupTranscriptAt("current.jsonl", [
      { sessionId: "nonexistent-session", type: "user", content: "msg" },
    ]);

    const result = findPreviousSession(filePath, "current");
    expect(result).toBeNull();
  });
});

describe("orphan session recovery", () => {
  beforeEach(() => {
    for (const key of LANGFUSE_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  it("recovers previous session before processing current session", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    vi.stubEnv("CC_LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("CC_LANGFUSE_SECRET_KEY", "sk-test");

    // Previous session transcript
    setupTranscriptAt("prev-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "prev hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "prev hi" }],
        },
      },
    ]);

    // Current transcript starts with prev session's message
    const currentPath = setupTranscriptAt("current-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "leftover" },
      { sessionId: "current-session", type: "user", content: "current hello" },
      {
        message: {
          id: "m2",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "current hi" }],
        },
      },
    ]);

    mockStdin({
      session_id: "current-session",
      transcript_path: currentPath,
    });

    await hook();

    // Should have processed both sessions (2 turns total: 1 prev + 1 current)
    // Each turn creates: 1 outer span + 1 agent + 1 generation = 3 calls
    const spanCalls = mockStartObservation.mock.calls.filter(
      (call) => !call[2]?.asType,
    );
    expect(spanCalls).toHaveLength(2);
    expect(mockStartObservation).toHaveBeenCalledWith("Turn 1", {}, undefined);
  });

  it("continues processing current session when previous session recovery fails", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    vi.stubEnv("CC_LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("CC_LANGFUSE_SECRET_KEY", "sk-test");

    // Previous session transcript with invalid content (will cause processTranscript to have 0 turns)
    setupTranscriptAt("prev-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "orphaned" },
      // No assistant response — incomplete turn, 0 turns processed
    ]);

    // Current transcript
    const currentPath = setupTranscriptAt("current-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "leftover" },
      { sessionId: "current-session", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ]);

    mockStdin({
      session_id: "current-session",
      transcript_path: currentPath,
    });

    await hook();

    // Current session should still be processed (1 turn)
    expect(mockStartObservation).toHaveBeenCalledWith("Turn 1", {}, undefined);
    expect(mockSdkShutdown).toHaveBeenCalled();
  });
});

describe("state management", () => {
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

describe("processTranscriptWithRecovery", () => {
  it("attributes orphaned prev user + current assistant to current session", async () => {
    // Previous session: user message only (no assistant reply)
    const prevPath = setupTranscriptAt("prev-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "hello from prev" },
    ]);

    // Current session: prev user leftover, then assistant reply
    const currentPath = setupTranscriptAt("current-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "hello from prev" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "reply to prev" }],
        },
      },
    ]);

    const state = {};
    const result = await processTranscriptWithRecovery(
      "current-session",
      currentPath,
      "prev-session",
      prevPath,
      state,
    );

    // Prev session has no complete turns (user only, no assistant)
    // Current session picks up orphaned prev user + assistant as 1 turn
    expect(result.turns).toBe(1);
    // 1 turn × (1 outer span + 1 agent + 1 generation) = 3 calls
    expect(mockStartObservation).toHaveBeenCalledTimes(3);
    expect(mockPropagateAttributes).toHaveBeenCalledWith(
      { sessionId: "current-session" },
      expect.any(Function),
    );
    expect(result.updatedState["current-session"].turn_count).toBe(1);
  });

  it("processes each session independently via sequential processTranscript calls", async () => {
    const prevPath = setupTranscriptAt("prev-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "prev question" },
    ]);

    const currentPath = setupTranscriptAt("current-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "prev question" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "prev answer" }],
        },
      },
      {
        sessionId: "current-session",
        type: "user",
        content: "current question",
      },
      {
        message: {
          id: "m2",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "current answer" }],
        },
      },
    ]);

    const state = {};
    const result = await processTranscriptWithRecovery(
      "current-session",
      currentPath,
      "prev-session",
      prevPath,
      state,
    );

    // Prev has no complete turns (user only, no assistant)
    // Current has 2 turns: orphaned prev user + assistant, then current user + assistant
    expect(result.turns).toBe(2);
    // Only current session should have propagateAttributes called
    expect(mockPropagateAttributes).toHaveBeenCalledWith(
      { sessionId: "current-session" },
      expect.any(Function),
    );
    expect(result.updatedState["current-session"].turn_count).toBe(2);
  });

  it("attributes cross-session turn to current session when prev is fully processed", async () => {
    // Previous session: fully processed (1 complete turn = 2 lines)
    const prevPath = setupTranscriptAt("prev-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "prev hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "prev reply" }],
        },
      },
    ]);

    // Current transcript: user from prev session + assistant from current session
    const currentPath = setupTranscriptAt("current-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "cross-session msg" },
      {
        message: {
          id: "m2",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "cross-session reply" }],
        },
      },
    ]);

    // Previous session already fully processed in state
    const state = {
      "prev-session": { last_line: 2, turn_count: 1, updated: "" },
    };

    const result = await processTranscriptWithRecovery(
      "current-session",
      currentPath,
      "prev-session",
      prevPath,
      state,
    );

    // Cross-session turn is attributed to current session (processed independently)
    expect(mockPropagateAttributes).toHaveBeenCalledWith(
      { sessionId: "current-session" },
      expect.any(Function),
    );
    // Current session gets the turn
    expect(result.updatedState["current-session"].turn_count).toBe(1);
    // Previous session unchanged
    expect(result.updatedState["prev-session"].turn_count).toBe(1);
  });

  it("creates traces under both sessions when prev is fully processed and current has turns", async () => {
    // Previous session: 1 complete turn, fully processed in state
    const prevPath = setupTranscriptAt("prev-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "prev hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "prev reply" }],
        },
      },
    ]);

    // Current transcript: line 0 = orphaned prev user, line 1 = current user, line 2 = current assistant
    const currentPath = setupTranscriptAt("current-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "orphaned msg" },
      {
        sessionId: "current-session",
        type: "user",
        content: "current hello",
      },
      {
        message: {
          id: "m2",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "current reply" }],
        },
      },
    ]);

    // Previous session already fully processed
    const state = {
      "prev-session": { last_line: 2, turn_count: 1, updated: "" },
    };

    const result = await processTranscriptWithRecovery(
      "current-session",
      currentPath,
      "prev-session",
      prevPath,
      state,
    );

    // propagateAttributes must be called with the current session ID
    expect(mockPropagateAttributes).toHaveBeenCalledWith(
      { sessionId: "current-session" },
      expect.any(Function),
    );
    // Current session should have 1 turn
    expect(result.updatedState["current-session"].turn_count).toBe(1);
    // Total turns should be 1 (only current session has new turns)
    expect(result.turns).toBe(1);
  });

  it("returns zero turns when both transcripts are empty", async () => {
    const prevPath = setupTranscriptAt("prev-session.jsonl", [
      { sessionId: "prev-session", isMeta: true },
    ]);

    const currentPath = setupTranscriptAt("current-session.jsonl", [
      { sessionId: "prev-session", isMeta: true },
    ]);

    const state = {
      "prev-session": { last_line: 1, turn_count: 0, updated: "" },
      "current-session": { last_line: 1, turn_count: 0, updated: "" },
    };

    const result = await processTranscriptWithRecovery(
      "current-session",
      currentPath,
      "prev-session",
      prevPath,
      state,
    );

    expect(result.turns).toBe(0);
  });
});

describe("turn durationMs endTime", () => {
  it("uses startTime + durationMs as endTime when both are available", async () => {
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
      { type: "system", subtype: "turn_duration", durationMs: 3000 },
    ]);

    const state = {};
    await processTranscript("sess1", filePath, state);

    // endTime = startTime (10:00:00) + 3000ms = 10:00:03
    const expectedEnd = new Date("2025-01-15T10:00:03Z");
    // outer span and rootSpan should end at computed time
    expect(mockObservationEnd).toHaveBeenCalledWith(expectedEnd);
  });

  it("falls back to message timestamps when durationMs is not available", async () => {
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

    // Should use computeTraceEnd fallback (latest message timestamp = 10:00:05)
    expect(mockObservationEnd).toHaveBeenCalledWith(
      new Date("2025-01-15T10:00:05Z"),
    );
  });
});

describe("session metadata in trace", () => {
  it("includes session metadata in updateTrace call", async () => {
    const filePath = setupTranscript([
      {
        sessionId: "sess1",
        type: "user",
        content: "hello",
        version: "1.0.32",
        slug: "my-project",
        cwd: "/home/user/project",
        gitBranch: "main",
      },
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

    expect(mockUpdateTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          version: "1.0.32",
          slug: "my-project",
          cwd: "/home/user/project",
          git_branch: "main",
        }),
      }),
    );
  });

  it("omits session metadata fields when not present", async () => {
    const filePath = setupTranscript([
      {
        sessionId: "sess1",
        type: "user",
        content: "hello",
      },
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

    expect(mockUpdateTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({
          version: expect.anything(),
        }),
      }),
    );
  });
});

describe("updateTrace name", () => {
  it("includes name in updateTrace call", async () => {
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

    expect(mockUpdateTrace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Turn 1" }),
    );
  });

  it("includes correct turn number in name for second turn", async () => {
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
      { type: "user", content: "bye" },
      {
        message: {
          id: "m2",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "goodbye" }],
        },
      },
    ]);

    const state = {};
    await processTranscript("sess1", filePath, state);

    expect(mockUpdateTrace).toHaveBeenCalledTimes(2);
    expect(mockUpdateTrace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Turn 1" }),
    );
    expect(mockUpdateTrace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Turn 2" }),
    );
  });
});
